/**
 * Cloudflare Workers / D1 backend of the online website. It keeps no rooms: the administrator signs in here, pairs a
 * computer, and every device reads and writes that computer's rooms through the end-to-end encrypted relay.
 * Rooms live only in the computer's local website (backend/server.py).
 */
const MAX_BODY_BYTES = 512 * 1024;

class HttpError extends Error {
  constructor(status, template, params = {}) {
    super(template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match));
    this.status = status;
    this.error_text = { template, params };
  }
}

// Keep the runner choices in runner/device_auth.mjs aligned with this authoritative list.
const RELAY_REGIONS = ['auto', 'apac', 'apac-ne', 'apac-se', 'wnam', 'enam', 'weur', 'eeur', 'oc', 'sam', 'afr', 'me'];

function valid_region(value) {
  return RELAY_REGIONS.includes(value) ? value : 'apac';
}

export function relay_in_region(namespace, machine, region) {
  const id = namespace.idFromName(`${machine}:${region}`);
  return region === 'auto' ? namespace.get(id) : namespace.get(id, { locationHint: region });
}

/** Both site entrypoints route using the computer's previously verified signed manifest. */
export async function read_relay_region(env, machine) {
  let region;
  try {
    const row = await env.DB?.prepare("SELECT json_extract(body, '$.relay_region') AS region FROM machine_devices WHERE machine_id=?").bind(machine).first();
    region = row?.region;
  } catch { throw new HttpError(503, "暂时无法读取电脑的中转地区，请稍后重试"); }
  return valid_region(region);
}

async function machine_relay(env, machine) {
  return relay_in_region(env.RELAY, machine, await read_relay_region(env, machine));
}

/** Return a no-store response suitable for JSON APIs or plain-text readers. */
function respond(body, status = 200, text_mode = false) {
  return new Response(text_mode ? body : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": `${text_mode ? "text/plain" : "application/json"}; charset=utf-8`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}

/** Count Unicode code points, matching the local Python service. */
function text_length(value) {
  return [...value].length;
}

/** Read bytes with a streaming size check before allocating the final buffer. */
async function read_bytes(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(limit === MAX_BODY_BYTES ? 400 : 413, "请求内容过大");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

/** Read a bounded JSON object from a browser request. */
async function read_payload(request, limit = MAX_BODY_BYTES) {
  const data = await read_bytes(request, limit);
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new HttpError(400, "请求必须是 JSON 对象");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "请求必须是 JSON 对象");
  }
  return payload;
}

const ADMIN_AVATAR_LIMIT = 60000;
// A device's signed request is accepted this long either side of its time; relayed commands carry their own replay checks.
const DEVICE_CLOCK_SECONDS = 300;
// An unpaired device may only ask to pair, a few times per address per window, so the computer is not flooded.
const PAIR_REQUESTS_PER_WINDOW = 10;
const PAIR_WINDOW_SECONDS = 600;

/** Lowercase hex of raw bytes. */
function to_hex(bytes) {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex of any string, without the length bounds of runtime_hash. */
async function digest_hex(text) {
  return to_hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compare equal-purpose hex strings without an early exit. */
function constant_time_equal(left, right) {
  const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function b64url_bytes(text) {
  const base = String(text || "").replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base + "=".repeat((4 - base.length % 4) % 4)), character => character.charCodeAt(0));
}

function admin_profile(row) {
  return row ? { username: row.username, avatar: row.avatar } : null;
}

function now_seconds() {
  return Math.floor(Date.now() / 1000);
}

function admin_username(value) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!username || text_length(username) > 30) throw new HttpError(400, "用户名须为 1–30 个字符");
  return username;
}

function admin_avatar(value) {
  if (typeof value !== "string" || (value && !value.startsWith("data:image/")) || value.length > ADMIN_AVATAR_LIMIT) {
    throw new HttpError(400, "头像须为 data:image/ 数据，且不超过 60000 字符；空字符串表示默认头像");
  }
  return value;
}

/**
 * Who sent a request: a device the paired computer signed into its device list. The credential is
 * `<computer>.<device>.<seconds>.<signature>`, the signature covering method, path and time with the device's own
 * non-exportable key. There are no accounts or passwords here; the computer alone decides which devices count.
 * `renewing` also accepts an expired device until the `renew_until` the computer signed for it: used only for a single
 * relayed request, which the computer itself limits to renewal. The list also holds external members' keys
 * (`kind: 'external'`, AIs on other computers invited into one room): they count only where `external` is set, which
 * is the relayed POST alone, so everywhere else such a signer is treated as unpaired.
 */
