/**
 * Passkey (WebAuthn) checks for this computer, with Node's built-in WebCrypto only: registration yields the credential's
 * public key, and an assertion proves the user verified on the device. Only ES256 and RS256 keys are accepted, and
 * attestation is not checked (attestation "none" is requested). backend/worker.mjs carries the same checks for login.
 */
import { createHash } from 'node:crypto';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;
const ES256 = -7;
const RS256 = -257;

export const b64url = bytes => Buffer.from(bytes).toString('base64url');
export const from_b64url = text => new Uint8Array(Buffer.from(String(text || ''), 'base64url'));
const sha256 = bytes => new Uint8Array(createHash('sha256').update(bytes).digest());

/** Decode one CBOR item at `offset`; supports the subset WebAuthn uses (ints, bytes, text, arrays, maps, simple values). */
function cbor_item(bytes, offset) {
  const head = bytes[offset];
  if (head === undefined) throw new Error('CBOR 数据不完整');
  const major = head >> 5, info = head & 31;
  let length, next = offset + 1;
  if (info < 24) length = info;
  else if (info === 24) { length = bytes[next]; next += 1; }
  else if (info === 25) { length = (bytes[next] << 8) | bytes[next + 1]; next += 2; }
  else if (info === 26) { length = ((bytes[next] << 24) >>> 0) + (bytes[next + 1] << 16) + (bytes[next + 2] << 8) + bytes[next + 3]; next += 4; }
  else throw new Error('不支持的 CBOR 长度');
  if (major === 0) return [length, next];
  if (major === 1) return [-1 - length, next];
  if (major === 2 || major === 3) {
    if (next + length > bytes.length) throw new Error('CBOR 数据不完整');
    const chunk = bytes.subarray(next, next + length);
    return [major === 2 ? chunk : new TextDecoder().decode(chunk), next + length];
  }
  if (major === 4) {
    const items = [];
    for (let index = 0; index < length; index++) { const [item, after] = cbor_item(bytes, next); items.push(item); next = after; }
    return [items, next];
  }
  if (major === 5) {
    const map = new Map();
    for (let index = 0; index < length; index++) {
      const [key, after_key] = cbor_item(bytes, next);
      const [value, after_value] = cbor_item(bytes, after_key);
      map.set(key, value);
      next = after_value;
    }
    return [map, next];
  }
  if (major === 7 && [20, 21, 22].includes(info)) return [info === 21 ? true : info === 20 ? false : null, next];
  throw new Error('不支持的 CBOR 类型');
}

/** Decode a whole CBOR value; returns [value, bytes used]. */
export function decode_cbor(bytes) {
  return cbor_item(bytes, 0);
}

/** Turn a COSE public key into a JWK and its WebCrypto algorithm; anything but ES256 or RS256 is refused. */
function cose_to_jwk(cose) {
  const alg = cose.get(3);
  if (alg === ES256 && cose.get(1) === 2 && cose.get(-1) === 1) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (alg === RS256 && cose.get(1) === 3) return { alg, jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)), alg: 'RS256' } };
  throw new Error('通行密钥的算法不受支持，只接受 ES256 或 RS256');
}

/** Split authenticator data into its fields; the attested credential is present only on registration. */
function parse_auth_data(bytes) {
  if (bytes.length < 37) throw new Error('通行密钥数据不完整');
  const result = { rp_id_hash: bytes.subarray(0, 32), flags: bytes[32], sign_count: new DataView(bytes.buffer, bytes.byteOffset + 33, 4).getUint32(0) };
  if (result.flags & FLAG_ATTESTED_DATA) {
    const id_length = (bytes[53] << 8) | bytes[54];
    result.credential_id = bytes.subarray(55, 55 + id_length);
    [result.cose] = decode_cbor(bytes.subarray(55 + id_length));
  }
  return result;
}

