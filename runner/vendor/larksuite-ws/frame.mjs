// Wire schema from larksuite/node-sdk ws-client/proto-buf/pbbp2.js (see SOURCE.md).
const WIRE_INT = 0;
const WIRE_BYTES = 2;

function varint(value) {
  value = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  while (value > 127n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  return Buffer.from([...bytes, Number(value)]);
}

function read_varint(bytes, cursor) {
  let value = 0n;
  for (let shift = 0n; shift < 64n && cursor.offset < bytes.length; shift += 7n) {
    const byte = bytes[cursor.offset++];
    if (shift === 63n && byte > 1) break;
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) return value;
  }
  throw new Error('Invalid Feishu frame varint');
}

function read_bytes(bytes, cursor, length) {
  if (length > BigInt(bytes.length - cursor.offset)) throw new Error('Truncated Feishu frame');
  const start = cursor.offset;
  cursor.offset += Number(length);
  return bytes.subarray(start, cursor.offset);
}

function* fields(bytes) {
  const cursor = { offset: 0 };
  while (cursor.offset < bytes.length) {
    const tag = Number(read_varint(bytes, cursor));
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === WIRE_INT) yield [field, read_varint(bytes, cursor)];
    else if (wire === WIRE_BYTES) yield [field, read_bytes(bytes, cursor, read_varint(bytes, cursor))];
    else if (wire === 1 || wire === 5) read_bytes(bytes, cursor, wire === 1 ? 8n : 4n);
    else throw new Error('Invalid Feishu frame wire type');
  }
}

function integer(field, value) {
  return Buffer.concat([varint(field << 3), varint(value)]);
}

function blob(field, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint((field << 3) | WIRE_BYTES), varint(bytes.length), bytes]);
}

/** Encode a Feishu WebSocket Frame, retaining full-width sequence and log IDs. */
export function encode_frame(frame) {
  const parts = [integer(1, frame.SeqID), integer(2, frame.LogID), integer(3, frame.service), integer(4, frame.method)];
  for (const { key, value } of frame.headers) parts.push(blob(5, Buffer.concat([blob(1, key), blob(2, value)])));
  for (const [field, value] of [[6, frame.payloadEncoding], [7, frame.payloadType], [8, frame.payload], [9, frame.LogIDNew]]) {
    if (value != null) parts.push(blob(field, value));
  }
  return Buffer.concat(parts);
}

/** Decode a Feishu WebSocket Frame and ignore unknown extension fields. */
export function decode_frame(input) {
  const frame = { SeqID: 0n, LogID: 0n, service: 0, method: 0, headers: [] };
  for (const [field, value] of fields(Buffer.from(input))) {
    if (field === 1) frame.SeqID = value;
    else if (field === 2) frame.LogID = value;
    else if (field === 3) frame.service = Number(BigInt.asIntN(32, value));
    else if (field === 4) frame.method = Number(BigInt.asIntN(32, value));
    else if (field === 5) {
      const header = Object.fromEntries(fields(value));
      frame.headers.push({ key: header[1].toString(), value: header[2].toString() });
    } else if (field === 6) frame.payloadEncoding = value.toString();
    else if (field === 7) frame.payloadType = value.toString();
    else if (field === 8) frame.payload = value;
    else if (field === 9) frame.LogIDNew = value.toString();
  }
  return frame;
}