async function device_identity(database, credential, method, path, { renewing = false, external = false, guest_point } = {}) {
  const [machine_id, device_id, time, signature] = String(credential || "").split(".");
  if (!/^[0-9a-f]{32}$/.test(machine_id || "") || !/^[0-9a-f]{32}$/.test(device_id || "") || !/^\d{10}$/.test(time || "") || !signature) return null;
  if (Math.abs(now_seconds() - Number(time)) > DEVICE_CLOCK_SECONDS) return null;
  const query_started = performance.now();
  const lookup = await database.prepare(`SELECT d.body, d.signature, s.sign_key,
    EXISTS(SELECT 1 FROM local_machines WHERE id=d.machine_id) AS connected,
    EXISTS(SELECT 1 FROM machine_keys WHERE machine_id=d.machine_id) AS keyed
    FROM machine_devices d JOIN machine_sign_keys s ON s.machine_id=d.machine_id WHERE d.machine_id=?`)
    .bind(machine_id).all();
  const d1_ms = Math.round(performance.now() - query_started);
  const row = lookup.results[0];
  if (!row) return null;
  const algorithm = { name: "ECDSA", namedCurve: "P-256" }, hash = { name: "ECDSA", hash: "SHA-256" };
  let expires_at, kind, region;
  try {
    const signer = await crypto.subtle.importKey("jwk", JSON.parse(row.sign_key), algorithm, false, ["verify"]);
    if (!await crypto.subtle.verify(hash, signer, b64url_bytes(row.signature), new TextEncoder().encode(row.body))) return null;
    const manifest = JSON.parse(row.body);
    region = valid_region(manifest.relay_region);
    const device = manifest.devices.find(item => item.id === device_id);
    // Only the holder of a previously used guest key may distinguish a removed key from an invalid signature.
    if (!device && guest_point && external) {
      const [x, y] = guest_point.split(".");
      if (!/^[A-Za-z0-9_-]{43}$/.test(x) || !/^[A-Za-z0-9_-]{43}$/.test(y)) return null;
      const point = Uint8Array.from([4, ...b64url_bytes(x), ...b64url_bytes(y)]);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", point));
      if (Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("") !== device_id) return null;
      const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x, y }, algorithm, false, ["verify"]);
      if (await crypto.subtle.verify(hash, key, b64url_bytes(signature), new TextEncoder().encode(`${method}\n${path}\n${time}`))) return { machine_id, kind: "revoked" };
      return null;
    }
    if (!device || !Number.isFinite(device.expires_at)) return null;
    const restricted = ["guest", "external"].includes(device.kind);
    if (restricted && !external) return null;
    if (device.expires_at <= Date.now() && !(renewing && !restricted && device.renew_until > Date.now())) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: device.x, y: device.y }, algorithm, false, ["verify"]);
    if (!await crypto.subtle.verify(hash, key, b64url_bytes(signature), new TextEncoder().encode(`${method}\n${path}\n${time}`))) return null;
    expires_at = device.expires_at;
    kind = restricted ? device.kind : "device";
  } catch { return null; }
  return { machine_id, device_id, expires_at, kind, region, connected: row.connected, keyed: row.keyed, d1_ms,
    primary_colo: lookup.meta?.served_by_primary === true ? lookup.meta.served_by_colo : undefined };
}

/** Require a paired device's signed request (`X-CoDiscuss-Device`). */
async function require_device(database, request, options) {
  const device = await device_identity(database, request.headers.get("X-CoDiscuss-Device"), request.method, new URL(request.url).pathname, options);
  if (!device) throw new HttpError(401, "这台设备没有与电脑配对，或配对已失效：请在电脑前扫码配对");
  return device;
}

/** Limit pairing requests per address; the computer refuses anything but a proven pairing anyway. */
async function limit_pairing(database, request) {
  const source = `pair:${request.headers.get("CF-Connecting-IP") || "unknown"}`, now = now_seconds();
  const row = await database.prepare("SELECT * FROM admin_attempts WHERE source=?").bind(source).first();
  const fresh = !row || now - row.updated_at > PAIR_WINDOW_SECONDS;
  if (!fresh && row.failed >= PAIR_REQUESTS_PER_WINDOW) throw new HttpError(429, "配对尝试过于频繁，请稍后再试");
  await database.prepare("INSERT OR REPLACE INTO admin_attempts (source,failed,locked_until,updated_at) VALUES (?,?,0,?)")
    .bind(source, fresh ? 1 : row.failed + 1, fresh ? now : row.updated_at).run();
}

/** Public state: whether a computer is bound, whether a setup token waits, and the owner's display name and avatar. */
async function admin_state(database, request, setup_key) {
  const admin = await database.prepare("SELECT * FROM site_admin WHERE id=1").first();
  const bound = await database.prepare("SELECT 1 AS found FROM local_machines LIMIT 1").first();
  const setup = !setup_key && await database.prepare("SELECT 1 FROM admin_setup WHERE id=1").first();
  // This website keeps no rooms and no accounts; pages list the paired computer's rooms through the relay instead.
  // The owner's name and avatar are shown only to devices paired with the computer.
  const paired = await device_identity(database, request.headers.get("X-CoDiscuss-Device"), request.method, new URL(request.url).pathname);
  return { computer_rooms: true, devices: true, registered: Boolean(bound), setup_available: Boolean(setup_key || setup), profile: paired ? admin_profile(admin) : null };
}

/** Change the display name or avatar from a paired device. */
async function update_admin_profile(database, request, payload) {
  await require_device(database, request);
  const admin = await database.prepare("SELECT * FROM site_admin WHERE id=1").first();
  const username = Object.hasOwn(payload, "username") ? admin_username(payload.username) : admin?.username || "User";
  const avatar = Object.hasOwn(payload, "avatar") ? admin_avatar(payload.avatar) : admin?.avatar || "";
  // The account table now only holds the public profile; its password column is a placeholder nobody can sign in with.
  await database.prepare("INSERT INTO site_admin (id,username,password_hash,avatar,created_at) VALUES (1,?,'!',?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username, avatar=excluded.avatar")
    .bind(username, avatar, now_seconds()).run();
  return { profile: { username, avatar } };
}

