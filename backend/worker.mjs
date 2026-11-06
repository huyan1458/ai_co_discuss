/**
 * Cloudflare Workers / D1 backend of the online website. It keeps no rooms: the administrator signs in here, pairs a
 * computer, and every device reads and writes that computer's rooms through the end-to-end encrypted relay.
 * Rooms live only in the computer's local website (backend/server.py).
 */
const MAX_BODY_BYTES = 512 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
 * relayed request, which the computer itself limits to renewal.
 */
async function device_identity(database, credential, method, path, { renewing = false } = {}) {
  const [machine_id, device_id, time, signature] = String(credential || "").split(".");
  if (!/^[0-9a-f]{32}$/.test(machine_id || "") || !/^[0-9a-f]{32}$/.test(device_id || "") || !/^\d{10}$/.test(time || "") || !signature) return null;
  if (Math.abs(now_seconds() - Number(time)) > DEVICE_CLOCK_SECONDS) return null;
  const row = await database.prepare("SELECT d.body, d.signature, s.sign_key FROM machine_devices d JOIN machine_sign_keys s ON s.machine_id=d.machine_id WHERE d.machine_id=?")
    .bind(machine_id).first();
  if (!row) return null;
  const algorithm = { name: "ECDSA", namedCurve: "P-256" }, hash = { name: "ECDSA", hash: "SHA-256" };
  let expires_at;
  try {
    const signer = await crypto.subtle.importKey("jwk", JSON.parse(row.sign_key), algorithm, false, ["verify"]);
    if (!await crypto.subtle.verify(hash, signer, b64url_bytes(row.signature), new TextEncoder().encode(row.body))) return null;
    const device = JSON.parse(row.body).devices.find(item => item.id === device_id);
    if (!device || (device.expires_at <= Date.now() && !(renewing && device.renew_until > Date.now()))) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: device.x, y: device.y }, algorithm, false, ["verify"]);
    if (!await crypto.subtle.verify(hash, key, b64url_bytes(signature), new TextEncoder().encode(`${method}\n${path}\n${time}`))) return null;
    expires_at = device.expires_at;
  } catch { return null; }
  return { machine_id, device_id, expires_at };
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
const MACHINE_ONLINE_SECONDS = 30;
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
const MACHINE_SELECT = "SELECT m.*, k.public_key, s.sign_key FROM local_machines m LEFT JOIN machine_keys k ON k.machine_id=m.id LEFT JOIN machine_sign_keys s ON s.machine_id=m.id";

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
    seen_at: row.seen_at, online: now - row.seen_at <= MACHINE_ONLINE_SECONDS };
}

/**
 * Bind a computer to this website, or replace its token, with the one-time setup token only the deployer can create
 * (`codiscuss token` writes its hash to D1). There is no account to sign in with.
 */
async function pair_machine(database, payload, now, setup_key) {
  const supplied = await digest_hex(typeof payload.setup_key === "string" ? payload.setup_key.trim() : "");
  const setup = await database.prepare("SELECT token_hash FROM admin_setup WHERE id=1").first();
  const matches = (setup_key && constant_time_equal(supplied, await digest_hex(String(setup_key)))) || (setup && constant_time_equal(supplied, setup.token_hash));
  if (!matches) throw new HttpError(403, "绑定令牌错误或已用过：请在部署网站的电脑上运行 codiscuss token 重新生成");
  const { id, token } = payload;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const hashed = await machine_token_digest(token);
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || !hashed) throw new HttpError(400, "电脑编号或凭据无效");
  if (name.length < 1 || name.length > MACHINE_NAME_MAX) throw new HttpError(400, `电脑名称需为 1–${MACHINE_NAME_MAX} 个字符`);
  await database.batch([
    database.prepare("INSERT INTO local_machines (id,name,token_hash,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash")
      .bind(id, name, hashed, now),
    database.prepare("DELETE FROM admin_setup"),
  ]);
  return machine_view(await database.prepare(`${MACHINE_SELECT} WHERE m.id=?`).bind(id).first(), now);
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
  if (!Array.isArray(value) || value.length > REMOTE_PROJECTS_MAX) throw new HttpError(400, `项目列表须为不超过 ${REMOTE_PROJECTS_MAX} 项的列表`);
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
  if (sign_key) {
    await database.prepare("INSERT INTO machine_sign_keys (machine_id,sign_key) VALUES (?,?) ON CONFLICT(machine_id) DO UPDATE SET sign_key=excluded.sign_key WHERE machine_sign_keys.sign_key IS NOT excluded.sign_key")
      .bind(machine_id, JSON.stringify(sign_key)).run();
  }
  if (sign_key && payload.devices && typeof payload.devices.body === "string" && typeof payload.devices.signature === "string") {
    const key = await crypto.subtle.importKey("jwk", sign_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64url_bytes(payload.devices.signature), new TextEncoder().encode(payload.devices.body));
    const list = valid ? JSON.parse(payload.devices.body) : null;
    if (!list || list.machine !== machine_id || !Array.isArray(list.devices)) throw new HttpError(400, "设备名单签名无效");
    const stored = await database.prepare(`INSERT INTO machine_devices (machine_id,body,signature,issued_at) VALUES (?,?,?,?) ON CONFLICT(machine_id) DO UPDATE SET
      body=excluded.body, signature=excluded.signature, issued_at=excluded.issued_at WHERE excluded.issued_at>machine_devices.issued_at`)
      .bind(machine_id, payload.devices.body, payload.devices.signature, list.issued_at).run();
    // A new list closes the live sockets of devices it no longer holds; unchanged heartbeats do not wake the relay.
    if (relay && stored.meta?.changes) {
      await relay.get(relay.idFromName(machine_id)).fetch("https://relay.internal/", { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Role": "devices" },
        body: JSON.stringify({ devices: list.devices.map(item => ({ id: item.id, expires_at: item.expires_at })) }) }).catch(() => {});
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
  return { launches: [] };
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
  if (!env.RELAY) throw new HttpError(404, "中转未配置");
  const database = env.DB;
  const relay = env.RELAY.get(env.RELAY.idFromName(machine_id));
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
      await require_paired_machine(database, machine_id);
      role = "device";
    }
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Role", role);
    // The relay keeps which device holds each socket and until when, so it can close it on expiry or revocation.
    if (identity) forwarded.headers.set("X-Relay-Device", JSON.stringify({ id: identity.device_id, expires_at: identity.expires_at }));
    return relay.fetch(forwarded);
  }
  if (request.method !== "POST") throw new HttpError(404, "地址不存在");
  // An expired device that may still renew reaches the computer one request at a time; the computer lets only renewal through.
  const identity = await require_device(database, request, { renewing: true });
  if (identity.machine_id !== machine_id) throw new HttpError(403, "这台设备配对的是另一台电脑");
  await require_paired_machine(database, machine_id);
  return forward_relay(relay, await read_payload(request));
}

