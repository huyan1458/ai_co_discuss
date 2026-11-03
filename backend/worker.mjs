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

const ADMIN_ITERATIONS = 100000;
const ADMIN_LOCK_THRESHOLD = 5;
const ADMIN_LOCK_SECONDS = 300;
const ADMIN_AVATAR_LIMIT = 60000;

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

/** PBKDF2-HMAC-SHA256 as hex. */
async function pbkdf2_hex(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return to_hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** Format: pbkdf2_sha256$iterations$salt_hex$hash_hex. */
async function hash_password(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256$${ADMIN_ITERATIONS}$${to_hex(salt)}$${await pbkdf2_hex(password, salt, ADMIN_ITERATIONS)}`;
}

/** Check a password against a stored hash string. */
async function verify_password(password, stored) {
  const [scheme, iterations, salt_hex, expected] = String(stored).split("$");
  if (scheme !== "pbkdf2_sha256" || !/^([0-9a-f]{2})+$/.test(salt_hex ?? "")) return false;
  const salt = Uint8Array.from(salt_hex.match(/../g), pair => parseInt(pair, 16));
  return constant_time_equal(await pbkdf2_hex(password, salt, Number(iterations)), expected ?? "");
}

function admin_profile(row) {
  return row ? { username: row.username, avatar: row.avatar } : null;
}

function now_seconds() {
  return Math.floor(Date.now() / 1000);
}

/** Return the session row for the request header, or null; sessions never expire. */
async function admin_session(database, request) {
  const token = request.headers.get("X-Discussion-Admin") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return database.prepare("SELECT * FROM admin_sessions WHERE token_hash=?").bind(await digest_hex(token)).first();
}

async function require_admin_session(database, request) {
  const session = await admin_session(database, request);
  if (!session) throw new HttpError(401, "需要管理员登录");
  return session;
}

/** Create a session and return the raw token, which is never stored. */
async function create_admin_session(database) {
  const token = to_hex(crypto.getRandomValues(new Uint8Array(32)));
  await database.prepare("INSERT INTO admin_sessions (token_hash,created_at) VALUES (?,?)").bind(await digest_hex(token), now_seconds()).run();
  return token;
}

function admin_username(value) {
  const username = typeof value === "string" ? value.trim() : "";
  if (!username || text_length(username) > 30) throw new HttpError(400, "用户名须为 1–30 个字符");
  return username;
}

function admin_password(value, label = "密码") {
  if (typeof value !== "string" || text_length(value) < 8 || text_length(value) > 128) throw new HttpError(400, `${label}须为 8–128 个字符`);
  return value;
}

function admin_avatar(value) {
  if (typeof value !== "string" || (value && !value.startsWith("data:image/")) || value.length > ADMIN_AVATAR_LIMIT) {
    throw new HttpError(400, "头像须为 data:image/ 数据，且不超过 60000 字符；空字符串表示默认头像");
  }
  return value;
}

/** Reject while locked; otherwise verify the password and lock for a fixed time after repeated failures. */
async function check_admin_password(database, admin, password) {
  const now = now_seconds();
  if (admin.locked_until > now) throw new HttpError(429, `尝试次数过多，请 ${admin.locked_until - now} 秒后再试`);
  if (typeof password === "string" && await verify_password(password, admin.password_hash)) {
    await database.prepare("UPDATE site_admin SET failed_attempts=0, locked_until=0 WHERE id=1").run();
    return;
  }
  const locked = admin.failed_attempts + 1 >= ADMIN_LOCK_THRESHOLD;
  await database.prepare("UPDATE site_admin SET failed_attempts=?, locked_until=? WHERE id=1")
    .bind(locked ? 0 : admin.failed_attempts + 1, locked ? now + ADMIN_LOCK_SECONDS : 0).run();
  throw new HttpError(401, "用户名或密码错误");
}

async function admin_state(database, request, setup_key) {
  const admin = await database.prepare("SELECT * FROM site_admin WHERE id=1").first();
  const setup = !admin && !setup_key && await database.prepare("SELECT 1 FROM admin_setup WHERE id=1").first();
  // This website keeps no rooms; pages list the paired computer's rooms through the relay instead.
  return { computer_rooms: true, registered: Boolean(admin), setup_available: !admin && Boolean(setup_key || setup),
    logged_in: Boolean(await admin_session(database, request)), profile: admin_profile(admin) };
}

async function register_admin(database, request, payload, setup_key) {
  if (await database.prepare("SELECT 1 FROM site_admin WHERE id=1").first()) throw new HttpError(409, "管理员账号已存在");
  const setup = await database.prepare("SELECT token_hash FROM admin_setup WHERE id=1").first();
  if (!setup_key && !setup) throw new HttpError(503, "未配置安装令牌；请在部署网站的电脑运行 codiscuss token");
  const username = admin_username(payload.username), password = admin_password(payload.password);
  const supplied = await digest_hex(typeof payload.setup_key === "string" ? payload.setup_key.trim() : "");
  // Either the deployment secret or the one-time token written by `codiscuss token` registers.
  const matches = (setup_key && constant_time_equal(supplied, await digest_hex(String(setup_key)))) || (setup && constant_time_equal(supplied, setup.token_hash));
  if (!matches) throw new HttpError(403, "安装令牌错误");
  const hashed = await hash_password(password);
  try {
    await database.prepare("INSERT INTO site_admin (id,username,password_hash,avatar,created_at) VALUES (1,?,?,'',?)").bind(username, hashed, now_seconds()).run();
  } catch (error) {
    if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY")) throw new HttpError(409, "管理员账号已存在");
    throw error;
  }
  await database.prepare("DELETE FROM admin_setup").run();
  return { token: await create_admin_session(database), profile: { username, avatar: "" } };
}

async function login_admin(database, request, payload) {
  const admin = await database.prepare("SELECT * FROM site_admin WHERE id=1").first();
  const username = typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
  if (!admin) throw new HttpError(401, "用户名或密码错误");
  // The username is checked after the lock so a wrong name and a wrong password are indistinguishable.
  await check_admin_password(database, admin, username === admin.username.toLowerCase() ? payload.password : null);
  return { token: await create_admin_session(database), profile: admin_profile(admin) };
}

async function update_admin_profile(database, request, payload) {
  await require_admin_session(database, request);
  const admin = await database.prepare("SELECT * FROM site_admin WHERE id=1").first();
  const username = Object.hasOwn(payload, "username") ? admin_username(payload.username) : admin.username;
  const avatar = Object.hasOwn(payload, "avatar") ? admin_avatar(payload.avatar) : admin.avatar;
  await database.prepare("UPDATE site_admin SET username=?, avatar=? WHERE id=1").bind(username, avatar).run();
  return { profile: { username, avatar } };
}

async function logout_admin(database, request) {
  const session = await admin_session(database, request);
  if (session) await database.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(session.token_hash).run();
  return { ok: true };
}

/** Route /api/admin*; GET is public, every POST is JSON. */
async function handle_admin_api(database, request, parts, setup_key) {
  const action = parts[2] ?? "";
  if (parts.length === 2 && request.method === "GET") return respond(await admin_state(database, request, setup_key));
  if (parts.length !== 3 || request.method !== "POST") throw new HttpError(404, "地址不存在");
  const payload = await read_payload(request);
  if (action === "register") return respond(await register_admin(database, request, payload, setup_key), 201);
  if (action === "login") return respond(await login_admin(database, request, payload));
  if (action === "logout") return respond(await logout_admin(database, request));
  if (action === "profile") return respond(await update_admin_profile(database, request, payload));
  throw new HttpError(404, "地址不存在");
}

// Room launches relayed to a paired computer; same contract as backend/remote_launch.py.
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
const MACHINE_SELECT = "SELECT m.*, k.public_key FROM local_machines m LEFT JOIN machine_keys k ON k.machine_id=m.id";

/** Hash a machine token; malformed values hash to an empty string and never match. */
async function machine_token_digest(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? digest_hex(token) : "";
}

/** Public machine fields: projects by name and id, which platforms it can wake, and its command key if any. */
function machine_view(row, now) {
  return { id: row.id, name: row.name, projects: JSON.parse(row.projects), clients: JSON.parse(row.clients),
    public_key: row.public_key ? JSON.parse(row.public_key) : null, seen_at: row.seen_at, online: now - row.seen_at <= MACHINE_ONLINE_SECONDS };
}

/** Pair a computer or replace its token; called by the administrator's browser connected to that computer. */
async function pair_machine(database, payload, now) {
  const { id, token } = payload;
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const hashed = await machine_token_digest(token);
  if (typeof id !== "string" || !/^[0-9a-f]{32}$/.test(id) || !hashed) throw new HttpError(400, "电脑编号或凭据无效");
  if (name.length < 1 || name.length > MACHINE_NAME_MAX) throw new HttpError(400, `电脑名称需为 1–${MACHINE_NAME_MAX} 个字符`);
  await database.prepare("INSERT INTO local_machines (id,name,token_hash,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, token_hash=excluded.token_hash")
    .bind(id, name, hashed, now).run();
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

/** Record the computer's projects, clients and command key; launches queued for this website's own rooms no longer exist. */
async function machine_sync(database, machine_id, token, payload, now) {
  await require_machine(database, machine_id, token);
  const projects = valid_projects(payload.projects), clients = valid_clients(payload.clients);
  const public_key = "public_key" in payload ? valid_public_key(payload.public_key) : null;
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
    const credential = offered.find(item => /^[ma]\.[0-9a-f]{64}$/.test(item)) ?? "";
    let role = "machine";
    if (credential.startsWith("m.")) await require_machine(database, machine_id, credential.slice(2));
    else {
      await require_admin_session(database, new Request(request.url, { headers: { "X-Discussion-Admin": credential.slice(2) } }));
      await require_paired_machine(database, machine_id);
      role = "device";
    }
    const forwarded = new Request(request);
    forwarded.headers.set("X-Relay-Role", role);
    return relay.fetch(forwarded);
  }
  if (request.method !== "POST") throw new HttpError(404, "地址不存在");
  await require_admin_session(database, request);
  await require_paired_machine(database, machine_id);
  const { id, envelope, wait } = await read_payload(request);
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new HttpError(400, "命令编号无效");
  const answer = await relay.fetch("https://relay.internal/", { method: "POST", headers: { "Content-Type": "application/json", "X-Relay-Role": "request" },
    body: JSON.stringify({ id, envelope: valid_envelope(envelope, true), ...(Number.isInteger(wait) ? { wait } : {}) }) });
  return respond(await answer.json());
}

/** A paired computer that can already decrypt relayed commands. */
async function require_paired_machine(database, machine_id) {
  if (!await database.prepare("SELECT 1 AS found FROM local_machines WHERE id=?").bind(machine_id).first()) throw new HttpError(404, "这台电脑尚未连接网站");
  if (!await database.prepare("SELECT 1 AS found FROM machine_keys WHERE machine_id=?").bind(machine_id).first()) throw new HttpError(409, "这台电脑的 codiscuss 版本过旧，请更新后重试");
}

/** Pair computers and queue their commands; a computer authenticates with its own token, everything else as the administrator. */
async function handle_remote_launch_api(database, request, parts) {
  const now = now_seconds(), method = request.method;
  if (parts.length === 4 && parts[1] === "machines" && parts[3] === "sync" && method === "POST") {
    return respond(await machine_sync(database, parts[2], request.headers.get("X-Machine-Token") ?? "", await read_payload(request), now));
  }
  if (parts.length === 5 && parts[1] === "machines" && parts[3] === "commands" && method === "POST") {
    const token = request.headers.get("X-Machine-Token") ?? "", payload = await read_payload(request);
    return respond(parts[4] === "claim" ? await wait_machine_commands(database, parts[2], token, payload)
      : await finish_machine_command(database, parts[2], parts[4], token, payload, now));
  }
  await require_admin_session(database, request);
  if (parts[1] === "machines" && parts[3] === "commands") {
    if (parts.length === 4 && method === "POST") return respond(await submit_machine_command(database, parts[2], await read_payload(request), now));
    if (parts.length === 5 && method === "GET") return respond(await machine_command_status(database, parts[2], parts[4]));
    throw new HttpError(404, "地址不存在");
  }
  if (parts.length === 2 && parts[1] === "machines" && method === "GET") {
    const { results } = await database.prepare(`${MACHINE_SELECT} ORDER BY m.seen_at DESC, m.created_at DESC`).all();
    return respond({ machines: results.map(row => machine_view(row, now)) });
  }
  if (parts.length === 2 && parts[1] === "machines" && method === "POST") return respond(await pair_machine(database, await read_payload(request), now));
  throw new HttpError(404, "地址不存在");
}

async function handle_api(database, request, parts, setup_key = "") {
  const route = parts.join("/");
  if (route === "api/health" && request.method === "GET") return respond({ ok: true });
  if (parts[1] === "admin") return handle_admin_api(database, request, parts, setup_key);
  if (parts[1] === "machines") return handle_remote_launch_api(database, request, parts);
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
    return await handle_api(env.DB, request, parts, env.ADMIN_SETUP_KEY);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return respond({ error: status === 500 ? "服务器内部错误" : error.message }, status);
  }
}

export default { fetch: fetch_request };