/** Route /api/admin: the public state, and profile changes from a paired device. Accounts no longer exist. */
async function handle_admin_api(database, request, parts, setup_key) {
  if (parts.length === 2 && request.method === "GET") return respond(await admin_state(database, request, setup_key));
  if (parts.length === 3 && parts[2] === "profile" && request.method === "POST") return respond(await update_admin_profile(database, request, await read_payload(request)));
  throw new HttpError(404, "网站不再使用账号：在电脑前扫码配对这台设备即可");
}

// Remote launches relayed to a paired computer.
// A computer sends its state only on change plus a heartbeat every MACHINE_SYNC_SECONDS (it learns this from /sync);
// online allows two missed heartbeats (#5500). Older computers still send every 3 seconds.
const MACHINE_SYNC_SECONDS = 60;
const MACHINE_ONLINE_SECONDS = 150;
// Heartbeats refresh seen_at at most this often (well inside the online window) so frequent polls do not each spend a D1 row write.
const MACHINE_SEEN_REFRESH_SECONDS = 10;
const MACHINE_NAME_MAX = 60;
const REMOTE_PROJECT_NAME_MAX = 80;
const REMOTE_PROJECTS_MAX = 100;
const REMOTE_CLIENTS_MAX = 40;
const REMOTE_CLIENT_FIELD_MAX = 40;
const COMMAND_TTL_SECONDS = 180;
const COMMAND_WAIT_MAX = 20;
const COMMAND_POLL_MS = 250;
const ENVELOPE_DATA_MAX = 512 * 1024;
const RELAY_PROTOCOL = "codiscuss-relay";
const MACHINE_SELECT = "SELECT m.*, k.public_key, s.sign_key, p.parent_id FROM local_machines m LEFT JOIN machine_keys k ON k.machine_id=m.id LEFT JOIN machine_sign_keys s ON s.machine_id=m.id LEFT JOIN machine_parents p ON p.machine_id=m.id";
// A bound computer binds its hosted accounts with one-time child tokens (#5494).
const CHILD_SETUP_SECONDS = 600;
const CHILD_SETUP_PENDING_MAX = 5;
const CHILD_MACHINES_MAX = 50;

/** Hash a machine token; malformed values hash to an empty string and never match. */
async function machine_token_digest(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? digest_hex(token) : "";
}

/**
 * Machine fields: anyone may see a computer's name, keys and whether it is online, which an unpaired device needs to
 * pair; its projects and software only a paired device sees.
 */
function machine_view(row, now, paired = false) {
  return { id: row.id, name: row.name, ...(paired ? { projects: JSON.parse(row.projects), clients: JSON.parse(row.clients) } : { projects: [], clients: {} }),
    public_key: row.public_key ? JSON.parse(row.public_key) : null, sign_key: row.sign_key ? JSON.parse(row.sign_key) : null,
    seen_at: row.seen_at, online: now - row.seen_at <= MACHINE_ONLINE_SECONDS, ...(row.parent_id ? { parent: row.parent_id } : {}) };
}

/**
 * Bind a computer to this website, or replace its token, with the one-time setup token only the deployer can create
 * (`codiscuss token` writes its hash to D1). There is no account to sign in with.
 */
async function pair_machine(database, payload, now, setup_key) {
  const supplied = await digest_hex(typeof payload.setup_key === "string" ? payload.setup_key.trim() : "");
  const setup = await database.prepare("SELECT token_hash FROM admin_setup WHERE id=1").first();
  const matches = (setup_key && constant_time_equal(supplied, await digest_hex(String(setup_key)))) || (setup && constant_time_equal(supplied, setup.token_hash));
  // A child token from a bound computer binds one hosted account under it; the deployer's token stays untouched.
  const child = matches ? null : await database.prepare("SELECT parent_id FROM machine_setup WHERE token_hash=? AND created_at>=?")
    .bind(supplied, now - CHILD_SETUP_SECONDS).first();
  if (!matches && !child) throw new HttpError(403, "绑定令牌错误或已用过：请在部署网站的电脑上运行 codiscuss token 重新生成");
  const { id, token } = payload;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const hashed = await machine_token_digest(token);
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || !hashed) throw new HttpError(400, "电脑编号或凭据无效");
  if (name.length < 1 || name.length > MACHINE_NAME_MAX) throw new HttpError(400, "电脑名称需为 1–{max} 个字符", { max: MACHINE_NAME_MAX });
  const upsert = database.prepare("INSERT INTO local_machines (id,name,token_hash,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash")
    .bind(id, name, hashed, now);
  if (child) {
    // A child token cannot take over another computer, only rebind one of the same parent's own accounts.
    const existing = await database.prepare("SELECT m.id, p.parent_id FROM local_machines m LEFT JOIN machine_parents p ON p.machine_id=m.id WHERE m.id=?").bind(id).first();
    if (id === child.parent_id || (existing && existing.parent_id !== child.parent_id)) throw new HttpError(409, "这个电脑编号已绑定，不能用托管账号的令牌改绑");
    await database.batch([upsert,
      database.prepare("INSERT INTO machine_parents (machine_id,parent_id) VALUES (?,?) ON CONFLICT(machine_id) DO UPDATE SET parent_id=excluded.parent_id").bind(id, child.parent_id),
      database.prepare("DELETE FROM machine_setup WHERE token_hash=?").bind(supplied)]);
  } else {
    await database.batch([upsert, database.prepare("DELETE FROM admin_setup")]);
  }
  return machine_view(await database.prepare(`${MACHINE_SELECT} WHERE m.id=?`).bind(id).first(), now);
}