/** Hand one sealed request to the computer's relay object and return its answer. */
async function forward_relay(relay, { id, envelope, wait }) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new HttpError(400, "命令编号无效");
  const answer = await relay.fetch("https://relay.internal/", { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Role": "request" },
    body: JSON.stringify({ id, envelope: valid_envelope(envelope, true), ...(Number.isInteger(wait) ? { wait } : {}) }) });
  return respond(await answer.json());
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
  if (env.RELAY) return forward_relay(env.RELAY.get(env.RELAY.idFromName(machine_id)), payload);
  return respond(await submit_machine_command(database, machine_id, payload, now_seconds()));
}

/** A paired computer that can already decrypt relayed commands. */
async function require_paired_machine(database, machine_id) {
  if (!await database.prepare("SELECT 1 AS found FROM local_machines WHERE id=?").bind(machine_id).first()) throw new HttpError(404, "这台电脑尚未连接网站");
  if (!await database.prepare("SELECT 1 AS found FROM machine_keys WHERE machine_id=?").bind(machine_id).first()) throw new HttpError(409, "这台电脑的 codiscuss 版本过旧，请更新后重试");
}

/** Pair computers and queue their commands; a computer authenticates with its own token, everything else as the administrator. */
async function handle_remote_launch_api(database, request, parts, setup_key, relay) {
  const now = now_seconds(), method = request.method;
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
    const signed = request.headers.get("X-CoDiscuss-Device") ? await device_identity(database, request.headers.get("X-CoDiscuss-Device"), "GET", "/api/machines") : null;
    const { results } = await database.prepare(`${MACHINE_SELECT} ORDER BY m.seen_at DESC, m.created_at DESC`).all();
    return respond({ machines: results.map(row => machine_view(row, now, signed?.machine_id === row.id)) });
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
  if (route === "api/health" && request.method === "GET") return respond({ ok: true });
  if (parts[1] === "admin") return handle_admin_api(database, request, parts, setup_key);
  if (parts[1] === "machines") return handle_remote_launch_api(database, request, parts, setup_key, relay);
  throw new HttpError(404, "地址不存在");
}

/** Dispatch Worker requests; everything outside /api is a static page asset. */
async function fetch_request(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  try {
    if (url.pathname === "/robots.txt") return respond("User-agent: *\nAllow: /\n", 200, true);
    if (parts[0] !== "api") return env.ASSETS.fetch(request);
    if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 501 });
    if (parts.length === 4 && parts[1] === "machines" && parts[3] === "relay") return await handle_relay(env, request, parts[2]);
    if (parts.length === 4 && parts[1] === "machines" && parts[3] === "pair") return await handle_pairing(env, request, parts[2]);
    return await handle_api(env.DB, request, parts, env.ADMIN_SETUP_KEY, env.RELAY ?? null);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return respond({ error: status === 500 ? "服务器内部错误" : error.message }, status);
  }
}

export default { fetch: fetch_request };
