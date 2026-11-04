/** A software passkey for tests: creates and signs the way a phone's authenticator does (ES256, attestation "none"). */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest();

/** Encode the CBOR subset WebAuthn uses: integers, byte strings, text, and maps (Map or plain object). */
export function encode_cbor(value) {
  const head = (major, length) => length < 24 ? Buffer.from([(major << 5) | length])
    : length < 256 ? Buffer.from([(major << 5) | 24, length]) : Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([head(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([key, item]) => [encode_cbor(key), encode_cbor(item)])]);
}

/** One passkey bound to a relying party; `flags` can drop user verification to test refusals. */
export function software_passkey(rp_id) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y } = publicKey.export({ format: 'jwk' });
  const credential_id = randomBytes(16);
  let count = 0;
  const auth_head = (flags) => { const counter = Buffer.alloc(4); counter.writeUInt32BE(count); return Buffer.concat([sha256(rp_id), Buffer.from([flags]), counter]); };
  return {
    id: credential_id.toString('base64url'),
    /** navigator.credentials.create(): the fields the page sends. */
    create(challenge, origin, { flags = 0x45 } = {}) {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      const length = Buffer.from([credential_id.length >> 8, credential_id.length & 255]);
      const cose = encode_cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(x, 'base64url')], [-3, Buffer.from(y, 'base64url')]]));
      const auth = Buffer.concat([auth_head(flags), Buffer.alloc(16), length, credential_id, cose]);
      return { id: credential_id.toString('base64url'), client_data_json: client.toString('base64url'),
        attestation_object: encode_cbor({ fmt: 'none', attStmt: {}, authData: auth }).toString('base64url') };
    },
    /** navigator.credentials.get(): the fields the page sends; the counter grows each time. */
    get(challenge, origin, { flags = 0x05 } = {}) {
      count += 1;
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const auth = auth_head(flags);
      const signature = sign('sha256', Buffer.concat([auth, sha256(client)]), privateKey);
      return { id: credential_id.toString('base64url'), client_data_json: client.toString('base64url'),
        authenticator_data: auth.toString('base64url'), signature: signature.toString('base64url') };
    },
  };
}

/** A browser's device key: the JWK the page sends and a signer for relayed requests. */
export async function software_device() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    public_key: { kty, crv, x, y }, raw: raw.toString('base64url'), id: sha256(raw).toString('hex').slice(0, 32),
    /** The sealed plaintext of a signed request, as the page builds it. */
    async seal(id, request) {
      const body = JSON.stringify({ sent_at: Date.now(), ...request });
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${id}\n${body}`));
      return { body, device_id: this.id, signature: Buffer.from(signature).toString('base64url') };
    },
  };
}