/**
 * Release one of this computer's hosted accounts from the website, so its slot under CHILD_MACHINES_MAX comes back and
 * its credential stops working. Only the parent that bound it can; anything else is 404. Rows of the child in every
 * table go too, without relying on the database enforcing ON DELETE CASCADE.
 */
async function release_child(database, machine_id, token, payload) {
  await require_machine(database, machine_id, token);
  const child = typeof payload.machine === "string" ? payload.machine : "";
  if (!await database.prepare("SELECT 1 AS found FROM machine_parents WHERE machine_id=? AND parent_id=?").bind(child, machine_id).first()) {
    throw new HttpError(404, "这台电脑名下没有这个托管账号");
  }
  await database.batch(["machine_parents", "machine_keys", "machine_sign_keys", "machine_devices", "machine_commands", "remote_launches"]
    .map(table => database.prepare(`DELETE FROM ${table} WHERE machine_id=?`).bind(child))
    .concat(database.prepare("DELETE FROM local_machines WHERE id=?").bind(child)));
  return { released: child };
}

/**
 * Issue a one-time child binding token for a hosted account on this bound computer, valid CHILD_SETUP_SECONDS. A child
 * cannot issue (no chains); unused tokens and children per computer are capped.
 */
async function issue_child_setup(database, machine_id, token, now) {
  await require_machine(database, machine_id, token);
  if (await database.prepare("SELECT 1 AS found FROM machine_parents WHERE machine_id=?").bind(machine_id).first()) {
    throw new HttpError(403, "托管账号的电脑不能再签发绑定令牌");
  }
  await database.prepare("DELETE FROM machine_setup WHERE parent_id=? AND created_at<?").bind(machine_id, now - CHILD_SETUP_SECONDS).run();
  const pending = await database.prepare("SELECT COUNT(*) AS count FROM machine_setup WHERE parent_id=?").bind(machine_id).first("count");
  if (pending >= CHILD_SETUP_PENDING_MAX) throw new HttpError(429, "未使用的绑定令牌过多，请稍后再试");
  const children = await database.prepare("SELECT COUNT(*) AS count FROM machine_parents WHERE parent_id=?").bind(machine_id).first("count");
  if (children >= CHILD_MACHINES_MAX) throw new HttpError(409, "这台电脑绑定的托管账号已达上限 {max} 个", { max: CHILD_MACHINES_MAX });
  const setup_key = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  await database.prepare("INSERT INTO machine_setup (token_hash,parent_id,created_at) VALUES (?,?,?)").bind(await digest_hex(setup_key), machine_id, now).run();
  return { setup_key, expires_at: now + CHILD_SETUP_SECONDS };
}

/** Authenticate the computer itself by its own token. */
async function require_machine(database, machine_id, token) {
  const row = await database.prepare("SELECT * FROM local_machines WHERE id=?").bind(machine_id).first();
  const hashed = await machine_token_digest(token);
  if (!row || !hashed || !constant_time_equal(row.token_hash, hashed)) throw new HttpError(401, "电脑凭据无效，请在这台电脑上重新连接网站");
  return row;
}

/** Project names and ids only; directories never leave the computer. */
function valid_projects(value) {
  if (!Array.isArray(value) || value.length > REMOTE_PROJECTS_MAX) throw new HttpError(400, "项目列表须为不超过 {max} 项的列表", { max: REMOTE_PROJECTS_MAX });
  return value.map(item => {
    const { id, name } = item && typeof item === "object" ? item : {};
    if (typeof id !== "string" || !/^[0-9a-f]{8,32}$/.test(id) || typeof name !== "string" || name.length < 1 || name.length > REMOTE_PROJECT_NAME_MAX) throw new HttpError(400, "项目须包含有效编号与名称");
    return { id, name };
  });
}

/** Map each platform the computer can wake to its configured client type. */
function valid_clients(value) {
  const entries = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null;
  if (!entries || entries.length > REMOTE_CLIENTS_MAX || entries.some(([key, item]) => typeof item !== "string" || !key.length || key.length > REMOTE_CLIENT_FIELD_MAX
    || !item.length || item.length > REMOTE_CLIENT_FIELD_MAX)) throw new HttpError(400, "软件配置须为平台到客户端类型的对象");
  return value;
}

