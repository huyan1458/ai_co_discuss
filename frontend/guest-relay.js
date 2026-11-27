/** Browser transport for one guest visit. IndexedDB retains the non-exportable key for the lifetime of this visit. */
const encoder = new TextEncoder();
const subtle = crypto.subtle;
const ec = { name: 'ECDSA', namedCurve: 'P-256' };
const sessions = new WeakMap();
const pending = new WeakMap();
const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
function base64(value) {
  const array = new Uint8Array(value);
  let binary = '';
  for (let index = 0; index < array.length; index += 8192) binary += String.fromCharCode(...array.subarray(index, index + 8192));
  return btoa(binary);
}
const url64 = value => base64(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fail = (status, code, reason) => Object.assign(new Error(code), { status, code, reason });
const TAB_VISIT = 'codiscuss-guest-visit';

async function visitStore(mode, operation) {
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open('codiscuss-guest-visits', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('visits');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('visits', mode);
      const request = operation(transaction.objectStore('visits'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

function rememberProjection(state, data) {
  state.projection = data;
  state.observedAt = Date.now();
  const expires = data.guest?.expires_at || state.invite.invite_expires_at;
  state.localDeadline = expires - (data.server_time || state.observedAt) + state.observedAt;
}

function openVisit(state, data) {
  const session = {};
  sessions.set(session, state);
  // The invitation's deadline bounds a visit still waiting to enter; the page ends itself there (guest-session.js).
  return { session, data, invite_expires_at: state.invite.invite_expires_at };
}

/**
 * Delete every kept visit whose deadline has passed: a visit that ended while no page was open (expiry, or a
 * disconnect never seen) leaves its key and session token behind otherwise.
 */
async function sweepGuests() {
  const now = Date.now();
  await visitStore('readwrite', store => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (!(entry.value?.localDeadline > now)) entry.delete();
      entry.continue();
    };
    return cursor;
  });
}

/** Restore this tab's admitted or waiting visit; projections are refreshed by the page poll. */
export async function restoreGuest() {
  // This tab's own visit is read before the sweep, so one that ended while away still shows why.
  const id = sessionStorage.getItem(TAB_VISIT);
  const state = id ? await visitStore('readonly', store => store.get(id)) : null;
  await sweepGuests().catch(() => {});
  if (!state || state.invite.site !== location.origin) {
    if (id) sessionStorage.removeItem(TAB_VISIT);
    return null;
  }
  const result = openVisit(state, { ...state.projection, server_time: (state.projection.server_time || state.observedAt) + Math.max(0, Date.now() - state.observedAt) });
  if (state.localDeadline <= Date.now()) {
    await clearGuest(result.session);
    throw fail(403, 'guest_ended', state.projection.phase === 'waiting' ? 'invite_expired' : 'expired');
  }
  return result;
}
const sign = async (key, value) => url64(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(value)));

async function exchange(state, action, payload) {
  const { machine, room, site } = state.invite;
  const redeem = action === 'guest-redeem';
  const id = crypto.randomUUID();
  const body = JSON.stringify({ machine, action, payload, sent_at: Date.now(), ...(redeem ? {} : { room }) });
  const plain = { body, signature: await sign(state.key, id + '\n' + body), ...(redeem ? {} : { external_id: state.key_id }) };
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const peer = await subtle.importKey('jwk', state.peer, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = await subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256);
  const material = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const cipher = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('codiscuss-relay-v1') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(id) }, cipher, encoder.encode(JSON.stringify(plain)));
  const envelope = { key: await subtle.exportKey('jwk', pair.publicKey), iv: base64(iv), data: base64(data) };
  const route = (state.direct ? '/api/guest/' : '/api/machines/') + encodeURIComponent(machine) + (redeem ? '/pair' : '/relay');
  const headers = { 'Content-Type': 'application/json' };
  if (!redeem) {
    if (!state.direct && state.confirmed) headers['X-CoDiscuss-Guest-Key'] = state.public_key.x + '.' + state.public_key.y;
    const seconds = String(Math.floor(Date.now() / 1000));
    headers['X-CoDiscuss-Device'] = [machine, state.key_id, seconds, await sign(state.key, ['POST', route, seconds].join('\n'))].join('.');
  }
  const response = await fetch(site + route, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', body: JSON.stringify({ id, envelope, wait: 8000 }), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (result.status === 'revoked') {
    throw fail(403, 'guest_ended', result.reason || (state.localDeadline <= Date.now() ? 'expired' : 'disconnected'));
  }
  if (!response.ok || result.status !== 'done') throw fail(response.status, result.status || 'site_refused');
  const sealed = result.response;
  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: encoder.encode(id + ':response') }, cipher, bytes(sealed.data));
  const stream = new Blob([decrypted]).stream();
  const answer = await new Response(sealed.encoding === 'gzip' ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).json();
  if (!redeem && answer.body?.code === 'external_ended') throw fail(403, 'guest_ended', state.localDeadline <= Date.now() ? 'expired' : 'disconnected');
  if (!answer.body?.ok) throw fail(answer.status, answer.body?.code || 'guest_forbidden', answer.body?.reason || answer.body?.data?.reason || answer.body?.error?.reason);
  return answer.body.data;
}
async function newIdentity(invite) {
  if (invite.site !== location.origin) throw fail(400, 'wrong_site');
  const response = await fetch('/api/guest/' + encodeURIComponent(invite.machine) + '/key', { credentials: 'omit', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw fail(response.status, response.status === 404 ? 'machine_not_found' : 'site_refused');
  const machine = await response.json();
  if (machine?.id !== invite.machine || !machine.public_key || !machine.sign_key) throw fail(404, 'machine_not_found');
  const point = [machine.public_key.x, machine.public_key.y, machine.sign_key.x, machine.sign_key.y].join('.');
  const digest = new Uint8Array(await subtle.digest('SHA-256', encoder.encode(point)));
  if (Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('') !== invite.fp) throw fail(403, 'wrong_machine');
  const keys = await subtle.generateKey(ec, false, ['sign', 'verify']);
  return { invite, direct: machine.transport === 'direct', key: keys.privateKey, public_key: await subtle.exportKey('jwk', keys.publicKey), peer: machine.public_key, token: url64(crypto.getRandomValues(new Uint8Array(32))) };
}
/** Exchange a verified invitation. Retrying with the same invitation object retains its signing identity. */
export async function redeemGuest(invite, label) {
  if (!pending.has(invite)) pending.set(invite, newIdentity(invite).catch(error => { pending.delete(invite); throw error; }));
  const state = await pending.get(invite);
  const data = await exchange(state, 'guest-redeem', { room: invite.room, invite_id: invite.invite_id, code: invite.code, label, public_key: state.public_key, guest_token: state.token });
  state.key_id = data.key_id;
  state.visitId ||= crypto.randomUUID();
  rememberProjection(state, data.session);
  const { site, machine, room, invite_expires_at } = invite;
  state.invite = { site, machine, room, invite_expires_at };
  await visitStore('readwrite', store => store.put(state, state.visitId));
  sessionStorage.setItem(TAB_VISIT, state.visitId);
  pending.delete(invite);
  return openVisit(state, data.session);
}
/** Call one guest projection using a relative guest route. */
export async function guestRequest(session, method, path, { query, body } = {}) {
  const state = sessions.get(session);
  if (!state) throw fail(403, 'guest_ended');
  const root = '/api/external/rooms/' + encodeURIComponent(state.invite.room) + '/guest';
  let result;
  try { result = await exchange(state, 'guest-api', { method, path: root + path, query, body, token: state.token }); }
  catch (error) {
    if (error.code === 'guest_ended') await clearGuest(session);
    throw error;
  }
  if (!sessions.has(session)) throw fail(403, 'guest_ended');
  state.confirmed = true;
  if (path === '/session' && method === 'GET') {
    rememberProjection(state, result);
    await visitStore('readwrite', store => {
      const read = store.get(state.visitId);
      read.onsuccess = () => { if (read.result && sessions.has(session)) store.put(state, state.visitId); };
      return read;
    });
    if (!sessions.has(session)) throw fail(403, 'guest_ended');
  }
  return result;
}
/** Release the signing identity and invalidate pending reads. */
export async function clearGuest(session) {
  const state = sessions.get(session);
  if (!state) return;
  sessions.delete(session);
  if (sessionStorage.getItem(TAB_VISIT) === state.visitId) sessionStorage.removeItem(TAB_VISIT);
  await visitStore('readwrite', store => store.delete(state.visitId));
}