/** Check the browser's client data: ceremony type, exact challenge and exact origin. */
function check_client_data(client_data_json, { type, challenge, origin }) {
  let data;
  try { data = JSON.parse(new TextDecoder().decode(client_data_json)); } catch { throw new Error('通行密钥数据无效'); }
  if (data.type !== type) throw new Error('通行密钥操作类型不符');
  if (data.challenge !== challenge) throw new Error('通行密钥挑战不符或已过期');
  if (data.origin !== origin) throw new Error('通行密钥来自其他网站');
}

/** Check the relying party and that the user was present and verified (fingerprint, face or device PIN). */
function check_auth_data(auth, rp_id) {
  if (Buffer.compare(Buffer.from(auth.rp_id_hash), Buffer.from(sha256(new TextEncoder().encode(rp_id)))) !== 0) throw new Error('通行密钥不属于这个网站');
  if (!(auth.flags & FLAG_USER_PRESENT) || !(auth.flags & FLAG_USER_VERIFIED)) throw new Error('需要在设备上验证身份（指纹、面容或设备密码）');
}

/**
 * Verify a new passkey from navigator.credentials.create(); `challenge` is the base64url challenge the browser signed.
 * Returns { id, public_key, alg, sign_count } to keep.
 */
export function verify_registration({ client_data_json, attestation_object }, { challenge, origin, rp_id }) {
  const client_data = from_b64url(client_data_json);
  check_client_data(client_data, { type: 'webauthn.create', challenge, origin });
  const [attestation] = decode_cbor(from_b64url(attestation_object));
  if (!(attestation instanceof Map) || !(attestation.get('authData') instanceof Uint8Array)) throw new Error('通行密钥数据无效');
  const auth = parse_auth_data(attestation.get('authData'));
  check_auth_data(auth, rp_id);
  if (!auth.credential_id || !auth.cose) throw new Error('通行密钥数据缺少公钥');
  const { alg, jwk } = cose_to_jwk(auth.cose);
  return { id: b64url(auth.credential_id), public_key: jwk, alg, sign_count: auth.sign_count };
}

/** Convert a DER ECDSA signature into the raw r‖s form WebCrypto verifies. */
function der_to_raw(der) {
  if (der[0] !== 0x30) throw new Error('通行密钥签名格式无效');
  let offset = 2;
  const part = () => {
    if (der[offset] !== 0x02) throw new Error('通行密钥签名格式无效');
    const length = der[offset + 1];
    let value = der.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw new Error('通行密钥签名格式无效');
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };
  const r = part(), s = part();
  return Uint8Array.from([...r, ...s]);
}

/**
 * Verify an assertion from navigator.credentials.get() against a kept passkey. Returns the new signature counter;
 * a counter that did not grow (when either side is non-zero) suggests a cloned authenticator and is refused.
 */
export async function verify_assertion({ client_data_json, authenticator_data, signature }, passkey, { challenge, origin, rp_id }) {
  const client_data = from_b64url(client_data_json), auth_bytes = from_b64url(authenticator_data);
  check_client_data(client_data, { type: 'webauthn.get', challenge, origin });
  const auth = parse_auth_data(auth_bytes);
  check_auth_data(auth, rp_id);
  const signed = Uint8Array.from([...auth_bytes, ...sha256(client_data)]);
  const es256 = passkey.alg === ES256;
  const algorithm = es256 ? { name: 'ECDSA', namedCurve: 'P-256' } : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const key = await crypto.subtle.importKey('jwk', passkey.public_key, algorithm, false, ['verify']);
  const raw = from_b64url(signature);
  const valid = await crypto.subtle.verify(es256 ? { name: 'ECDSA', hash: 'SHA-256' } : algorithm, key, es256 ? der_to_raw(raw) : raw, signed);
  if (!valid) throw new Error('通行密钥签名无效');
  if ((auth.sign_count || passkey.sign_count) && auth.sign_count <= passkey.sign_count) throw new Error('通行密钥计数异常，可能被复制，请撤销后重新配对');
  return auth.sign_count;
}