/** An ECDH P-256 public key as JWK coordinates; anything else is rejected. */
function valid_public_key(value) {
  if (!value || typeof value !== "object" || value.kty !== "EC" || value.crv !== "P-256"
    || !["x", "y"].every(axis => typeof value[axis] === "string" && /^[A-Za-z0-9_-]{43}$/.test(value[axis]))) throw new HttpError(400, "电脑公钥须为 P-256 JWK");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

/** Ciphertext and IV, plus the sender's ephemeral key on requests; the site never reads the content. */
function valid_envelope(value, with_key) {
  if (!value || typeof value !== "object" || typeof value.iv !== "string" || !/^[A-Za-z0-9+/]{16}$/.test(value.iv)
    || typeof value.data !== "string" || !value.data.length || value.data.length > ENVELOPE_DATA_MAX || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
    throw new HttpError(400, "加密命令格式无效");
  }
  return { iv: value.iv, data: value.data, ...(with_key ? { key: valid_public_key(value.key) } : {}) };
}

/**
 * Record the computer's projects, clients, keys and its signed device list. The list is stored only if the computer's
 * own signing key verifies it, so neither this website nor anything else can add a device.
 */
async function machine_sync(database, machine_id, token, payload, now, relay = null) {
  await require_machine(database, machine_id, token);
  const projects = valid_projects(payload.projects), clients = valid_clients(payload.clients);
  const public_key = "public_key" in payload ? valid_public_key(payload.public_key) : null;
  const sign_key = "sign_key" in payload ? valid_public_key(payload.sign_key) : null;
  if ('relay_region' in payload || (payload.devices && (!sign_key || !payload.devices.signature || !payload.devices.body))) {
    throw new HttpError(400, "设备名单签名无效");
  }
  let list;
  if (sign_key && payload.devices && typeof payload.devices.body === "string" && typeof payload.devices.signature === "string") {
    const key = await crypto.subtle.importKey("jwk", sign_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64url_bytes(payload.devices.signature), new TextEncoder().encode(payload.devices.body));
    list = valid ? JSON.parse(payload.devices.body) : null;
    if (!list || list.machine !== machine_id || !Array.isArray(list.devices)) throw new HttpError(400, "设备名单签名无效");
    if ('relay_region' in list && !RELAY_REGIONS.includes(list.relay_region)) throw new HttpError(400, "中转地区无效");
  }
  let key_changed = false;
  if (sign_key) {
    const saved = await database.prepare("INSERT INTO machine_sign_keys (machine_id,sign_key) VALUES (?,?) ON CONFLICT(machine_id) DO UPDATE SET sign_key=excluded.sign_key WHERE machine_sign_keys.sign_key IS NOT excluded.sign_key")
      .bind(machine_id, JSON.stringify(sign_key)).run();
    key_changed = Boolean(saved.meta?.changes);
  }
  if (list) {
    // Judged by content, not issued_at: an older computer re-signs the same list on every heartbeat, which would
    // otherwise write a row and wake the relay each time (#5500).
    const current = await database.prepare("SELECT body FROM machine_devices WHERE machine_id=?").bind(machine_id).first();
    const previous_region = valid_region(current && JSON.parse(current.body).relay_region);
    const region = list.relay_region ?? 'apac';
    let unchanged = false;
    // A new signing key needs the list it signed: devices are checked against the stored signature with the current key.
    try { unchanged = previous_region === region && !key_changed && Boolean(current) && JSON.stringify(JSON.parse(current.body).devices) === JSON.stringify(list.devices); } catch { unchanged = false; }
    const stored = unchanged ? null : await database.prepare(`INSERT INTO machine_devices (machine_id,body,signature,issued_at) VALUES (?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET
      body=excluded.body, signature=excluded.signature, issued_at=excluded.issued_at WHERE excluded.issued_at>machine_devices.issued_at`)
      .bind(machine_id, payload.devices.body, payload.devices.signature, list.issued_at).run();
    // A changed list closes the live sockets of devices it no longer holds; an unchanged one writes nothing and leaves the relay asleep.
    if (relay && stored?.meta?.changes) {
      if (region !== previous_region) {
        try {
          await relay_in_region(relay, machine_id, previous_region).fetch("https://relay.internal/", {
            method: "POST", headers: { "X-Relay-Role": "relocate" }
          });
        } catch { /* The computer also reconnects when its local setting changes. */ }
      }
      await relay_in_region(relay, machine_id, region).fetch("https://relay.internal/", { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Role": "devices" },
        body: JSON.stringify({ devices: list.devices.filter(item => item.kind !== "external").map(item => ({ id: item.id, kind: item.kind, expires_at: item.expires_at })) }) }).catch(() => {});
    }
  }
  // Unchanged heartbeats write nothing until seen_at is due for a refresh.
  await database.prepare(`UPDATE local_machines SET projects=?1, clients=?2, seen_at=?3 WHERE id=?4
    AND (projects IS NOT ?1 OR clients IS NOT ?2 OR seen_at<?3-?5)`)
    .bind(JSON.stringify(projects), JSON.stringify(clients), now, machine_id, MACHINE_SEEN_REFRESH_SECONDS).run();
  if (public_key) {
    await database.prepare(`INSERT INTO machine_keys (machine_id,public_key) VALUES (?,?) ON CONFLICT(machine_id) DO UPDATE SET public_key=excluded.public_key
      WHERE machine_keys.public_key IS NOT excluded.public_key`)
      .bind(machine_id, JSON.stringify(public_key)).run();
  }
  return { launches: [], sync_seconds: MACHINE_SYNC_SECONDS };
}

/** Queue one encrypted local-service operation for the paired computer. */
async function submit_machine_command(database, machine_id, payload, now) {
  const { id } = payload;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new HttpError(400, "命令编号无效");
  const envelope = valid_envelope(payload.envelope, true);
  if (!await database.prepare("SELECT 1 AS found FROM local_machines WHERE id=?").bind(machine_id).first()) throw new HttpError(404, "这台电脑尚未连接网站");
  if (!await database.prepare("SELECT 1 AS found FROM machine_keys WHERE machine_id=?").bind(machine_id).first()) throw new HttpError(409, "这台电脑的 codiscuss 版本过旧，请更新后重试");
  const inserted = await database.prepare("INSERT OR IGNORE INTO machine_commands (id,machine_id,request,created_at,updated_at) VALUES (?,?,?,?,?)")
    .bind(id, machine_id, JSON.stringify(envelope), now, now).run();
  if (!inserted.meta.changes) throw new HttpError(409, "命令编号已使用");
  return { id, status: "pending" };
}

/** Report a command's progress; a finished command hands over its response once and is deleted. */
async function machine_command_status(database, machine_id, command_id) {
  const row = await database.prepare("SELECT * FROM machine_commands WHERE id=? AND machine_id=?").bind(command_id, machine_id).first();
  if (!row) throw new HttpError(404, "命令不存在或已过期");
  if (row.status !== "done") return { id: command_id, status: row.status };
  await database.prepare("DELETE FROM machine_commands WHERE id=?").bind(command_id).run();
  return { id: command_id, status: "done", response: JSON.parse(row.response) };
}

/** Drop expired commands and hand the computer every pending one, clearing the queued ciphertext. */
async function claim_machine_commands(database, machine_id, token, now) {
  await require_machine(database, machine_id, token);
  await database.batch([
    database.prepare("DELETE FROM machine_commands WHERE machine_id=? AND created_at<?").bind(machine_id, now - COMMAND_TTL_SECONDS),
    database.prepare("UPDATE local_machines SET seen_at=? WHERE id=? AND seen_at<?").bind(now, machine_id, now - MACHINE_SEEN_REFRESH_SECONDS),
  ]);
  const { results } = await database.prepare("SELECT id,request FROM machine_commands WHERE machine_id=? AND status='pending' ORDER BY created_at").bind(machine_id).all();
  const commands = [];
  for (const row of results) {
    // Only the claim that moves the row hands it out, so two overlapping polls never run one command twice.
    const claimed = await database.prepare("UPDATE machine_commands SET status='claimed', request='{}', updated_at=? WHERE id=? AND status='pending'").bind(now, row.id).run();
    if (claimed.meta.changes) commands.push({ id: row.id, envelope: JSON.parse(row.request) });
  }
  return { commands };
}

/** Long-poll for relayed commands so a waiting device gets its answer without the computer's sync delay. */
async function wait_machine_commands(database, machine_id, token, payload) {
  const wait = typeof payload.wait === "number" ? Math.min(Math.max(payload.wait, 0), COMMAND_WAIT_MAX) : 0;
  const deadline = Date.now() + wait * 1000;
  let result = await claim_machine_commands(database, machine_id, token, now_seconds());
  // Between full claims only one cheap read looks for a new command, so waiting writes nothing and can poll often.
  while (!result.commands.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, COMMAND_POLL_MS));
    if (await database.prepare("SELECT 1 AS found FROM machine_commands WHERE machine_id=? AND status='pending' LIMIT 1").bind(machine_id).first()) {
      result = await claim_machine_commands(database, machine_id, token, now_seconds());
    }
  }
  return result;
}

/** Store the computer's encrypted response for the device that is waiting on it. */
async function finish_machine_command(database, machine_id, command_id, token, payload, now) {
  await require_machine(database, machine_id, token);
  const envelope = valid_envelope(payload.envelope, false);
  const row = await database.prepare("SELECT status FROM machine_commands WHERE id=? AND machine_id=?").bind(command_id, machine_id).first();
  if (!row) throw new HttpError(404, "命令不存在或已过期");
  const updated = await database.prepare("UPDATE machine_commands SET status='done', response=?, updated_at=? WHERE id=? AND status='claimed'")
    .bind(JSON.stringify(envelope), now, command_id).run();
  if (!updated.meta.changes) throw new HttpError(409, "命令已结束");
  return { id: command_id, status: "done" };
}

/**
 * Authenticate relay traffic, then hand it to the computer's relay object: the computer's socket by its token, a device's
 * socket and requests by the administrator session. Credentials travel as WebSocket subprotocols, never in the URL.
 * Without the RELAY binding the route is absent and both sides keep the D1 command queue.
 */
async function handle_relay(env, request, machine_id) {
  const started = performance.now();
  if (!env.RELAY) throw new HttpError(404, "中转未配置");
  const database = env.DB;
  if (request.headers.get("Upgrade") === "websocket") {
    const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map(item => item.trim());
    if (!offered.includes(RELAY_PROTOCOL)) throw new HttpError(400, "中转协议不受支持");
    const machine = offered.find(item => /^m\.[0-9a-f]{64}$/.test(item));
    const device = offered.find(item => item.startsWith("d."));
    let role = "machine", identity = null;
    if (machine) await require_machine(database, machine_id, machine.slice(2));
    else {
      // A device signs the socket with its own key, as it signs requests; subprotocols carry it, never the URL.
      identity = await device_identity(database, device?.slice(2), "GET", new URL(request.url).pathname);
      if (!identity || identity.machine_id !== machine_id) throw new HttpError(401, "这台设备没有与电脑配对，或配对已失效：请在电脑前扫码配对");
      check_machine_binding(identity);
      role = "device";
    }
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Role", role);
    forwarded.headers.set("X-Relay-Colo", request.cf?.colo || "");
    // The relay keeps which device holds each socket and until when, so it can close it on expiry or revocation.
    if (identity) forwarded.headers.set("X-Relay-Device", JSON.stringify({ id: identity.device_id, expires_at: identity.expires_at }));
    const target = identity ? relay_in_region(env.RELAY, machine_id, identity.region) : await machine_relay(env, machine_id);
    return target.fetch(forwarded);
  }
  if (request.method !== "POST") throw new HttpError(404, "地址不存在");
  // An expired device that may still renew reaches the computer one request at a time; the computer lets only renewal through.
  // An external member listed by the computer reaches it this way only; the computer answers it with the external actions alone.
  const identity = await require_device(database, request, { renewing: true, external: true, guest_point: request.headers.get("X-CoDiscuss-Guest-Key") });
  if (identity.kind === "revoked" && identity.machine_id === machine_id) return Response.json({ status: "revoked" }, { headers: { "Cache-Control": "no-store" } });
  if (identity.machine_id !== machine_id) throw new HttpError(403, "这台设备配对的是另一台电脑");
  check_machine_binding(identity);
  const guest = identity.kind === "guest" ? { id: identity.device_id, expires_at: identity.expires_at } : undefined;
  const answer = await forward_relay(relay_in_region(env.RELAY, machine_id, identity.region), await read_payload(request), started, identity.kind === "device" ? request.cf?.colo || null : undefined, guest, identity);
  if (guest) {
    const current = await device_identity(database, request.headers.get("X-CoDiscuss-Device"), "POST", new URL(request.url).pathname, { external: true });
    if (current?.kind !== "guest") return Response.json({ status: "revoked", reason: guest.expires_at <= Date.now() ? "expired" : "disconnected" }, { headers: { "Cache-Control": "no-store" } });
    answer.headers.set("Cache-Control", "no-store");
  }
  return answer;
}

/** Hand one sealed request to the computer's relay object and return its answer. */
async function forward_relay(relay, { id, envelope, wait }, started, colo, guest, identity) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new HttpError(400, "命令编号无效");
  const rpc_started = performance.now();
  const answer = await relay.fetch("https://relay.internal/", { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Role": "request" },
    body: JSON.stringify({ id, guest, envelope: valid_envelope(envelope, true), ...(Number.isInteger(wait) ? { wait } : {}) }) });
  const result = await answer.json();
  // Unsigned site observations are diagnostic only. Never use them for authorization or routing.
  if (started !== undefined) {
    result.worker_ms = Math.round(performance.now() - started);
    if (colo !== undefined) {
      result.device_colo = colo;
      result.d1_ms = identity.d1_ms;
      result.primary_colo = identity.primary_colo;
      result.rpc_ms = Math.round(performance.now() - rpc_started);
    }
  }
  if (colo === undefined) {
    delete result.device_colo;
    delete result.machine_colo;
  }
  return respond(result);
}

/**
 * The one entry an unpaired device has: its sealed pairing request, limited per address. The computer runs nothing
 * unsigned except a pairing that proves the code shown on its own screen.
 */
async function handle_pairing(env, request, machine_id) {
  const database = env.DB;
  if (request.method !== "POST") throw new HttpError(404, "地址不存在");
  await limit_pairing(database, request);
  await require_paired_machine(database, machine_id);
  const payload = await read_payload(request);
  if (env.RELAY) return forward_relay(await machine_relay(env, machine_id), payload);
  return respond(await submit_machine_command(database, machine_id, payload, now_seconds()));
}

/** A paired computer that can already decrypt relayed commands. */
function check_machine_binding(identity) {
  if (!identity.connected) throw new HttpError(404, "这台电脑尚未连接网站");
  if (!identity.keyed) throw new HttpError(409, "这台电脑的 codiscuss 版本过旧，请更新后重试");
}

async function require_paired_machine(database, machine_id) {
  if (!await database.prepare("SELECT 1 AS found FROM local_machines WHERE id=?").bind(machine_id).first()) throw new HttpError(404, "这台电脑尚未连接网站");
  if (!await database.prepare("SELECT 1 AS found FROM machine_keys WHERE machine_id=?").bind(machine_id).first()) throw new HttpError(409, "这台电脑的 codiscuss 版本过旧，请更新后重试");
}

/** Pair computers and queue their commands; a computer authenticates with its own token, everything else as the administrator. */
async function handle_remote_launch_api(database, request, parts, setup_key, relay) {
  const now = now_seconds(), method = request.method;
  if (parts.length === 4 && parts[1] === "machines" && parts[3] === "release" && method === "POST") {
    return respond(await release_child(database, parts[2], request.headers.get("X-Machine-Token") ?? "", await read_payload(request)));
  }
  if (parts.length === 4 && parts[1] === "machines" && parts[3] === "setup" && method === "POST") {
    return respond(await issue_child_setup(database, parts[2], request.headers.get("X-Machine-Token") ?? "", now));
  }
  if (parts.length === 4 && parts[1] === "machines" && parts[3] === "sync" && method === "POST") {
    return respond(await machine_sync(database, parts[2], request.headers.get("X-Machine-Token") ?? "", await read_payload(request), now, relay));
  }
  if (parts.length === 5 && parts[1] === "machines" && parts[3] === "commands" && method === "POST") {
    const token = request.headers.get("X-Machine-Token") ?? "", payload = await read_payload(request);
    return respond(parts[4] === "claim" ? await wait_machine_commands(database, parts[2], token, payload)
      : await finish_machine_command(database, parts[2], parts[4], token, payload, now));
  }
  // A queued command's answer is sealed for the device that sent it, and its id is unguessable, so reading it needs no sign-in.
  if (parts.length === 5 && parts[3] === "commands" && method === "GET") return respond(await machine_command_status(database, parts[2], parts[4]));
  if (parts.length === 2 && method === "GET") {
    const signed = request.headers.get("X-CoDiscuss-Device") ? await device_identity(database, request.headers.get("X-CoDiscuss-Device"), "GET", "/api/machines", { renewing: true }) : null;
    if (!signed && request.headers.has("X-CoDiscuss-Device")) throw new HttpError(401, "这台设备没有与电脑配对，或配对已失效：请在电脑前扫码配对");
    if (!signed) return respond({ code: "client_update_required", error: "请更新 AI CoDiscuss 后使用完整邀请链接。 Please update AI CoDiscuss and use the full invitation link." }, 426);
    const row = await database.prepare(`${MACHINE_SELECT} WHERE m.id=?`).bind(signed.machine_id).first();
    return respond({ machines: row ? [machine_view(row, now, signed.expires_at > Date.now())] : [] });
  }
  if (parts.length === 2 && method === "POST") return respond(await pair_machine(database, await read_payload(request), now, setup_key));
  const identity = await require_device(database, request);
  if (parts.length === 4 && parts[3] === "commands" && method === "POST") {
    if (identity.machine_id !== parts[2]) throw new HttpError(403, "这台设备配对的是另一台电脑");
    return respond(await submit_machine_command(database, parts[2], await read_payload(request), now));
  }
  throw new HttpError(404, "地址不存在");
}

async function handle_api(database, request, parts, setup_key = "", relay = null) {
  const route = parts.join("/");
  if (request.method === "GET" && parts.length === 4 && parts[1] === "guest" && parts[3] === "key" && /^[0-9a-f]{32}$/.test(parts[2])) {
    const row = await database.prepare("SELECT k.public_key,s.sign_key FROM machine_keys k JOIN machine_sign_keys s ON k.machine_id=s.machine_id WHERE k.machine_id=?").bind(parts[2]).first();
    if (!row) throw new HttpError(404, "地址不存在");
    return respond({ id: parts[2], public_key: JSON.parse(row.public_key), sign_key: JSON.parse(row.sign_key) });
  }
  if (route === "api/health" && request.method === "GET") return respond({ ok: true });
  if (parts[1] === "admin") return handle_admin_api(database, request, parts, setup_key);
  if (parts[1] === "machines") return handle_remote_launch_api(database, request, parts, setup_key, relay);
  throw new HttpError(404, "地址不存在");
}

/** Forward only the share token to the selected computer. Rooms and share state live there. */
async function handle_public_cloud_share(request, env, path) {
  const match = /^\/api\/cloud-share\/([0-9a-f]{32})\/([0-9a-f]{64})(?:\/([0-9A-Za-z]{4}))?$/.exec(path);
  if (request.method !== "GET" || request.body || (request.headers.get("Content-Length") ?? "0") !== "0" ||
      request.headers.has("Transfer-Encoding") || !match || !env.RELAY)
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  const relay = await machine_relay(env, match[1]);
  return relay.fetch("https://relay.internal/", { method: "POST", headers: {
    "X-Relay-Role": "cloud-share", "X-Cloud-Share-Token": match[2], "Accept-Language": request.headers.get("Accept-Language") || "zh",
    ...(match[3] ? { "X-Cloud-Share-Code": match[3] } : {}),
  } });
}

/** Dispatch Worker requests, including public links to the computer and static page assets. */
async function fetch_request(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  try {
    if (parts[0] === "api" && parts[1] === "cloud-share") return await handle_public_cloud_share(request, env, url.pathname);
    if (url.pathname === "/robots.txt") return respond("User-agent: *\nAllow: /\n", 200, true);
    if (parts[0] !== "api") return env.ASSETS.fetch(request);
    if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 501 });
    if (parts.length === 4 && parts[1] === "machines" && parts[3] === "relay") return await handle_relay(env, request, parts[2]);
    if (parts.length === 4 && parts[1] === "machines" && parts[3] === "pair") return await handle_pairing(env, request, parts[2]);
    // Where the hosted accounts' entry Worker of this site is (deployed with it, `ENTRY_URL` in the private config), so a
    // hosting computer that binds itself here needs no second address typed in. Public: it is the address users open.
    if (url.pathname === "/api/entry" && request.method === "GET") return respond({ entry_url: typeof env.ENTRY_URL === "string" ? env.ENTRY_URL : "" });
    return await handle_api(env.DB, request, parts, env.ADMIN_SETUP_KEY, env.RELAY ?? null);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const failure = status === 500 ? new HttpError(500, "服务器内部错误") : error;
    return respond({ error: failure.message, error_text: failure.error_text }, status);
  }
}

export default { fetch: fetch_request };
