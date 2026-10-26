"use strict";

const REFRESH_INTERVAL_MS = 60000;
const FALLBACK_REFRESH_INTERVAL_MS = 12000;
const UPDATE_BATCH_MS = 100;
const UPDATE_DRAG_RETRY_MS = 500;
const TOAST_DURATION_MS = 3500;
const SCROLL_BOTTOM_THRESHOLD = 70;
const SUBMISSION_ID_BYTES = 16;
const MAX_MESSAGE_LENGTH = 32000;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 10;
const PDF_CANVAS_LIMIT = 4096;
const DIRECTORY_DRAG_THRESHOLD = 4;
const DIRECTORY_DRAG_OFFSET = 12;
const THEME_STORAGE_KEY = "ai-codiscuss-theme";
const DIRECTORY_SORT_KEY = "ai-codiscuss-directory-sort";
const LAUNCH_PENDING_PREFIX = "discuss-launch:";
const ADMIN_SESSION_KEY = "discuss-admin-session";
const ADMIN_USERNAME_MAX = 30;
const ADMIN_PASSWORD_MIN = 8;
const ADMIN_PASSWORD_MAX = 128;
const ADMIN_AVATAR_MAX_CHARS = 60000;
const ADMIN_AVATAR_SIZE = 96;
const ADMIN_AVATAR_QUALITY = 0.8;
const MEMBER_ACCESS_PREFIX = "discuss-members:";
const MEMBER_PENDING_PREFIX = "discuss-member-pending:";
const LOCAL_CONNECTION_KEY = "discuss-local-connection";
const LOCAL_CONNECTION_TIMEOUT_MS = 15000;
const MODEL_CATALOG_TIMEOUT_MS = 35000;
let local_connection = null;
const DEFAULT_USER_LABEL = "User";
const DEFAULT_USER_ICON = "/icons/user.svg";
const MANAGEMENT_LOGIN_HINT = "需要登录管理员账号或使用创建该房间的浏览器";
const THEMES = ["channel", "channel-light"];
const SOURCE_LABELS = { demo: "示例", user: "本人发言", proxy: "用户代发", cli: "CLI 发言", api: "API 发言", url: "历史 URL 发言", host_proxy: "主持人代发" };
const PHASE_LABELS = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", paused: "已暂停", concluded: "已收束" };
const TURN_LABELS = { pending: "待处理", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消" };
const PLATFORM_IDENTITIES = {
  "用户": { label: "User", initials: "U", style: "user", icon: "/icons/user.svg", description: "发起与协助" },
  Codex: { initials: "CX", style: "codex", icon: "/icons/openai.svg", description: "AI 身份" },
  Claude: { initials: "CL", style: "claude", icon: "/icons/claude.svg", description: "AI 身份" },
  Gemini: { initials: "GM", style: "gemini", icon: "/icons/gemini.svg", description: "AI 身份" },
  DeepSeek: { initials: "DS", style: "deepseek", icon: "/icons/deepseek.svg", description: "AI 身份" },
  Qwen: { initials: "QW", style: "qwen", icon: "/icons/qwen.svg", description: "AI 身份" },
  Grok: { initials: "GK", style: "grok", description: "AI 身份" },
};
const IDENTITIES = by_platform(PLATFORM_IDENTITIES, (identity, name) => ({ ...identity, label: name, description: "AI 实例" }));
const state = { rooms: [], folders: [], room: null, page: 1, pages: 1, query: "", mention_only: false, free_notice: "", free_error: "", order_error: null,
  free_proxy: "", create_parent: null, named_followup: false, create_discussion: false,
  archive_view: false, directory_sort: "manual", management: null, dragged_room: null, folder_moves: new Map(), folder_version: 0,
  reply_to: null, turn_reply_to: null, tab: "topic", refresh_version: 0, context_dirty: false, topic_dirty: false,
  snapshot_id: 0, pending_submission: null, pending_turn: null, pending_room: null, toast_timer: null,
  creation_mode: "brainstorm", creation_drafts: {}, access_notice: "", access_error: "" };
const live_updates = { source: null, connected: false, enabled: false, timer: null, poll_timer: null,
  running: false, dirty: false };
state.messages = [];
state.message_history = null;
state.connected = false;
state.attachment_drafts = [];
state.composer_error = "";
state.upload_status = "";
state.sending_message = false;
state.attachment_preview = null;
state.archive_changes = new Map();
state.archive_version = 0;
state.directory_error = "";
state.directory_notice = "";
state.directory_pending = new Map();
state.directory_version = 0;
state.navigation_version = 0;
state.admin = { loaded: false, local: false, registered: false, setup_available: false, logged_in: false, profile: null, identity_version: 0 };
state.launch = { available: false, remote: false, connect_command: "", profiles: {}, workspace: {}, scheduler: {}, create: true, error: "", notice: "", recoveries: [] };
const PLATFORM_CLIENTS = { Codex: [{ value: "codex_cli", label: "Codex CLI" }, { value: "codex", label: "Codex App" }],
  Claude: [{ value: "claude", label: "Claude Code CLI" }],
  Gemini: [{ value: "antigravity_cli", label: "Antigravity CLI" }, { value: "antigravity", label: "Antigravity App" }] };
for (const name of Object.keys(PLATFORM_IDENTITIES).filter(name => name !== "用户")) {
  (PLATFORM_CLIENTS[name] ||= []).push({ value: "api", label: `${name === "Codex" ? "OpenAI" : name} API` });
}
// A platform is a type; `Claude-评审` is another instance of it. Lookups by instance name fall back to the
// platform, while iteration still lists the platforms only.
const INSTANCE_PATTERN = /^(Codex|Claude|Gemini|DeepSeek|Qwen|Grok)(?:-[0-9A-Za-z_\u4e00-\u9fff]{1,16})?$/;
/** The platform of an AI instance name, or null for the user and invalid names. */
function platform_of(name) { return INSTANCE_PATTERN.exec(String(name))?.[1] ?? null; }
/** Resolve instance names to their platform's entry without listing instances as keys. */
function by_platform(table, decorate = entry => entry) {
  return new Proxy(table, { get: (target, name) => Object.hasOwn(target, name) || typeof name !== "string" ? target[name]
    : platform_of(name) && target[platform_of(name)] ? decorate(target[platform_of(name)], name) : undefined });
}
const LAUNCH_CLIENTS = by_platform(PLATFORM_CLIENTS);

/** Return a DOM element by its stable ID. */
function element(id) { return document.getElementById(id); }

/** Apply a visual theme without replacing content or changing discussion state. */
function apply_theme(theme) {
  const selected = THEMES.includes(theme) ? theme : "channel";
  document.documentElement.dataset.theme = selected;
  document.documentElement.classList.toggle("dark", selected === "channel");
  if (!document.getElementById("modern-script")) {
    const script = document.createElement("script");
    script.id = "modern-script";
    script.type = "module";
    script.src = "/modern.js";
    document.head.append(script);
  }
  publish_view();
}

/** Restore the local preference before the stylesheet and page content load. */
function restore_theme() {
  let theme = "channel";
  try { theme = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  change_view_theme(theme);
}

/** Escape untrusted message content before inserting presentation markup. */
function escape_html(value) {
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(value ?? "").replace(/[&<>"']/g, (character) => entities[character]);
}

/** Format a server timestamp in the viewer's local timezone. */
function format_time(value) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

/** Display operation feedback only in the classic renderer. */
function show_toast(message, is_error = false) {
  if (document.documentElement.dataset.theme.startsWith("channel")) return;
  clearTimeout(state.toast_timer);
  element("toast").textContent = message;
  element("toast").classList.toggle("error", is_error);
  element("toast").hidden = false;
  state.toast_timer = setTimeout(() => { element("toast").hidden = true; }, TOAST_DURATION_MS);
}

/** The administrator session token kept by this browser, or an empty string. */
function admin_token() {
  if (state.admin.local) return "";
  try { return localStorage.getItem(ADMIN_SESSION_KEY) || ""; } catch { return ""; }
}

/** Store or clear the administrator session token; storage failures only lose persistence. */
function store_admin_token(token) {
  try { token ? localStorage.setItem(ADMIN_SESSION_KEY, token) : localStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* Keep the session in memory only. */ }
}

/** The administrator header for writes that bypass request_json, or no header without a session. */
function admin_headers() {
  const session = admin_token();
  return session ? { "X-Discussion-Admin": session } : {};
}

/** Request JSON from the local or remotely hosted discussion service. */
async function request_json(path, payload, access_token) {
  const options = { cache: "no-store" };
  const target_room = path.match(/^\/api\/rooms\/([^/?]+)/)?.[1];
  const token = access_token || (target_room ? localStorage.getItem(`discuss-access:${target_room}`) : null);
  const session = admin_token();
  options.headers = token ? { "X-Discussion-Token": token } : {};
  if (session) options.headers["X-Discussion-Admin"] = session;
  if (payload !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "请求失败，请重试"), { preflight: response.status >= 400 && response.status < 500, status: response.status });
  return result;
}

/** The owner's public name and avatar replace the default "User" identity for every visitor. */
function apply_admin_identity(profile) {
  Object.assign(PLATFORM_IDENTITIES["用户"], { label: profile?.username || DEFAULT_USER_LABEL, icon: profile?.avatar || DEFAULT_USER_ICON });
  state.admin.identity_version++;
  if (!element("participants")) return;
  for (const id of ["author-select", "topic-host-select", "new-room-host"]) {
    const option = Array.from(element(id)?.options || []).find(item => item.value === "用户");
    if (option) option.textContent = display_name("用户");
  }
  render_participants();
}

/** Record the server's administrator state and refresh every identity-dependent view without a reload. */
function apply_admin_state(info) {
  const local = info.local === true;
  if (local || !info.logged_in) store_admin_token("");
  Object.assign(state.admin, { loaded: true, local, registered: Boolean(info.registered), setup_available: Boolean(info.setup_available),
    logged_in: Boolean(info.logged_in), profile: info.profile ? { username: info.profile.username, avatar: info.profile.avatar || "" } : null });
  apply_admin_identity(state.admin.profile);
  publish_view();
}

/** Read the public administrator state; a failure leaves the visitor view unchanged. */
async function load_admin_state() {
  try { apply_admin_state(await request_json("/api/admin")); }
  catch { /* The directory request reports connection problems. */ }
}

/** Return the first problem with an administrator form, matching the server's limits. */
function validate_admin_form({ username, password, confirm, check_password = true }) {
  const name_length = [...String(username ?? "").trim()].length;
  if (username !== undefined && (name_length < 1 || name_length > ADMIN_USERNAME_MAX)) return `用户名需要 1–${ADMIN_USERNAME_MAX} 个字符`;
  if (!check_password) return "";
  const length = [...String(password ?? "")].length;
  if (length < ADMIN_PASSWORD_MIN || length > ADMIN_PASSWORD_MAX) return `密码需要 ${ADMIN_PASSWORD_MIN}–${ADMIN_PASSWORD_MAX} 个字符`;
  if (confirm !== undefined && confirm !== password) return "两次输入的密码不一致";
  return "";
}

/** Keep the Chinese server message and add a retry hint when a locked response lacks the delay. */
function admin_error(error) {
  if (error.status === 429 && !/\d/.test(error.message)) error.message += "，请稍后再试";
  return error;
}

/** Store the new session and show the owner's identity. */
function accept_admin_session({ token, profile }) {
  store_admin_token(token);
  apply_admin_state({ registered: true, setup_available: false, logged_in: true, profile });
}

/** Create the single administrator account and sign in with it. */
async function register_admin({ username, password, confirm, setup_key }) {
  const problem = validate_admin_form({ username, password, confirm }) || (String(setup_key ?? "").trim() ? "" : "请填写安装令牌");
  if (problem) throw new Error(problem);
  try { accept_admin_session(await request_json("/api/admin/register", { username: username.trim(), password, setup_key: setup_key.trim() })); }
  catch (error) { throw admin_error(error); }
}

/** Sign in and keep the session in this browser. */
async function login_admin({ username, password }) {
  if (!String(username ?? "").trim() || !password) throw new Error("请填写用户名和密码");
  try { accept_admin_session(await request_json("/api/admin/login", { username: username.trim(), password })); }
  catch (error) { throw admin_error(error); }
}

/** Leave this browser; the local session is dropped even if the server cannot be reached. */
async function logout_admin() {
  try { await request_json("/api/admin/logout", {}); }
  catch { /* The token is removed below either way. */ }
  store_admin_token("");
  state.admin.logged_in = false;
  publish_view();
}

/** Save the display name and/or avatar; an empty avatar restores the default. */
async function update_admin_profile(patch) {
  if (patch.username !== undefined) {
    const problem = validate_admin_form({ username: patch.username, check_password: false });
    if (problem) throw new Error(problem);
    patch = { ...patch, username: patch.username.trim() };
  }
  const result = await request_json("/api/admin/profile", patch);
  apply_admin_state({ local: state.admin.local, registered: true, setup_available: false, logged_in: true, profile: result.profile });
}

/** Shrink the chosen image into a small square data URL that fits the server limit. */
async function admin_avatar_from_file(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("请选择图片文件");
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const loaded = new Image();
      loaded.onload = () => resolve(loaded);
      loaded.onerror = () => reject(new Error("无法读取这张图片"));
      loaded.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("无法读取这张图片");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ADMIN_AVATAR_SIZE;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, ADMIN_AVATAR_SIZE, ADMIN_AVATAR_SIZE);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, ADMIN_AVATAR_SIZE, ADMIN_AVATAR_SIZE);
    const data_url = canvas.toDataURL("image/jpeg", ADMIN_AVATAR_QUALITY);
    if (data_url.length > ADMIN_AVATAR_MAX_CHARS) throw new Error("图片过大，请换一张");
    return data_url;
  } finally { URL.revokeObjectURL(url); }
}

/** Explain why a management write failed when this browser has neither credential. */
function management_error_message(room_id, error) {
  if (error.status === 403 && !state.admin.logged_in && !localStorage.getItem(`discuss-access:${room_id}`)) return MANAGEMENT_LOGIN_HINT;
  return error.message;
}

/** Show connection state without claiming that any AI is online. */
function set_connection(connected) {
  state.connected = connected;
  element("connection-dot").className = `status-dot ${connected ? "connected" : "failed"}`;
  element("connection-status").textContent = connected ? "讨论网站已连接" : "网站连接中断，可手动刷新";
  publish_view();
}

/** Copy text, including on plain HTTP deployments without Clipboard API access. */
async function copy_text(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand("copy");
    helper.remove();
    if (!copied) throw new Error("浏览器未允许自动复制，请手动选择内容复制");
  }
  show_toast("已复制");
}

/** Create a submission identifier even on non-secure HTTP origins. */
function new_submission_id() {
  const bytes = new Uint8Array(SUBMISSION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** Resolve a UI label without changing stored identity values. */
function display_name(name) { return IDENTITIES[name]?.label || name; }

/** Render an identity avatar from a local SVG. */
function identity_avatar(identity) {
  return identity.icon ? `<img src="${escape_html(identity.icon)}" alt="">` : identity.initials;
}

/** Render identity controls and distinguish selectable identities from connections. */
function render_identities() {
  const options = Object.keys(IDENTITIES).map((name) => `<option value="${name}">${escape_html(display_name(name))}</option>`).join("");
  element("author-select").innerHTML = options;
  element("topic-host-select").innerHTML = options;
  element("new-room-host").innerHTML = options;
  render_expert_inputs("new-expert-modes", default_experts());
  render_participants();
}

/** List the selectable identities in the classic sidebar. */
function render_participants() {
  element("participants").innerHTML = Object.entries(IDENTITIES).map(([name, identity]) =>
    `<div class="participant ${identity.style}"><span class="avatar" aria-hidden="true">${identity_avatar(identity)}</span><span class="participant-name">${escape_html(display_name(name))}</span><span class="participant-role">${identity.description}</span></div>`).join("");
}

/** Render rooms while retaining the selected room. */
function render_rooms() {
  const rooms = visible_rooms();
  element("room-count").textContent = rooms.length;
  element("archive-toggle").textContent = state.archive_view ? "返回讨论频道" : `已存档 (${state.rooms.filter((room) => room.archived).length})`;
  element("archive-toggle").setAttribute("aria-pressed", String(state.archive_view));
  element("room-list").innerHTML = rooms.map((room, index) =>
    `<div class="directory-row" data-drag-room="${room.id}"><button type="button" class="directory-grip" data-drag-handle aria-label="拖动 ${escape_html(room.title)}" title="拖动排序；上下方向键移动">⠿</button><button class="room-item ${room.id === state.room?.id ? "active" : ""}" data-room="${room.id}" title="${escape_html(room.title)}"><span class="room-item-name">${escape_html(room.title)}</span><span class="room-item-number">${room.message_count}</span></button><details class="room-actions"><summary aria-label="管理 ${escape_html(room.title)}">⋯</summary><div>${room_menu_html(room, index, rooms.length)}</div></details></div>`).join("") || "<p class='local-note'>这里还没有频道。</p>";
  if (state.creating_room) element("room-list").innerHTML += `<p class="local-note">正在创建：${escape_html(state.creating_room.title)}</p>`;
  element("new-room").disabled = state.directory_pending.has("create-room");
  element("no-room").hidden = Boolean(state.room);
  element("room-content").hidden = !state.room;
  element("copy-reading").disabled = !state.room;
  element("backup-room").disabled = !state.room || state.backup_pending;
  element("go-context").disabled = !state.room;
}

/** Return the active directory without hiding archived rooms from deep links. */
function visible_rooms() {
  return ordered_rooms().filter((room) => !room.archived);
}

/** Sort the displayed conversations without overwriting their saved manual order. */
function ordered_rooms() {
  if (state.directory_sort !== "recent") return state.rooms;
  return [...state.rooms].sort((left, right) => (right.latest_id || 0) - (left.latest_id || 0)
    || (right.created_at || "").localeCompare(left.created_at || ""));
}

/** Restore a supported local directory preference before rendering. */
function restore_directory_sort() {
  try { state.directory_sort = localStorage.getItem(DIRECTORY_SORT_KEY) === "recent" ? "recent" : "manual"; }
  catch { state.directory_sort = "manual"; }
}

/** Change presentation order while preserving the current conversation and draft. */
function sort_directory(value) {
  if (!["manual", "recent"].includes(value)) return;
  state.directory_sort = value;
  try { localStorage.setItem(DIRECTORY_SORT_KEY, value); } catch { /* Keep the session preference. */ }
  render_rooms();
  publish_view();
}

/** Provide pointer and keyboard alternatives to dragging in the classic theme. */
function room_menu_html(room, index, count) {
  const ordering = state.directory_pending.has("room-order");
  return [["rename", "重命名", state.directory_pending.has(`rename:${room.id}`)], ["backup", "导出对话", state.backup_pending], [room.archived ? "restore" : "archive", room.archived ? "恢复频道" : "存档频道", state.archive_changes.has(room.id)],
    ["up", "上移", ordering || state.directory_sort === "recent" || index === 0], ["down", "下移", ordering || state.directory_sort === "recent" || index === count - 1], ["delete", "删除频道", state.directory_pending.has(`rename:${room.id}`)]]
    .map(([action, label, disabled]) => `<button type="button" data-manage-room="${room.id}" data-room-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`).join("");
}

/** Switch only the directory filter, preserving the open conversation and drafts. */
function toggle_archives() { state.archive_view = !state.archive_view; render_rooms(); publish_view(); }

/** Dispatch directory changes without waiting for unrelated reads. */
async function manage_channel({ id, action, title, before_id, folder_id }) {
  if (action === "folder") return assign_channel_folder(id, folder_id ?? null);
  if (["archive", "restore"].includes(action)) return archive_channel(id, action === "archive");
  if (action === "rename") return rename_channel(id, title);
  if (action === "move") return reorder_channel(id, before_id);
  if (action === "delete") return delete_channel(id);
}

/** Save an optimistic directory edit with a lock limited to its affected resource. */
async function update_directory(change) {
  if (state.directory_pending.has(change.key)) return;
  state.directory_pending.set(change.key, change);
  state.directory_version++;
  state.directory_error = "";
  change.apply();
  render_rooms();
  publish_view();
  try {
    const saved = await change.save();
    change.commit?.(saved);
    return saved;
  } catch (error) {
    change.rollback();
    state.directory_error = change.error_message?.(error) || `${change.label}失败，已恢复原状态：${error.message}`;
    throw error;
  } finally {
    state.directory_pending.delete(change.key);
    state.directory_version++;
    render_rooms();
    if (state.room?.experts) render_room();
    publish_view();
  }
}

/** Patch only the selected room fields, retaining unrelated metadata and drafts. */
function patch_directory_room(id, patch) {
  state.rooms = state.rooms.map(room => room.id === id ? { ...room, ...patch } : room);
  if (state.room?.id === id) { state.room = { ...state.room, ...patch }; if (state.room.experts) render_room(); }
}

/** Reapply an ID order to current objects, retaining new items and later metadata. */
function directory_order(items, ids) {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort((left, right) => (positions.get(left.id) ?? ids.length) - (positions.get(right.id) ?? ids.length));
}

/** Move one existing item before another, or to the end of the list. */
function move_directory_item(items, id, before_id) {
  const moving = items.find(item => item.id === id);
  const remaining = items.filter(item => item.id !== id);
  const index = before_id == null ? remaining.length : remaining.findIndex(item => item.id === before_id);
  if (!moving || index < 0) return items;
  remaining.splice(index, 0, moving);
  return remaining;
}

/** Rename immediately, then merge only the name returned by the server. */
async function rename_channel(id, title) {
  const room = state.rooms.find(item => item.id === id);
  if (!room || !title?.trim()) return;
  const patch = { title: title.trim() };
  return update_directory({ key: `rename:${id}`, patch, label: `「${room.title}」重命名`,
    apply: () => patch_directory_room(id, patch), rollback: () => patch_directory_room(id, { title: room.title }),
    save: () => request_json(`/api/rooms/${id}/topic`, { actor: "用户", ...patch }),
    commit: saved => patch_directory_room(id, { title: saved.title }) });
}

/** Show the new room order before its single write completes. */
async function reorder_channel(id, before_id) {
  const previous = state.rooms.map(room => room.id);
  return update_directory({ key: "room-order", label: "频道排序",
    apply: () => { state.rooms = move_directory_item(state.rooms, id, before_id); },
    rollback: () => { state.rooms = directory_order(state.rooms, previous); },
    save: () => request_json(`/api/rooms/${id}/move`, { actor: "用户", before_id }) });
}

/** Hide a confirmed deletion immediately and restore only that entry on failure. */
async function delete_channel(id) {
  const room = state.rooms.find(item => item.id === id);
  if (!room) return;
  const previous = state.rooms.map(item => item.id);
  return update_directory({ key: `delete:${id}`, label: `「${room.title}」删除`,
    error_message: error => `「${room.title}」删除失败，已恢复原状态：${management_error_message(id, error)}`,
    apply: () => {
      state.rooms = state.rooms.filter(item => item.id !== id);
      if (state.room?.id === id) run_action(() => select_room(visible_rooms()[0]?.id));
    },
    rollback: () => { state.rooms = directory_order([...state.rooms, room], previous); },
    save: () => request_json(`/api/rooms/${id}/delete`, { actor: "用户", confirm_title: room.title }) });
}

/** Keep pending or newer archive changes when an older read finishes. */
function merge_room_archive(room, version) {
  const current = state.archive_changes.get(room.id)
    || (version !== state.archive_version && state.rooms.find((item) => item.id === room.id));
  return current ? { ...room, archived: current.archived, phase: current.phase ?? room.phase } : room;
}

/** Update archive fields without replacing newer metadata, navigation or drafts. */
function display_channel_archive(id, change, expected) {
  const update = (room) => ({ ...room, archived: change.archived,
    phase: change.phase === undefined || (expected?.phase !== undefined && room.phase !== expected.phase) ? room.phase : change.phase });
  state.rooms = state.rooms.map((room) => room.id === id ? update(room) : room);
  if (state.room?.id === id) { state.room = update(state.room); if (state.room.experts) render_room(); }
  render_rooms();
  publish_view();
}

/** Move a channel immediately and reconcile only its archive fields after saving. */
async function archive_channel(id, archived) {
  const room = state.room?.id === id ? state.room : state.rooms.find((item) => item.id === id);
  if (!room || state.archive_changes.has(id) || Boolean(room.archived) === archived) return;
  const previous = { archived: Boolean(room.archived), phase: room.phase };
  const change = { archived, phase: archived && room.phase && room.phase !== "concluded" ? "paused" : room.phase };
  state.archive_changes.set(id, change);
  state.archive_version++;
  state.directory_error = "";
  display_channel_archive(id, change);
  try {
    const saved = await request_json(`/api/rooms/${id}/${archived ? "archive" : "restore"}`, { actor: "用户" });
    display_channel_archive(id, { archived: Boolean(saved.archived), phase: saved.phase }, change);
  } catch (error) {
    state.directory_error = `「${room.title}」${archived ? "存档" : "恢复"}失败，已恢复原状态：${management_error_message(id, error)}`;
    display_channel_archive(id, previous, change);
    throw error;
  } finally {
    state.archive_changes.delete(id);
    state.archive_version++;
    publish_view();
  }
}

/** Merge fresh room data without undoing directory changes newer than the read. */
function merge_room_folder(room, version, archive_version, directory_version) {
  room = merge_room_archive(room, archive_version);
  const current_name = directory_version !== state.directory_version && state.rooms.find(item => item.id === room.id);
  const patch = state.directory_pending.get(`rename:${room.id}`)?.patch || (current_name && { title: current_name.title });
  if (patch) room = { ...room, ...patch };
  if (state.folder_moves.has(room.id)) return { ...room, folder_id: state.folder_moves.get(room.id) };
  const current = version !== state.folder_version && state.rooms.find((item) => item.id === room.id);
  return current ? { ...room, folder_id: current.folder_id ?? null } : room;
}

/** Change only folder placement, preserving the current conversation and drafts. */
function display_channel_folder(id, folder_id) {
  state.rooms = state.rooms.map((room) => room.id === id ? { ...room, folder_id } : room);
  if (state.room?.id === id) state.room = { ...state.room, folder_id };
  render_rooms();
  publish_view();
}

/** Show a folder move immediately, then confirm or restore it from the write result. */
async function assign_channel_folder(id, folder_id) {
  const room = state.rooms.find((item) => item.id === id);
  if (!room || state.folder_moves.has(id) || (room.folder_id ?? null) === folder_id) return;
  const previous_folder = room.folder_id ?? null;
  if (state.folders.some(folder => folder.id === folder_id && folder.pending)) return;
  if (folder_id && state.directory_pending.get("folder-order")?.removed_folder === folder_id) return;
  state.directory_error = "";
  state.folder_moves.set(id, folder_id);
  state.folder_version++;
  display_channel_folder(id, folder_id);
  try {
    const saved = await request_json(`/api/rooms/${id}/folder`, { actor: "用户", folder_id });
    display_channel_folder(id, saved.folder_id ?? null);
    show_toast("话题归类已更新");
  } catch (error) {
    state.directory_error = `「${room.title}」归类失败，已恢复原状态：${error.message}`;
    display_channel_folder(id, previous_folder);
    throw error;
  } finally {
    state.folder_moves.delete(id);
    state.folder_version++;
  }
}

/** Display a provisional folder while its identifier is being assigned. */
async function create_folder(name) {
  const folder = { id: `pending-${new_submission_id()}`, name: name.trim(), pending: true };
  return update_directory({ key: "create-folder", label: `文件夹「${folder.name}」创建`,
    apply: () => { state.folders = [...state.folders, folder]; },
    rollback: () => { state.folders = state.folders.filter(item => item.id !== folder.id); },
    save: () => request_json("/api/folders", { name: folder.name }),
    commit: saved => { state.folders = state.folders.map(item => item.id === folder.id ? saved : item); } });
}

/** Rename the exact folder without moving its conversations or changing selection. */
async function rename_folder({ id, name }) {
  const folder = state.folders.find(item => item.id === id);
  if (!folder || folder.pending || !name.trim()) return;
  const display = value => { state.folders = state.folders.map(item => item.id === id ? { ...item, name: value } : item); };
  return update_directory({ key: `folder-name:${id}`, label: `文件夹「${folder.name}」重命名`,
    apply: () => display(name.trim()), rollback: () => display(folder.name),
    save: () => request_json(`/api/folders/${encodeURIComponent(id)}/rename`, { name: name.trim() }),
    commit: saved => display(saved.name) });
}

/** Remove only a grouping; keep its conversations, current transcript and drafts. */
async function delete_folder(id) {
  const folder = state.folders.find(item => item.id === id);
  const members = state.rooms.filter(room => room.folder_id === id).map(room => room.id);
  if (!folder || folder.pending || state.directory_pending.has("folder-order")
    || state.directory_pending.has(`folder-name:${id}`) || state.directory_pending.has("create-folder")
    || state.creating_room?.folder_id === id || members.some(room_id => state.folder_moves.has(room_id))) return;
  const previous = state.folders.map(item => item.id);
  const position = state.uncategorized_position;
  members.forEach(room_id => state.folder_moves.set(room_id, null));
  state.folder_version++;
  try {
    return await update_directory({ key: "folder-order", removed_folder: id, label: `文件夹「${folder.name}」移除`,
      apply: () => {
        state.folders = state.folders.filter(item => item.id !== id);
        if (position != null) {
          const next = position - Number(previous.indexOf(id) < position);
          state.uncategorized_position = next < state.folders.length ? next : null;
        }
        members.forEach(room_id => patch_directory_room(room_id, { folder_id: null }));
      },
      rollback: () => {
        state.folders = directory_order([...state.folders, folder], previous);
        state.uncategorized_position = position;
        members.forEach(room_id => patch_directory_room(room_id, { folder_id: id }));
      },
      save: () => request_json(`/api/folders/${encodeURIComponent(id)}/delete`, {}) });
  } finally {
    members.forEach(room_id => state.folder_moves.delete(room_id));
    state.folder_version++;
    publish_view();
  }
}

/** Apply folder order and the virtual group's placement together. */
function set_folder_directory(directory) {
  state.folders = directory.folders || [];
  state.uncategorized_position = directory.uncategorized_position ?? null;
}

/** Include the virtual group in ordering while keeping its room assignment empty. */
function ordered_folders() {
  const groups = state.folders.map((folder) => ({ ...folder, order_id: folder.id }));
  groups.splice(state.uncategorized_position ?? groups.length, 0, { id: "", order_id: "__uncategorized__", name: "未归类" });
  return groups;
}

/** Persist a folder's position without changing its contents or the open draft. */
async function move_folder({ id, before_id, direction }) {
  if (state.folder_order_pending || state.folders.some(folder => folder.pending)) return;
  const groups = ordered_folders();
  const index = groups.findIndex((folder) => folder.order_id === id);
  if (index < 0) return;
  if (direction !== undefined) {
    if (direction < 0 ? index === 0 : index === groups.length - 1) return;
    before_id = groups[direction < 0 ? index - 1 : index + 2]?.order_id ?? null;
  }
  if (before_id === id) return;
  const previous = groups.map(folder => folder.order_id);
  const reorder = ids => {
    const ordered = directory_order(ordered_folders().map(folder => ({ ...folder, id: folder.order_id })), ids);
    state.uncategorized_position = ordered.findIndex(folder => folder.id === "__uncategorized__");
    state.folders = ordered.filter(folder => folder.id !== "__uncategorized__");
  };
  const next = move_directory_item(groups.map(folder => ({ ...folder, id: folder.order_id })), id, before_id).map(folder => folder.id);
  state.folder_order_pending = true;
  try {
    await update_directory({ key: "folder-order", label: "文件夹排序", apply: () => reorder(next), rollback: () => reorder(previous),
      save: () => request_json(`/api/folders/${encodeURIComponent(id)}/move`, { before_id }) });
  } finally { state.folder_order_pending = false; publish_view(); }
}

/** Move a channel by one visible slot, also available without drag support. */
async function move_channel({ id, direction, folder_id }) {
  if (state.directory_sort === "recent") return;
  const rooms = visible_rooms();
  const folder_scoped = folder_id !== undefined;
  const group = folder_scoped ? rooms.filter((room) => (room.folder_id || null) === folder_id) : rooms;
  const index = group.findIndex((room) => room.id === id);
  if (index < 0 || (direction < 0 ? index === 0 : index === group.length - 1)) return;
  const without_room = rooms.filter((room) => room.id !== id);
  const neighbor = group[direction < 0 ? index - 1 : index + 1];
  const neighbor_index = without_room.findIndex((room) => room.id === neighbor.id);
  const before_id = direction < 0 ? neighbor.id : without_room[neighbor_index + 1]?.id ?? null;
  await manage_channel({ id, action: "move", before_id });
}

/** Update persistent room metadata without overwriting a manually edited state draft. */
function render_room() {
  if (!state.room) return;
  const room = state.room;
  element("room-title").textContent = room.title;
  element("room-subtitle").textContent = `${room.archived ? '已存档 · ' : ''}${room.message_count} 条发言`;
  element("message-count").textContent = room.message_count;
  element("room-goal").textContent = room.goal || "尚未填写议题目标。";
  element("latest-id").textContent = `#${room.latest_id}`;
  element("state-version").textContent = `整理至 #${room.state_until}`;
  element("state-update-note").textContent = `当前记录至 #${room.latest_id}；保存后标记为本次打开的 #${state.snapshot_id}。`;
  if (!state.context_dirty) {
    element("state-input").value = room.state_text;
    element("brief-input").value = room.host_brief?.text || "";
    state.snapshot_id = room.latest_id;
    element("state-update-note").textContent = `保存时标记整理至 #${state.snapshot_id}，原始发言保持不变。`;
  }
  render_access();
  render_topic();
  render_host_brief();
  update_composer_role();
}

/** A round completes only after all configured experts have contributed. */
function progress_round(room) {
  const groups = round_groups(room);
  if (!groups) return "轮次待同步";
  const latest = groups.at(-1);
  const participants = Object.keys(room.experts).length;
  const completed = groups.filter((item) => item.completed).length;
  if (latest && !latest.completed) return `第 ${latest.number} 轮 · ${latest.opinions ?? latest.speakers.length}/${participants} 人已发言`;
  return ["pending", "notified"].includes(room.current_turn?.status)
    ? `第 ${completed + 1} 轮 · 0/${participants} 人已发言` : `已完成 ${completed} 轮`;
}

/** Rounds as labelled in the UI: counted by the round budget when the room has one, otherwise by the roster. */
function round_groups(room) {
  return Array.isArray(room.round_groups) ? room.round_groups : Array.isArray(room.rounds) ? room.rounds : null;
}

/** Describe the designated respondent without claiming that their app is generating. */
function progress_speaker(room) {
  const turn = room.current_turn;
  if (room.phase === "concluded") return "讨论已收束";
  if (room.phase === "paused") return `已暂停${turn && ["pending", "notified"].includes(turn.status) ? ` · 原安排 ${turn.expert}` : ""}`;
  if (turn && ["pending", "notified"].includes(turn.status)) return `等待 ${turn.expert} 回答 · ${turn_label(turn, room)}`;
  return room.rounds?.length || room.answered_turns || turn?.status === "answered" ? "等待主持人安排下一步" : "尚未开始发言";
}

/** Explain an empty transcript using the room's actual progression state. */
function empty_discussion_message(room) {
  if (room.archived || room.phase === 'concluded') return '讨论已结束，尚未产生发言记录。';
  if (room.mode === 'free') return '写下任务并点名成员。程序唤醒由本机服务交付；手动成员需在原会话触发，在线回答由人代发。';
  if (room.phase === 'paused' || room.runtime?.status === 'paused') return '讨论已暂停。核对暂停原因后，可在进度看板重启或结束。';
  if (room.runtime?.mode === 'automatic') {
    if (room.runtime.status === 'ready') return '讨论尚未启动。请在接入页核对软件配置并启动。';
    if (room.runtime.status === 'stopped') return '自动推进已停止，尚未产生发言记录。';
    return room.runtime.latest_execution?.status === 'started' ? 'AI 已进入执行，等待第一条讨论记录。' : '自动推进已启用，等待 AI 执行；可在接入页核对实际进展。';
  }
  return '这是讨论的开始。发送问题，或从接入页邀请参与者。';
}

/** Keep a saved brief's evidence cutoff visible next to the live assignment status. */
function brief_meta(room) {
  const brief = room.host_brief;
  return brief?.text ? `${display_name(room.host)} 主持 · ${new Date(brief.updated_at).toLocaleString("zh-CN")} 更新 · 整理至 #${brief.until}` : `${display_name(room.host)} 主持 · 尚未发布简报`;
}

/** Render the host's own concise account, independently from the full state editor. */
function render_host_brief() {
  const room = state.room;
  element("host-brief-panel").hidden = !room;
  if (!room) return;
  room.rendered_brief = window.discuss_markdown.render_markdown(room.host_brief?.text || "主持人尚未更新结论、共识、歧义与下一步意图。");
  element("progress-round").textContent = progress_round(room);
  element("progress-speaker").textContent = progress_speaker(room);
  element("host-brief-text").innerHTML = room.rendered_brief;
  element("host-brief-meta").textContent = brief_meta(room);
}

/** Describe roles separately from authors and the actual submitter. */
function message_provenance(message) {
  const role = message.kind === "receipt" ? "运行回执" : message.kind === "moderation" ? "主持发言" : (message.author === "用户" ? "用户发言" : "专家观点");
  const forwarding = message.submitted_by && message.submitted_by !== message.author ? ` · ${display_name(message.submitted_by)} 代发` : "";
  const turn = message.turn_id ? ` · 回答安排 #${message.turn_id}` : "";
  return `${role}${forwarding}${turn}`;
}

/** Build compact chat lines with colored names, reply references, and provenance. */
function message_markup(message) {
  const identity = IDENTITIES[message.author] || IDENTITIES["用户"];
  const body = message.kind === "receipt" ? `<details class="message-receipt" data-receipt-id="${message.id}"><summary aria-label="查看运行回执 #${message.id}">运行回执详情</summary>${message.rendered_text}</details>` : message.summary ? `<div class="answer-summary"><small>回答摘要 · ${escape_html(display_name(message.summary_by))}</small>${message.rendered_summary}</div><details class="message-answer" data-answer-id="${message.id}"><summary aria-label="展开完整回答 #${message.id}">完整回答</summary>${message.rendered_text}</details>` : message.rendered_text;
  const text = body + attachment_markup(message.attachments);
  const reply = message.reply_to ? `<button class="quote-link" data-detail="${message.reply_to}">↳ 回复 #${message.reply_to} · 查看原文</button>` : "";
  return `<article class="message ${identity.style}" id="message-${message.id}"><span class="avatar message-avatar" aria-hidden="true">${identity_avatar(identity)}</span><div class="message-line"><time title="${escape_html(message.created_at)}">[${format_time(message.created_at)}]</time><strong class="message-author">${escape_html(display_name(message.author))}</strong><span class="message-verb"> 说：</span><div class="message-text markdown-body">${text}</div></div><div class="message-details"><span class="source-badge ${message.source === "demo" ? "" : "real"}">${SOURCE_LABELS[message.source] || "发言"}</span><span>${escape_html(message_provenance(message))}</span><button class="message-id" data-detail="${message.id}">#${message.id}</button>${reply}<span class="message-actions"><button data-reply="${message.id}" data-author="${escape_html(message.author)}">回复</button><button data-copy-message="${message.id}">复制原文链接</button></span></div></article>`;
}

/** Render continuous history while retaining expanded answers and reading position. */
function render_messages(result) {
  const previous = new Map(state.messages.map((message) => [message.id, message]));
  const requests = new Map((state.room?.free?.requests || []).map(request => [`${request.message_id}:${request.member_id}`, request]));
  state.messages = result.messages.map((message) => {
    const saved = previous.get(message.id);
    const suggestions = (saved?.suggestions || message.suggestions || []).map(suggestion => {
      const request = requests.get(`${message.id}:${suggestion.member_id}`);
      return request && suggestion.request_id !== request.id ? { ...suggestion, request_id: request.id } : suggestion;
    });
    if (saved) return suggestions.some((item, index) => item !== saved.suggestions?.[index]) ? { ...saved, suggestions } : saved;
    return { ...message, suggestions, rendered_text: window.discuss_markdown.render_markdown(message.text),
      rendered_summary: window.discuss_markdown.render_markdown(message.summary || "") };
  });
  state.message_total = result.total;
  const container = element("messages");
  const open_receipts = [...container.querySelectorAll(".message-receipt[open]")].map((receipt) => receipt.dataset.receiptId);
  const open_answers = [...container.querySelectorAll(".message-answer[open]")].map((answer) => answer.dataset.answerId);
  const scroll_position = container.scrollTop;
  const is_near_bottom = container.scrollHeight - container.clientHeight - scroll_position < SCROLL_BOTTOM_THRESHOLD;
  state.pages = result.pages;
  container.innerHTML = state.messages.length ? state.messages.map(message_markup).join("") :
    `<div class="empty-messages"><strong>${state.query || state.mention_only ? "没有找到匹配的发言" : "暂无讨论记录"}</strong><p>${state.query || state.mention_only ? "换个关键词，或清除筛选后查看完整记录。" : empty_discussion_message(state.room)}</p></div>`;
  for (const receipt of container.querySelectorAll(".message-receipt")) receipt.open = open_receipts.includes(receipt.dataset.receiptId);
  for (const answer of container.querySelectorAll(".message-answer")) answer.open = open_answers.includes(answer.dataset.answerId);
  container.scrollTop = is_near_bottom ? container.scrollHeight : scroll_position;
  element("record-caption").textContent = state.query || state.mention_only ? `筛选结果 · ${result.total} 条` : "完整记录 · 按时间排列";
}

/** Join bounded cursor batches for the interactive transcript; refresh only new records. */
async function load_message_history(room_id, version) {
  const params = new URLSearchParams({ q: state.query });
  if (state.mention_only) params.set("mention", element("author-select").value);
  const key = `${room_id}?${params}`;
  const saved = state.message_history?.key === key ? state.message_history.messages : [];
  const messages = [...saved];
  let has_more = true;
  while (has_more) {
    params.set("after", messages.at(-1)?.id || 0);
    const result = await request_json(`/api/rooms/${room_id}/messages?${params}`);
    if (version !== state.refresh_version) return null;
    messages.push(...result.messages);
    has_more = result.has_more;
  }
  state.message_history = { key, messages };
  return { messages, total: messages.length, page: 1, pages: 1 };
}

/** Refresh a room with version guards so slower requests cannot change the active view. */
async function refresh_room() {
  if (state.dragged_room) return;
  const version = ++state.refresh_version;
  const folder_version = state.folder_version;
  const archive_version = state.archive_version;
  const directory_version = state.directory_version;
  const room_id = state.room?.id;
  const directory = await request_json("/api/rooms");
  if (version !== state.refresh_version) return;
  if (!state.directory_pending.size && directory_version === state.directory_version) {
    state.rooms = directory.rooms.map((room) => merge_room_folder(room, folder_version, archive_version, directory_version));
    set_folder_directory(directory);
  }
  if (state.room && !state.rooms.some((item) => item.id === state.room.id)) return select_room(visible_rooms()[0]?.id);
  if (!state.room) {
    if (visible_rooms().length) return select_room(visible_rooms()[0].id);
    render_rooms();
    set_connection(true);
    return;
  }
  const [room, result] = await Promise.all([
    request_json(`/api/rooms/${room_id}`),
    state.tab === "discussion" ? load_message_history(room_id, version) : null,
  ]);
  if (version !== state.refresh_version || state.room?.id !== room_id) return;
  state.room = merge_room_folder(room, folder_version, archive_version, directory_version);
  render_rooms();
  render_room();
  if (result) render_messages(result);
  set_connection(true);
  load_room_models();
}

/** Select a room and reset room-specific draft and filter state. */
async function select_room(room_id) {
  state.access_error = ""; state.access_notice = "";
  state.navigation_version++;
  state.refresh_version++;
  state.room = state.rooms.find((room) => room.id === room_id);
  state.page = 1;
  state.query = "";
  state.mention_only = false;
  state.context_dirty = false;
  state.topic_dirty = false;
  state.pending_turn = null;
  state.pending_submission = null;
  clear_attachment_drafts();
  state.composer_error = "";
  state.launch.repair = null;
  state.launch.repair_error = '';
  state.launch.room_models = null;
  state.messages = [];
  state.message_history = null;
  element("message-input").value = "";
  element("message-summary").value = "";
  element("message-summary-source").value = "author";
  element("search-input").value = "";
  element("mention-filter").setAttribute("aria-pressed", "false");
  cancel_reply();
  cancel_turn_reply();
  element("turn-form").reset();
  element("message-kind").value = "opinion";
  select_tab("discussion");
  history.replaceState(null, "", state.room ? `/?room=${encodeURIComponent(room_id)}` : "/");
  if (state.room) state.archive_view = Boolean(state.room.archived);
  else {
    element("host-brief-panel").hidden = true;
    element("room-title").textContent = "让讨论开始";
    element("room-subtitle").textContent = "创建一个房间，从一句话开始。";
    element("room-goal").textContent = "进入房间后查看本次议题。";
    element("message-count").textContent = "0";
    element("latest-id").textContent = "#0";
  }
  render_rooms();
  await refresh_room();
}

/** Switch between history, manually maintained state, and participation guidance. */
function select_tab(tab_name) {
  state.navigation_version++;
  state.tab = tab_name;
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tab_name);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === tab_name));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== tab_name; });
  if (tab_name === "discussion") run_action(refresh_room);
  publish_view();
}

/** Clear the active reply without changing the text draft. */
function cancel_reply() {
  state.reply_to = null;
  element("reply-preview").hidden = true;
}

/** Read and validate the current composer before any upload starts. */
function message_payload() {
  const text = element("message-input").value.trim();
  if ([...text].length > MAX_MESSAGE_LENGTH) throw new Error(`留言最多 ${MAX_MESSAGE_LENGTH} 字，原文已保留，请调整后提交`);
  // Free rooms: the owner always speaks as the user; naming members is the server's job.
  if (state.room.mode === "free") {
    const online = (state.room.free?.members || []).find(member => member.name === state.free_proxy && member.access === "online" && member.status === "active");
    // Forwarding an online member's answer closes every request still waiting for it.
    if (online) return { author: online.name, text, reply_to: state.reply_to, kind: "chat", submitted_by: "用户",
      request_ids: state.room.free.requests.filter(item => item.member === online.name && item.status === "pending").map(item => item.id) };
    const payload = { author: "用户", text, reply_to: state.reply_to, kind: "chat", submitted_by: "用户" };
    const active = (state.room.free?.members || []).filter(member => member.status === "active" && (member.access !== "manual" || member.registered_at)).map(member => member.name);
    // @mentions outside code name members (@全体成员 or @all names them all, answering at once or in turn as smart scheduling decides;
    // @全体依次 or @all-seq has them answer one after another, the host first); without any, the server gives the message to the only member or the host.
    const sequential = mentioned(text, "全体依次") || mentioned(text, "all-seq");
    const everyone = !sequential && (mentioned(text, "全体成员") || mentioned(text, "all"));
    const named = sequential || everyone ? active : active.filter(name => mentioned(text, name));
    if (named.length) payload.to = named;
    if (sequential && named.length) payload.sequential = true;
    if (everyone && named.length) payload.order = "auto";
    return payload;
  }
  const mode = element("message-kind").value;
  const author = mode === "moderation" ? "用户" : element("author-select").value;
  if (author !== "用户" && state.room.experts?.[author] !== "online") throw new Error("本地 AI 须自行提交回答；网页仅代发在线成员的真实原文");
  const payload = { author, text, reply_to: state.reply_to, turn_id: state.turn_reply_to,
    kind: mode === "moderation" ? mode : "opinion", submitted_by: "用户" };
  // @mentions of active members outside code are direct questions; the website queues them beside the discussion.
  if (payload.kind === "opinion" && payload.author === "用户") {
    const named = (state.room.members || []).filter(member => member.status === "active" && member.name !== "用户" && mentioned(text, member.name)).map(member => member.name);
    if (named.length) payload.to = named;
  }
  if (payload.kind === "opinion" && payload.author !== "用户") {
    payload.summary = element("message-summary").value.trim();
    payload.summary_by = element("message-summary-source").value === "submitter" ? payload.submitted_by : payload.author;
    if ([...payload.summary].length > MAX_SUMMARY_LENGTH) throw new Error(`回答摘要最多 ${MAX_SUMMARY_LENGTH} 字，草稿已保留`);
  }
  if ([...payload.text].length > MAX_MESSAGE_LENGTH) throw new Error(`留言最多 ${MAX_MESSAGE_LENGTH} 字，原文已保留，请调整后提交`);
  return payload;
}

/** Whether plain text (not code or quotes) names a member with @, so a typed mention selects it. */
function mentioned(text, name) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  return new RegExp(`(^|[\\s(（，,。；;：:])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "u").test(prose);
}

/** Choose an online member to forward the next answer for, or clear the choice. */
function set_proxy(name) { state.free_proxy = state.free_proxy === name ? "" : name; }

/** Copy a reading notice for an online member: links and message numbers only, no context. */
async function copy_online_notice(name) {
  const ids = (state.room.free?.requests || []).filter(item => item.member === name && item.status === "pending").map(item => `#${item.message_id}`);
  await copy_text(`请阅读 ${location.origin}/r/${state.room.id}?participant=${name} ，回应 ${ids.join("、") || "最新消息"}。单条原文：${location.origin}/r/${state.room.id}/messages/编号。请在你自己的窗口回答，不要操作网页或调用写入接口。`);
  state.free_notice = `已复制给 ${name} 的阅读通知；复制不代表已送达。拿到回答后，在输入框选择“代发 ${name}”粘贴原文。`;
}

/** Start every new form from defaults: room use, delivery, text, roster, host, limits and software overrides. */
function reset_create_form() {
  element("room-form").reset();
  reset_creation_mode();
  render_expert_inputs("new-expert-modes", default_experts());
  render_host_options("new-room-host", [], "");
  state.create_parent = null;
  state.launch.create = true;
  state.launch.workspace = {};
  state.launch.scheduler = default_scheduler();
  state.named_followup = false;
  state.create_discussion = false;
  state.launch.profiles = JSON.parse(JSON.stringify(state.launch.saved_profiles || {}));
  Object.values(state.launch.profiles).forEach(fill_api_key);
  state.launch.notice = "";
  render_launch_settings();
  publish_view();
}

/** Prepare the creation form for a brainstorm room that remembers this free room. */
function prepare_brainstorm() {
  reset_create_form();
  const room = state.room;
  // Discussions run automatically, so only members the local service wakes come along.
  const members = (room.free?.members || []).filter(member => member.status === "active" && member.access === "runner");
  const host = members.find(member => member.role === "host") || members[0];
  element("new-room-kind").value = "brainstorm";
  update_creation_mode();
  element("new-room-title").value = `头脑风暴：${room.title}`.slice(0, 80);
  element("new-room-user_request").value = room.user_request || room.goal || "";
  render_expert_inputs("new-expert-modes", Object.fromEntries(members.map(member => [member.name, "cli"])));
  render_host_options("new-room-host", members.map(member => member.name), host?.name || "");
  state.create_parent = room.id;
}

/** Post a concluded brainstorm's result back to the free room it came from, as a plain note. */
async function return_conclusion() {
  const room = state.room, parent = room.parent_room;
  if (!parent) return;
  const summary = room.host_brief?.text || room.state_text || "（主持人尚未整理结论，请查看原文）";
  await request_json(`/api/rooms/${parent.id}/messages`, { author: "用户", text: `头脑风暴「${room.title}」已收束。\n\n${summary}\n\n原文：${location.origin}/r/${room.id}`,
    kind: "chat", submitted_by: "用户", submission_id: new_submission_id(), to: [] });
  state.free_notice = `结论已发回「${parent.title}」`;
  await select_room(parent.id);
}

/** Persist a member mutation before transmission and reuse its credential after an uncertain response. */
function prepare_member_request(room_id, operation, member, options = {}) {
  const key = MEMBER_PENDING_PREFIX + room_id + ":" + operation;
  const previous = localStorage.getItem(key);
  const record = previous ? JSON.parse(previous) : { key, member: { ...member, token: crypto.randomUUID() + crypto.randomUUID() }, options };
  localStorage.setItem(key, JSON.stringify(record));
  return record;
}

/** Keep a successful membership receipt and its private file together. */
function finish_member_request(room_id, token, record, result) {
  const members = result.free?.members || result.room?.members || result.members || [];
  save_room_credentials({ id: room_id, members }, token, [record.member]);
  localStorage.removeItem(record.key);
}

/** Owner changes use the website; only automatic members need the local service to reconnect. */
async function change_member({ member_id, name, action, role, latest_id }) {
  const room_id = state.room.id;
  state.free_error = ""; state.free_notice = "";
  try {
    if (action === "rejoin") {
      const member = (state.room.free?.members || state.room.members).find(item => item.id === member_id);
      const token = localStorage.getItem(`discuss-access:${room_id}`);
      const record = prepare_member_request(room_id, `rejoin:${member_id}`, { name, access: member.access });
      const result = member.access === "runner"
        ? await local_launch_request("room-member", { room_id, token, action: "rejoin", name, member_token: record.member.token })
        : await request_json(`/api/rooms/${room_id}/members/${member_id}`, { action: "active", token: record.member.token });
      finish_member_request(room_id, token, record, result);
      if (state.room?.id === room_id) state.free_notice = member.access === "manual" ? `${name} 已请回，凭证已更新；请用新的启动指令让它重新注册。` : `${name} 已请回，续接原会话。`;
    } else {
      await request_json(`/api/rooms/${room_id}/members/${member_id}${action === "interrupt" ? "/interrupt" : ""}`,
        action === "interrupt" ? {} : { action, ...(role ? { role } : {}), ...(latest_id !== undefined ? { latest_id } : {}) });
    }
    if (state.room?.id === room_id) await refresh_room();
  } catch (error) { if (state.room?.id === room_id) state.free_error = error.message; }
}

/** Reorder who has not spoken yet against the revision the board showed; a changed order is refused and the board reloads. */
async function reorder_speakers({ revision, order }) {
  const room_id = state.room.id;
  state.order_error = null;
  try { await request_json(`/api/rooms/${room_id}/speaking-order`, { revision, order }); }
  catch (error) {
    // A conflict means someone else's change landed first; the board reloads below, so ask for the move again (same text as the board's own notice).
    state.order_error = { room_id, message: error.status === 409 ? "发言顺序刚有变化，已更新为最新顺序，请重新调整" : error.message };
  }
  if (state.room?.id === room_id) await refresh_room();
}

/** Invite an independent member, retaining its credential before either delivery path runs. */
async function invite_member({ name, access, project_access = "read", session_id = "" }) {
  const room_id = state.room.id;
  state.free_error = ""; state.free_notice = "";
  try {
    const token = localStorage.getItem(`discuss-access:${room_id}`);
    if (!token) throw new Error("此浏览器缺少房间控制凭据，请使用创建房间的浏览器");
    const taken = new Set((state.room.free?.members || state.room.members || []).map(member => member.name));
    let instance = name;
    for (let number = 2; taken.has(instance); number++) instance = `${name}-${number}`;
    const record = prepare_member_request(room_id, `add:${name}:${access}`, { name: instance, access, adapter: "", session_mode: "new" }, { project_access, session_id: session_id.trim() });
    let result;
    if (access === "runner") {
      const draft = launch_options();
      const participants = { ...draft.participants, [record.member.name]: { ...draft.participants?.[name],
        ...draft.participants?.[record.member.name], project_access: record.options?.project_access || "read",
        // An existing conversation joins with its own context; the runner resumes it instead of starting a new one.
        ...(record.options?.session_id ? { session_id: record.options.session_id } : {}) } };
      if (participants[record.member.name].adapter === "api") participants[record.member.name].project_access = "read";
      result = await local_launch_request("room-member", { room_id, token, action: "add", name: record.member.name, access,
        member_token: record.member.token, participants, cwd: draft.cwd });
    } else result = await request_json(`/api/rooms/${room_id}/members`, record.member);
    finish_member_request(room_id, token, record, result);
    if (state.room?.id === room_id) {
      state.free_notice = access === "online" ? `${record.member.name} 已加入，阅读通知与真实回答由你或授权主持人转交。`
        // A manual member's start step lives on the board row, the composer bar and the invite dialog; no extra notice.
        : access === "manual" ? ""
          : record.options?.session_id ? `${record.member.name} 已接入原会话；它工作时请不要在原窗口继续操作。`
          : state.room.mode === "free" ? `${record.member.name} 已加入，之后点名它即会由本机服务唤醒。`
            : `${record.member.name} 已加入讨论，主持人会重新安排发言。`;
      await refresh_room();
    }
  } catch (error) { if (state.room?.id === room_id) state.free_error = error.message; }
}

/** Clear only the composer that produced the saved message. */
async function finish_message(result, room_id, drafts) {
  show_toast(`留言已保存 · #${result.message.id}`);
  if (state.room?.id !== room_id || state.attachment_drafts !== drafts) return;
  element("message-input").value = "";
  element("message-summary").value = "";
  state.pending_submission = null;
  state.free_proxy = "";
  clear_attachment_drafts();
  cancel_reply();
  cancel_turn_reply();
  state.query = "";
  state.mention_only = false;
  element("search-input").value = "";
  element("mention-filter").setAttribute("aria-pressed", "false");
  state.page = 1;
  await refresh_room();
  element("messages").scrollTop = element("messages").scrollHeight;
}

/** Submit one message; reuse its identifier if a network failure requires a retry. */
async function send_message(event) {
  event.preventDefault();
  if (!state.room || state.sending_message) return;
  const room_id = state.room.id, drafts = state.attachment_drafts;
  state.composer_error = "";
  let payload, saved = false;
  try { payload = message_payload(); }
  catch (error) { state.composer_error = error.message; render_attachment_drafts(); publish_view(); throw error; }
  if (!payload.text && !drafts.length) return;
  const signature = JSON.stringify({ room: room_id, ...payload, files: drafts.map(file => file.id) });
  if (state.pending_submission?.signature !== signature) state.pending_submission = { signature, id: new_submission_id() };
  payload.submission_id = state.pending_submission.id;
  element("send-message").disabled = true;
  state.sending_message = true;
  element("message-input").disabled = true;
  publish_view();
  try {
    payload.attachment_ids = await upload_message_attachments(room_id, payload.submitted_by, drafts);
    const result = await request_json(`/api/rooms/${room_id}/messages`, payload);
    saved = true;
    await finish_message(result, room_id, drafts);
  } catch (error) {
    if (state.room?.id === room_id) state.composer_error = saved
      ? `留言已保存，但页面刷新失败：${error.message}`
      : `${error.message}；草稿已保留，可重试发送`;
    throw error;
  } finally {
    state.sending_message = false;
    state.upload_status = "";
    element("send-message").disabled = false;
    element("message-input").disabled = false;
    render_attachment_drafts();
    publish_view();
  }
}

/** Format sizes for the file cards and composer. */
function attachment_size(size) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

/** Render a file-shaped type badge; the extension is a label, not a preview capability. */
function attachment_file_icon(file_name) {
  const extension = String(file_name).match(/\.([a-z0-9]{1,5})$/i)?.[1].toUpperCase() || "FILE";
  const tone = extension === "PDF" ? "red" : /^(XLSX?|CSV)$/.test(extension) ? "green"
    : /^(PPTX?)$/.test(extension) ? "orange" : "blue";
  return `<span class="attachment-file-icon" data-tone="${tone}" aria-hidden="true">
    <svg viewBox="0 0 36 44" fill="none"><path d="M4 0h19l13 13v27a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" fill="currentColor"/><path d="M23 0v9a4 4 0 0 0 4 4h9" fill="#fff" fill-opacity=".3"/></svg>
    <span>${extension}</span></span>`;
}

/** Keep original files in memory until sending; reject an invalid selection as a whole. */
function add_attachments(files) {
  if (!state.room || state.sending_message) return;
  const selected = Array.from(files);
  state.composer_error = "";
  if (state.attachment_drafts.length + selected.length > MAX_MESSAGE_ATTACHMENTS) state.composer_error = "每条消息最多 10 个附件";
  else if (selected.some(file => file.size > MAX_ATTACHMENT_BYTES)) state.composer_error = "单个附件最多 20 MiB";
  else state.attachment_drafts.push(...selected.map(file => ({ id: new_submission_id(), file,
    preview_url: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "", uploaded: null, actor: null })));
  render_attachment_drafts();
  publish_view();
}

/** Release local previews when a draft is sent or its room is left. */
function clear_attachment_drafts() {
  for (const file of state.attachment_drafts) if (file.preview_url) URL.revokeObjectURL(file.preview_url);
  state.attachment_drafts = [];
  render_attachment_drafts();
}

/** Remove one unsent file without disturbing the text draft. */
function remove_attachment(id) {
  if (state.sending_message) return;
  const file = state.attachment_drafts.find(item => item.id === id);
  if (file?.preview_url) URL.revokeObjectURL(file.preview_url);
  state.attachment_drafts = state.attachment_drafts.filter(item => item.id !== id);
  state.composer_error = "";
  render_attachment_drafts();
  publish_view();
}

/** Display shared file drafts and errors in the classic theme. */
function render_attachment_drafts() {
  const container = element("attachment-drafts");
  if (!container) return;
  container.innerHTML = state.attachment_drafts.map(item => `<div class="attachment-draft">${item.preview_url ? `<img src="${item.preview_url}" alt="">` : ""}
    <span>${escape_html(item.file.name)}<small>${attachment_size(item.file.size)}</small></span>
    <button type="button" data-remove-attachment="${item.id}" aria-label="移除 ${escape_html(item.file.name)}" ${state.sending_message ? "disabled" : ""}>×</button></div>`).join("");
  element("attachment-status").textContent = state.composer_error || state.upload_status;
  element("choose-attachments").disabled = state.sending_message;
}

/** Upload once per actual uploader, retaining receipts across ambiguous send failures. */
async function upload_message_attachments(room_id, actor, drafts) {
  const identifiers = [];
  for (const [index, item] of drafts.entries()) {
    if (!item.uploaded || item.actor !== actor) {
      item.upload_submission ??= item.id;
      if (item.actor && item.actor !== actor) { item.upload_submission = new_submission_id(); item.uploaded = null; }
      item.actor = actor;
      state.upload_status = `正在上传 ${index + 1}/${drafts.length} · ${item.file.name}`;
      render_attachment_drafts();
      publish_view();
      const params = new URLSearchParams({ file_name: item.file.name, actor, submission_id: item.upload_submission });
      const token = localStorage.getItem(`discuss-access:${room_id}`);
      const response = await fetch(`/api/rooms/${room_id}/attachments?${params}`, { method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...(token ? { "X-Discussion-Token": token } : {}), ...admin_headers() }, body: item.file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "附件上传失败");
      item.uploaded = result.attachment.id;
    }
    identifiers.push(item.uploaded);
  }
  return identifiers;
}

/** Intercept only actual file drops; ordinary text dragging keeps its default behavior. */
function drop_attachments(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.type === "drop") add_attachments(event.dataTransfer.files);
}

/** Paste screenshots without replacing normal clipboard text handling. */
function paste_attachments(event) {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  add_attachments(files);
}

/** Render immutable file cards shared by messages, original-message dialogs, and themes. */
function attachment_markup(files = []) {
  if (!files.length) return "";
  return `<div class="message-attachments">${files.map(file => {
    const url = `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
    const name = escape_html(file.file_name);
    const preview_attributes = `data-preview-attachment="${escape_html(file.id)}" data-attachment-room="${escape_html(file.room_id)}" aria-label="预览 ${name}"`;
    if (file.content_type.startsWith("image/")) return `<button type="button" class="attachment-image" ${preview_attributes}>
      <img src="${url}" alt="${name}" loading="lazy"></button>`;
    const content = `${attachment_file_icon(file.file_name)}<span class="attachment-name"><span title="${name}">${name}</span><small>${attachment_size(file.size)}</small></span>`;
    return `<div class="attachment-file">${file.content_type === "application/pdf"
      ? `<button type="button" class="attachment-file-main" ${preview_attributes}>${content}</button>`
      : `<a class="attachment-file-main" href="${url}?download=1" download aria-label="下载 ${name}">${content}</a>`}
      <a class="attachment-download" href="${url}?download=1" download aria-label="下载 ${name}" title="下载 ${name}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/></svg>
      </a></div>`;
  }).join("")}</div>`;
}

/** Close previews and release document workers and in-flight canvas renders. */
function close_attachment_preview() {
  const preview = state.attachment_preview;
  state.attachment_preview = null;
  preview?.render_task?.cancel();
  if (preview?.task) preview.task.destroy().catch(() => {});
  element("attachment-image")?.removeAttribute("src");
}

/** Open images or the local PDF.js reader without leaving the discussion. */
async function preview_attachment({ room_id, id }) {
  close_attachment_preview();
  const preview = { page: 1, zoom: 1, render_version: 0 };
  state.attachment_preview = preview;
  const file = await request_json(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(id)}`);
  if (state.attachment_preview !== preview) return;
  preview.file = file;
  const is_pdf = file.content_type === "application/pdf";
  element("attachment-title").textContent = file.file_name;
  element("attachment-download").href = file.download_url;
  element("attachment-image").hidden = is_pdf;
  element("attachment-canvas").hidden = true;
  element("attachment-pdf-controls").hidden = !is_pdf;
  element("attachment-preview-status").textContent = is_pdf ? "正在读取 PDF…" : "";
  if (!element("attachment-dialog").open) element("attachment-dialog").showModal();
  if (!is_pdf) { element("attachment-image").src = file.url; return; }
  try {
    const pdf = await import("/pdfjs/pdf.min.mjs");
    if (state.attachment_preview !== preview) return;
    pdf.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
    preview.task = pdf.getDocument({ url: file.url, cMapUrl: "/pdfjs/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/", wasmUrl: "/pdfjs/wasm/", iccUrl: "/pdfjs/iccs/",
      isEvalSupported: false, enableXfa: false, disableRange: true, disableStream: true });
    preview.document = await preview.task.promise;
    if (state.attachment_preview === preview) await render_attachment_pdf();
  } catch (error) {
    if (state.attachment_preview === preview) element("attachment-preview-status").textContent = `无法预览此 PDF：${error.message}。可下载原文件查看。`;
  }
}

/** Render only the selected PDF page, bounding canvas allocation and cancelling stale work. */
async function render_attachment_pdf() {
  const preview = state.attachment_preview;
  if (!preview?.document) return;
  const version = ++preview.render_version;
  const previous = preview.render_task;
  previous?.cancel();
  if (previous) await previous.promise.catch(() => {});
  try {
    const page = await preview.document.getPage(preview.page);
    if (state.attachment_preview !== preview || version !== preview.render_version) return;
    const canvas = element("attachment-canvas"), original = page.getViewport({ scale: 1 });
    const fit = Math.min((element("attachment-viewer").clientWidth - 40) / original.width, 1.6);
    const viewport = page.getViewport({ scale: fit * preview.zoom });
    const density = Math.min(window.devicePixelRatio || 1, 2, PDF_CANVAS_LIMIT / Math.max(viewport.width, viewport.height));
    canvas.width = Math.ceil(viewport.width * density);
    canvas.height = Math.ceil(viewport.height * density);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    element("attachment-page").textContent = `${preview.page} / ${preview.document.numPages}`;
    element("attachment-previous").disabled = preview.page === 1;
    element("attachment-next").disabled = preview.page === preview.document.numPages;
    element("attachment-preview-status").textContent = "";
    preview.render_task = page.render({ canvasContext: canvas.getContext("2d"), viewport,
      transform: [density, 0, 0, density, 0, 0] });
    await preview.render_task.promise;
    if (state.attachment_preview === preview && version === preview.render_version) canvas.hidden = false;
  } catch (error) {
    if (state.attachment_preview === preview && version === preview.render_version && error.name !== "RenderingCancelledException")
      element("attachment-preview-status").textContent = `PDF 页面读取失败：${error.message}`;
  }
}

/** Bind the shared picker, paste/drop handlers, and accessible preview dialog once. */
function bind_attachment_controls() {
  element("choose-attachments").addEventListener("click", () => element("attachment-input").click());
  element("attachment-input").addEventListener("change", event => { add_attachments(event.target.files); event.target.value = ""; });
  for (const event of ["dragover", "drop"]) element("message-form").addEventListener(event, drop_attachments);
  element("message-input").addEventListener("paste", paste_attachments);
  document.addEventListener("click", event => {
    const preview = event.target.closest("[data-preview-attachment]");
    if (preview) run_action(() => preview_attachment({ room_id: preview.dataset.attachmentRoom, id: preview.dataset.previewAttachment }));
    const remove = event.target.closest("[data-remove-attachment]");
    if (remove) remove_attachment(remove.dataset.removeAttachment);
  });
  element("close-attachment").addEventListener("click", () => element("attachment-dialog").close());
  element("attachment-dialog").addEventListener("close", close_attachment_preview);
  element("attachment-image").addEventListener("error", () => { element("attachment-preview-status").textContent = "图片读取失败，可下载原文件查看"; });
  for (const [id, delta] of [["attachment-previous", -1], ["attachment-next", 1]]) element(id).addEventListener("click", () => {
    const preview = state.attachment_preview;
    if (preview?.document) { preview.page = Math.max(1, Math.min(preview.document.numPages, preview.page + delta)); render_attachment_pdf(); }
  });
  for (const [id, factor] of [["attachment-zoom-out", 0.8], ["attachment-zoom-in", 1.25]]) element(id).addEventListener("click", () => {
    const preview = state.attachment_preview;
    if (preview) { preview.zoom = Math.max(0.5, Math.min(3, preview.zoom * factor)); render_attachment_pdf(); }
  });
}

/** Show exact original content and let the reader follow the reply chain. */
async function show_message(message_id) {
  const message = await request_json(`/api/rooms/${state.room.id}/messages/${message_id}`);
  element("detail-title").textContent = `#${message.id} · ${display_name(message.author)}`;
  const source = SOURCE_LABELS[message.source] || message.source;
  const summary = message.summary ? `回答摘要 · ${display_name(message.summary_by)}\n${message.summary}\n\n完整正文\n` : "";
  element("detail-body").textContent = `${source} · ${message_provenance(message)} · ${new Date(message.created_at).toLocaleString("zh-CN")}\n\n${summary}${message.text}`;
  element("detail-body").insertAdjacentHTML("beforeend", attachment_markup(message.attachments));
  if (message.reply_to) {
    const link = document.createElement("button");
    link.textContent = `↳ 查看被回复的原文 #${message.reply_to}`;
    link.addEventListener("click", () => run_action(() => show_message(message.reply_to)));
    element("detail-body").append(link);
  }
  if (!element("message-dialog").open) element("message-dialog").showModal();
}

/** Render reading links without creating or fetching any publishing links. */
function render_access() {
  render_room_configuration();
  const base = `${location.origin}/r/${state.room.id}`;
  const runtime = state.room.runtime || { mode: "manual", status: "ready" };
  element("runtime-status").textContent = runtime_label(runtime);
  if (element("local-launch-start")) element("local-launch-start").disabled = !state.launch.available || runtime.mode !== "automatic" || runtime.status !== "ready";
  element("runtime-execution").textContent = execution_label(runtime.latest_execution);
  element("runtime-pause").hidden = runtime.status !== "running";
  element("runtime-export").hidden = !runtime.protected;
  if (state.runtime_draft_room !== state.room.id) {
    const saved = JSON.parse(localStorage.getItem(`discuss-workspace:${state.room.id}`) || "{}");
    element("runtime-project").value = saved.discussion_project || "";
    element("runtime-cwd").value = saved.cwd || "";
    state.runtime_draft_room = state.room.id;
  }
  element("reading-url").textContent = base;
  element("open-reading").href = base;
  element("cli-reading-url").textContent = `${base}?mode=cli`;
  element("open-cli-reading").href = `${base}?mode=cli`;
  element("cli-endpoint").textContent = `POST ${location.origin}/api/rooms/${state.room.id}/messages`;
  const routes = [["背景与边界", `${base}/brief`], ["共识与分歧", `${base}/state`], ["完整历史 · 每页 20 条", `${base}/messages?page=1`],
    ["精确查阅 · 消息编号", `${base}/messages/${state.room.latest_id || "消息编号"}`], ["检索原文", `${base}/search?q=关键词`],
    ["查看被 @ 的消息", `${base}/search?mention=Codex`]];
  element("endpoint-list").innerHTML = routes.map(([title, url]) => `<div class="endpoint"><div>${title}</div><code>${escape_html(url)}</code></div>`).join("");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
  element("address-note").textContent = local ? "当前是本机地址。请给在线 AI 提供公网阅读地址，或直接复制讨论材料。" : "在线 AI 仅需读取；若读取失败，由用户复制材料提供。观点在原聊天窗口输出，再由用户代发。";
}

/** Read numeric limits from the shared classic/modern form controls. */
function read_limits(prefix) {
  return Object.fromEntries(["max_rounds", "max_minutes", "execution_minutes"].map(key => {
    const value = element(`${prefix}-limit-${key}${prefix === "topic" ? "-input" : ""}`).value;
    return [key, Number(value)];
  }));
}

/** Rounds against the limit: the current segment, with rounds the user appended shown as M+N (M is the original limit). */
function limit_rounds(limits = {}) {
  const done = limits.segment_rounds ?? limits.completed_rounds ?? 0;
  const cap = limits.round_cap ?? limits.max_rounds ?? 0;
  const total = limits.extra_rounds ? `${limits.max_rounds}+${limits.extra_rounds}` : "";
  return { done, cap, total, text: cap ? `${done} / ${cap}${total ? `（${total}）` : ""} 轮` : `${done} 轮` };
}

/** Describe configured boundaries and actual progress without implying completion. */
function limits_label(limits = {}) {
  const finished = state.room?.phase === "concluded";
  const rounds = limits.round_cap || limits.max_rounds ? limit_rounds(limits).text : `${limits.completed_rounds || 0} 轮 · 未设轮次上限`;
  const duration = limits.max_minutes ? `总时长 ${limits.max_minutes} 分钟` : "未设总时长";
  const progress = finished ? "讨论已收束" : !limits.started_at ? "尚未计时" : `已用 ${Math.floor((limits.elapsed_seconds || 0) / 60)} 分钟${limits.remaining_seconds == null ? "" : ` · 剩余 ${Math.ceil(limits.remaining_seconds / 60)} 分钟`}`;
  const status = finished ? "" : limits.reached ? "已达上限，停止新增安排" : "";
  const action = "到限暂停";
  const execution = limits.execution_minutes ? `${limits.execution_minutes} 分钟` : "不限时长";
  return `${rounds}；${duration}；${progress}。单次自动执行 ${execution}。${action}${status ? `；${status}` : ""}。`;
}

/** Apply a reached boundary without starting an AI or inventing a summary. */
async function check_limits() {
  await request_json(`/api/rooms/${state.room.id}/limits`, { actor: "用户" });
  await refresh_room();
  show_toast("已核对讨论上限");
}

/** Read private member files only inside the controller, never in a presentation snapshot. */
function member_credentials(room_id) {
  try { return JSON.parse(localStorage.getItem(MEMBER_ACCESS_PREFIX + room_id) || "{}"); }
  catch { return {}; }
}

/** Persist accepted owner/member credentials before discarding the original retry record. */
function save_room_credentials(room, token, members = []) {
  localStorage.setItem(`discuss-access:${room.id}`, token);
  const saved = member_credentials(room.id);
  for (const member of members) {
    const public_member = (room.members || room.free?.members || []).find(item => item.name === member.name);
    saved[member.name] = { token: member.token, access: member.access, id: public_member?.id };
  }
  localStorage.setItem(MEMBER_ACCESS_PREFIX + room.id, JSON.stringify(saved));
}

/** Public administrator state for the account UI; the session token never leaves the controller. */
function admin_snapshot() {
  const { loaded, local, registered, setup_available, logged_in, profile, identity_version } = state.admin;
  return { loaded, local, registered, setup_available, logged_in, identity_version, profile: profile && { ...profile } };
}

/** Build only non-secret status metadata for the currently selected room. */
function access_snapshot() {
  const room = state.room;
  if (!room) return { can_manage: false, members: [], notice: "", error: "" };
  const saved = member_credentials(room.id);
  return { can_manage: Boolean(localStorage.getItem(`discuss-access:${room.id}`)),
    members: (room.members || room.free?.members || []).filter(member => member.status !== "removed").map(member => ({
      name: member.name, access: member.access, available: member.status === "active" && member.access !== "online"
        && Boolean(saved[member.name]?.token) && (saved[member.name].access === "online") === (member.access === "online")
        && (!saved[member.name].id || saved[member.name].id === member.id),
    })), notice: state.access_notice, error: state.access_error };
}

/** Generate a separate random credential for each declared participant instance; `cli` members are woken locally. */
function creation_members(experts) {
  return Object.entries(experts || {}).map(([name, capability]) => ({ name, token: crypto.randomUUID() + crypto.randomUUID(),
    adapter: "", access: capability === "cli" ? "runner" : capability, session_mode: "new" }));
}

/** Capture public form choices separately from the private credentials added at submission. */
function room_creation_payload(folder_id) {
  const common = { title: element("new-room-title").value, goal: element("new-room-goal").value,
    host: element("new-room-host").value, user_request: element("new-room-user_request").value,
    experts: read_expert_inputs("new-expert-modes"), folder_id };
  // Free rooms carry their task in the conversation, so no opening brief is sent even if one was typed for a discussion.
  if (element("new-room-kind").value === "free") return { ...common, user_request: "", mode: "free", host: common.host || "用户" };
  return { ...common, mode: "brainstorm", background: element("new-room-background").value,
    boundaries: element("new-room-boundaries").value, runtime_mode: "automatic", limits: read_limits("new-room"), named_followup: state.named_followup,
    ...(state.create_parent ? { parent_room_id: state.create_parent } : {}) };
}

/** Retain an unresolved creation instead of silently replacing it with a new request. */
function prepare_room_request(signature) {
  if (state.pending_room?.signature === signature) return state.pending_room;
  const saved = stored_launches().find(record => record.signature === signature);
  if (saved) return state.pending_room = { signature, id: saved.id, token: saved.input.token, members: saved.input.room?.members };
  if (state.pending_room && localStorage.getItem(LAUNCH_PENDING_PREFIX + state.pending_room.id)) {
    throw new Error("上次启动结果尚未确认，请先继续原请求；如要放弃重试，请移除对应待办。原房间不会被删除。");
  }
  state.pending_room = { signature, id: new_submission_id(), token: crypto.randomUUID() };
  return state.pending_room;
}

/** Show creation progress locally without blocking or later hijacking navigation. */
async function submit_room(event, folder_id = null) {
  event.preventDefault();
  if (state.directory_pending.has("create-room")) return;
  const payload = room_creation_payload(folder_id);
  const free = payload.mode === "free";
  // A discussion can still be created without the local service and started later from the room;
  // a free room needs the service only for members it wakes or for smart scheduling.
  const launching = free ? Object.values(payload.experts).includes("cli") || (state.launch.available && Boolean(creation_launch_options().scheduler || state.launch.workspace.cwd)) : state.launch.create && state.launch.available;
  if (launching && !state.launch.available) throw new Error("本机唤醒的成员需要连接本机服务；也可改为手动接入或网页代发");
  const launch_draft = launching ? creation_launch_options() : null;
  // A discussion is only a way to push the room forward: the room is created as a free room, then opened with these limits.
  const discussion = free && state.create_discussion ? { goal: payload.goal.trim(), named_followup: state.named_followup,
    limits: read_limits("new-room") } : null;
  if (discussion && !(launching && payload.host && payload.experts[payload.host] === "cli")) throw new Error("开启讨论需要一位由本机唤醒的 AI 主持人；请先添加并设为主持人");
  // The key joins the signature only when a discussion is requested, so recovered requests keep matching their stored signature.
  const signed = (current_payload, current_draft) => JSON.stringify(discussion ? { payload: current_payload, launch_draft: current_draft, discussion } : { payload: current_payload, launch_draft: current_draft });
  const signature = signed(payload, launch_draft);
  const navigation = state.navigation_version;
  if (!launching) element("room-dialog").close();
  state.launch.error = "";
  let room;
  try {
    const pending = prepare_room_request(signature);
    const token = pending.token;
    pending.members ||= creation_members(payload.experts);
    // The website tracks capabilities (cli/online); a manual expert is a local reader and writer whose delivery lives in its member record.
    const experts = Object.fromEntries(Object.entries(payload.experts || {}).map(([name, mode]) => [name, mode === "manual" ? "cli" : mode]));
    const input = { ...(launch_draft || {}), room: { ...payload, ...(payload.experts ? { experts } : {}), members: pending.members, submission_id: pending.id }, token };
    room = await update_directory({ key: "create-room", label: `「${payload.title}」创建`,
    error_message: launching ? error => `「${payload.title}」${error.message}` : null,
    apply: () => { state.creating_room = payload; }, rollback: () => { state.creating_room = null; },
    save: async () => (await submit_local_launch(input, payload.title, !launching, signature)).room,
    commit: saved => {
      state.creating_room = null;
      if (!state.rooms.some(existing => existing.id === saved.id)) state.rooms.push(saved);
    } }); }
  catch (error) {
    if (launching) { state.launch.error = error.message; render_launch_settings(); publish_view(); }
    throw error;
  }
  state.pending_room = null;
  state.create_parent = null;
  if (discussion) await open_discussion_after_creation(room.id, discussion);
  if (signed(room_creation_payload(folder_id), launching ? creation_launch_options() : null) === signature) {
    element("room-form").reset();
    reset_creation_mode();
    render_expert_inputs("new-expert-modes", default_experts());
    state.launch.create = true;
    if (launching) element("room-dialog").close();
  }
  if (launching) clear_launch_overrides(launch_draft);
  if (state.navigation_version === navigation) { state.archive_view = false; await select_room(room.id); }
}

/** Open and start the discussion of a room just created; a failure leaves the room as an ordinary free room. */
async function open_discussion_after_creation(room_id, { goal, named_followup, limits }) {
  const path = `/api/rooms/${room_id}`;
  try {
    await request_json(`${path}/discussion`, { action: "start", ...(goal ? { goal } : {}), limits, named_followup });
    const runtime = await request_json(`${path}/runtime`);
    await request_json(`${path}/runtime`, { action: "start", mode: "automatic", revision: runtime.revision, deadline: 0 });
  } catch (error) {
    show_toast(`房间已创建，但开启讨论失败：${error.message}；可在右侧成员栏重试`);
  }
}

/** Read a site-bound connection without exposing its credential to the shared view snapshot. */
function restore_local_connection() {
  const fragment = new URLSearchParams(location.hash?.slice(1) || "");
  const incoming = fragment.get("codiscuss-connect");
  if (incoming !== null) history.replaceState(null, "", `${location.pathname}${location.search}`);
  const saved = incoming ?? localStorage.getItem(LOCAL_CONNECTION_KEY);
  if (!saved) return null;
  try {
    const value = JSON.parse(saved);
    const endpoint = new URL(value.endpoint);
    if (value.site !== location.origin || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
        || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
        || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error("invalid connection");
    const connection = { site: value.site, endpoint: endpoint.origin, token: value.token };
    if (incoming !== null) localStorage.setItem(LOCAL_CONNECTION_KEY, JSON.stringify(connection));
    return connection;
  } catch {
    throw new Error("本机连接链接无效或无法保存，请重新运行连接命令；尚未发送启动请求");
  }
}

/** Use the local bridge directly; machine configuration and connection credentials never go to the public server. */
async function local_launch_request(action, payload) {
  const headers = { "Content-Type": "application/json", "X-CoDiscuss-Local": "1" };
  if (local_connection) headers["X-CoDiscuss-Connection"] = local_connection.token;
  let response;
  try {
    response = await fetch(`${local_connection?.endpoint || ""}/api/local/${action}`, {
      method: payload === undefined ? "GET" : "POST", headers, credentials: "omit", redirect: "error",
      body: payload === undefined ? undefined : JSON.stringify(payload),
      ...(payload === undefined || ["room-models", "models", "api-check", "scheduler-check"].includes(action)
        ? { signal: AbortSignal.timeout(["models", "api-check", "scheduler-check"].includes(action) ? MODEL_CATALOG_TIMEOUT_MS : LOCAL_CONNECTION_TIMEOUT_MS) } : {}) });
  } catch (error) {
    if (!local_connection) throw error;
    throw new Error("无法连接本机服务：请在这台电脑运行 codiscuss local open，并允许浏览器访问本机网络，再重试原请求");
  }
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || "本机启动请求失败"), { launch: result.launch });
  return result;
}

/** Read this browser's submitted requests; credentials never enter the presentation snapshot. */
function stored_launches() {
  const records = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(LAUNCH_PENDING_PREFIX)) continue;
    try {
      const record = JSON.parse(localStorage.getItem(key));
      if (record?.input?.token && record.id && key === LAUNCH_PENDING_PREFIX + record.id) records.push(record);
    } catch { /* An unreadable local draft must not block other discussions. */ }
  }
  return records;
}

/** Share only recovery labels and safe room references with both renderers. */
function refresh_launch_recoveries() {
  state.launch.recoveries = stored_launches().map(({ id, title, room_id, error, direct }) => ({ id, title, room_id, error, direct: Boolean(direct) }));
  const container = element("launch-recoveries");
  if (container) {
    container.hidden = !state.launch.recoveries.length;
    container.innerHTML = state.launch.recoveries.map(item => `<section><strong>${escape_html(item.title)}</strong>
      <p>${escape_html(item.error || "启动结果尚未确认；原请求已保存在此浏览器中。")}</p><div class="topic-actions">
      <button class="button primary" data-launch-retry="${escape_html(item.id)}">继续本次启动</button>
      ${item.room_id ? `<button class="button secondary" data-launch-room="${escape_html(item.room_id)}">查看原房间</button>` : ""}
      <button class="button secondary" data-launch-discard="${escape_html(item.id)}">移除待办</button></div></section>`).join("")
      + "<p>移除待办不会删除房间或停止讨论。</p>";
  }
  publish_view();
}

/** Persist the complete submitted input before any request can create or start a room. */
async function submit_local_launch(input, title, direct = false, signature) {
  const id = input.room?.submission_id || `room-${input.room_id}`;
  const key = LAUNCH_PENDING_PREFIX + id;
  const previous = localStorage.getItem(key);
  const record = previous ? JSON.parse(previous) : { id, title, input, room_id: input.room_id, direct, signature };
  if (previous && JSON.stringify(record.input) !== JSON.stringify(input)) throw new Error("此房间有未完成的原启动请求，请先继续该请求，不要替换配置");
  record.attempt_id = crypto.randomUUID();
  try { localStorage.setItem(key, JSON.stringify(record)); }
  catch { throw new Error("此浏览器无法保存启动请求，请启用本地存储后重试；尚未发送本次启动"); }
  refresh_launch_recoveries();
  try {
    const result = record.direct ? { room: await request_json("/api/rooms", record.input.room, record.input.token), status: "created" }
      : await local_launch_request("launch", record.input);
    save_room_credentials(result.room, record.input.token, record.input.room?.members || []);
    localStorage.removeItem(key);
    refresh_launch_recoveries();
    return result;
  } catch (error) {
    const stage = error.launch?.stage || (record.direct && error.preflight ? "not_started" : undefined);
    const prefix = stage === "not_started" ? (previous ? "本次请求未执行，原启动结果仍待确认：" : "本次请求未执行：") : stage === "created" ? "房间已创建，启动结果待确认："
      : stage === "started" ? "自动推进已启用，接入结果待确认：" : "启动结果尚未确认，请沿用原请求重试：";
    error.message = prefix + error.message;
    const latest = localStorage.getItem(key);
    const owns_attempt = latest && JSON.parse(latest).attempt_id === record.attempt_id;
    if (owns_attempt && stage === "not_started" && !previous) localStorage.removeItem(key);
    else if (owns_attempt) {
      record.error = error.message;
      record.room_id = error.launch?.room_id || record.room_id;
      if (record.room_id) save_room_credentials({ id: record.room_id }, record.input.token, record.input.room?.members || []);
      localStorage.setItem(key, JSON.stringify(record));
    }
    refresh_launch_recoveries();
    throw error;
  }
}

/** Explicitly replay one saved request without adopting newly edited client defaults. */
async function resume_launch(id) {
  const record = stored_launches().find(item => item.id === id);
  if (!record || state.directory_pending.has(`launch-${id}`)) return;
  state.directory_pending.set(`launch-${id}`, true);
  state.launch.error = "";
  publish_view();
  try {
    const result = await submit_local_launch(record.input, record.title, record.direct, record.signature);
    if (state.pending_room?.id === id && state.pending_room.signature === JSON.stringify({
      payload: room_creation_payload(record.input.room?.folder_id ?? null), launch_draft: record.direct ? null : creation_launch_options() })) {
      element("room-form").reset();
      reset_creation_mode();
      render_expert_inputs("new-expert-modes", default_experts());
      state.launch.create = true;
      element("room-dialog").close();
    }
    if (!record.direct) clear_launch_overrides(record.input);
    state.launch.notice = result.status === "running" ? "已核对原启动，实际执行请查看进度回执" : "已核对原房间状态；不会自动恢复已暂停或结束的讨论";
    state.directory_error = "";
    if (state.pending_room?.id === id) state.pending_room = null;
    await select_room(result.room.id);
  } catch (error) { state.launch.error = error.message; }
  finally { state.directory_pending.delete(`launch-${id}`); render_launch_settings(); publish_view(); }
}

/** Remove only a browser retry intent, leaving remote rooms and running work untouched. */
function discard_launch(id) {
  localStorage.removeItem(LAUNCH_PENDING_PREFIX + id);
  if (state.pending_room?.id === id) state.pending_room = null;
  state.launch.error = "";
  refresh_launch_recoveries();
}

/** Load reusable client settings once; this neither registers rooms nor starts AI. */
async function load_launch_settings() {
  const local = ["127.0.0.1", "localhost"].includes(location.hostname);
  state.launch.room_models = null;
  state.launch.model_catalogs = {};
  state.launch.connect_command = local ? "codiscuss local open" : `codiscuss local connect "${location.origin}"`;
  try {
    local_connection = null;
    local_connection = restore_local_connection();
    state.launch.remote = Boolean(local_connection);
    if (local_connection) state.launch.connect_command = `codiscuss local connect "${location.origin}"`;
    if (!local_connection && !local) return;
    const settings = await local_launch_request("settings");
    // Keep the saved machine defaults so every new form can start from them again.
    state.launch.saved_profiles = JSON.parse(JSON.stringify(settings.participants || {}));
    Object.assign(state.launch, { available: true, profiles: settings.participants, api_providers: settings.api_providers || {}, api_keys: settings.api_keys || {},
      scheduler_providers: settings.scheduler_providers || {}, error: "",
      notice: local_connection ? "已连接本机服务，讨论保存在当前网站" : "" });
    Object.values(state.launch.profiles).forEach(fill_api_key);
    // Settings arrive after the form was reset; only an untouched draft gets the default.
    if (!Object.keys(state.launch.scheduler).length) state.launch.scheduler = default_scheduler();
    load_room_models();
  } catch (error) { state.launch.available = false; state.launch.room_models = null; state.launch.error = error.message; }
  finally { refresh_launch_recoveries(); render_launch_settings(); publish_view(); }
}

/** Re-check the local connection and explain when nothing has been connected yet. */
async function retry_launch_connection() {
  await load_launch_settings();
  if (state.launch.available || state.launch.error) return;
  state.launch.error = "尚未检测到本机连接，请先在运行 AI 的电脑上执行上方命令并完成网页授权。";
  publish_view();
}

/** Read saved choices for the active room without using drafts or delaying discussion refreshes. */
async function load_room_models() {
  const room = state.room;
  if (!state.launch.available || room?.runtime?.mode !== "automatic") return;
  const previous = state.launch.room_models;
  if (previous?.room_id === room.id && previous.revision === room.runtime.revision
    && (previous.loading || previous.participants)) return;
  const current = { room_id: room.id, revision: room.runtime.revision, loading: true, participants: null };
  state.launch.room_models = current;
  try {
    const result = await local_launch_request("room-models", { room_id: room.id });
    if (state.launch.room_models !== current || state.room?.id !== room.id) return;
    if (result.room_id === room.id) current.participants = result.participants;
  } catch { /* Unavailable or older bridges leave the model explicitly unknown. */ }
  finally {
    current.loading = false;
    if (state.launch.room_models === current && state.room?.id === room.id) publish_view();
  }
}

/** Describe registered launch choices without claiming the software's effective defaults are known. */
function participant_model(name, room, saved) {
  // Nothing to say beats a placeholder: a manual member's settings live in its own session and unread ones are not guessed.
  if (room?.runtime?.mode !== "automatic" || (room.members || []).find(member => member.name === name)?.access === "manual") return "";
  const profile = saved?.room_id === room.id ? saved.participants?.[name] : null;
  if (!profile) return "";
  if (["codex", "antigravity"].includes(profile.adapter)) return "模型与强度由 App 设置";
  const model = profile.model || "默认模型";
  const effort = profile.effort || (profile.adapter === "antigravity_cli" ? "模型默认强度" : "默认强度");
  return `${model} · ${effort}`;
}

/** Label how a member answers: the registered adapter says API / App; other locally woken members are CLI. */
function participant_access(name, room) {
  const member = (room?.members || []).find(item => item.name === name);
  const adapter = member?.adapter;
  if (member?.access === "manual") return "手动启动";
  if (adapter === "api") return "API";
  if (["codex", "antigravity"].includes(adapter)) return "App";
  return room?.experts?.[name] === "cli" ? "CLI" : "在线";
}

// App and web clients keep model selection in the original conversation.
const MODEL_CLIENTS = ["codex_cli", "claude", "antigravity_cli"];
const MODEL_SOURCE_LABELS = { "codex-app-server": "来自 Codex CLI 模型列表", "claude-cli": "来自 Claude CLI 模型列表", "antigravity-cli": "来自 Antigravity CLI 模型列表" };

/** Keep discoveries separate for each software executable, shared by its participant instances. */
function model_catalog_key(profile) {
  if (profile.adapter === "api") return JSON.stringify([profile.adapter, profile.base_url, profile.api_protocol, profile.api_key_ref]);
  if (profile.adapter === "antigravity_cli") return JSON.stringify([profile.adapter, profile.executable || "", profile.model || ""]);
  return JSON.stringify([profile.adapter, profile.executable || ""]);
}

/** Send a key directly to the local private store; never put plaintext in snapshots or saved drafts. */
async function save_launch_api_key(name, api_key) {
  const profile = state.launch.profiles[name];
  const base_url = profile.base_url;
  const result = await local_launch_request("api-key", { base_url, api_key });
  state.launch.api_keys = { ...state.launch.api_keys, [new URL(base_url).href.replace(/\/+$/, "")]: result.api_key_ref };
  if (state.launch.profiles[name] === profile && profile.base_url === base_url) profile.api_key_ref = result.api_key_ref;
  publish_view();
}

/** Ask the local service to send one tiny request with the current API profile; throws its reason on failure. */
async function check_launch_api(name) {
  const { base_url, api_protocol, model, api_key_ref } = state.launch.profiles[name] || {};
  await local_launch_request("api-check", { adapter: "api", base_url, api_protocol, model, api_key_ref });
}

/** Provide selectable software results without turning an unavailable list into a text field. */
function launch_model_state(name, launch = state.launch) {
  const profile = launch.profiles[name] || {};
  if (profile.adapter === "api") {
    const catalog = launch.model_catalogs?.[model_catalog_key(profile)];
    const preset = launch.api_providers?.[platform_of(name)];
    // Without the local service there are no presets, and two missing addresses are not an official match.
    const official = Boolean(preset) && profile.base_url?.replace(/\/$/, "") === preset.base_url;
    const models = catalog?.models || (official ? preset.models.map(id => ({ id, label: id })) : []);
    return { supported: true, items: models.map(model => ({ label: model.label && model.label !== model.id ? `${model.label} · ${model.id}` : model.id, value: model.id })),
      loading: Boolean(catalog?.loading), error: catalog?.error || "", source: catalog ? "来自 API 模型列表" : "官方推荐，可输入其他模型 ID" };
  }
  const catalog = launch.model_catalogs?.[model_catalog_key(profile)];
  const models = catalog?.models || [];
  const selected = models.find(model => model.id === profile.model);
  const items = [{ label: "软件默认模型", value: "__default__" }, ...models.map(model => ({ label: model.label || model.id, value: model.id }))];
  if (profile.model && !selected) items.push({ label: `${profile.model}（已保存，列表未确认）`, value: profile.model, disabled: true });
  return { supported: MODEL_CLIENTS.includes(profile.adapter), items, loading: Boolean(catalog?.loading),
    efforts: profile.adapter === "antigravity_cli" ? catalog?.efforts : selected?.efforts, source: MODEL_SOURCE_LABELS[catalog?.source] || catalog?.source || "",
    effort_note: profile.adapter === "antigravity_cli" ? catalog?.effort_error || (catalog?.loading ? "正在读取原生思考档位…" : "默认强度由 CLI 决定。") : !selected
      ? "选择模型后显示可用思考强度；默认值由软件决定。" : "所选模型不提供单独思考强度。",
    error: catalog?.error || (!launch.available ? "连接本机服务后读取模型列表" : !catalog ? "尚未读取此软件的模型列表" : "") };
}

/** Read model metadata only; never launch an AI task or persist discovered choices as defaults. */
async function load_launch_models(name, force = false) {
  const profile = state.launch.profiles[name] || {};
  if (!state.launch.available || (!MODEL_CLIENTS.includes(profile.adapter) && profile.adapter !== "api")) return;
  if (profile.adapter === "api" && (!force || !profile.api_key_ref)) return;
  const catalogs = state.launch.model_catalogs ||= {}, key = model_catalog_key(profile);
  if (catalogs[key]?.loading || (!force && catalogs[key])) return;
  const fallback = profile.adapter === "antigravity_cli" ? catalogs[model_catalog_key({ ...profile, model: "" })] : null;
  const current = { models: fallback?.models || [], loading: true, error: "", source: "" };
  const input = profile.adapter === "api" ? { adapter: "api", base_url: profile.base_url, api_protocol: profile.api_protocol, model: profile.model || "discovery", api_key_ref: profile.api_key_ref }
    : { adapter: profile.adapter, ...(profile.executable ? { executable: profile.executable } : {}),
      ...(profile.adapter === "antigravity_cli" && profile.model ? { model: profile.model } : {}), ...(force ? { refresh: true } : {}) };
  catalogs[key] = current;
  publish_view();
  try {
    const result = await local_launch_request("models", input);
    if (result.adapter !== input.adapter) throw new Error("模型列表与所选软件不一致");
    current.models = result.models || [];
    current.source = result.source || "";
    current.efforts = result.efforts;
    current.effort_error = result.effort_error || "";
    current.error = result.error || (!current.models.length ? "软件未返回可用模型，可使用默认模型" : "");
  } catch (error) { current.error = error.message; }
  finally {
    current.loading = false;
    if (state.launch.model_catalogs === catalogs) { render_launch_settings(); publish_view(); }
  }
}

/** Accept a discovered model and clear an effort no longer supported by that model. */
function write_launch_model(name, value) {
  const model = value === "__default__" ? "" : value;
  write_launch_field(name, "model", model);
  const levels = launch_model_state(name).efforts;
  if (!levels?.includes(state.launch.profiles[name].effort)) write_launch_field(name, "effort", "");
  if (state.launch.profiles[name].adapter === "antigravity_cli") load_launch_models(name);
}

/** Reuse the key last saved on this machine for the same API root instead of asking again. */
function fill_api_key(profile) {
  if (profile?.adapter !== "api" || profile.api_key_ref || !profile.base_url) return;
  let root;
  try { root = new URL(profile.base_url).href.replace(/\/+$/, ""); } catch { return; }
  const ref = state.launch.api_keys?.[root];
  if (ref) profile.api_key_ref = ref;
}

/** Keep software drafts separate from shared room records and from discussion advancement mode. */
function write_launch_field(name, field, value) {
  if (name === "workspace") state.launch.workspace[field] = value;
  else if (name === "create") state.launch.create = Boolean(value);
  else {
    state.launch.profiles[name] ||= {};
    if (field === "allowed_tools") value = value.split("\n").map(item => item.trim()).filter(Boolean);
    if (["model", "effort"].includes(field)) value = value.trim();
    state.launch.profiles[name][field] = value;
    if (field === "adapter" && value === "api") {
      const profile = state.launch.profiles[name], preset = state.launch.api_providers?.[platform_of(name)];
      if (preset && !profile.base_url) Object.assign(profile, { base_url: preset.base_url, api_protocol: preset.api_protocol, model: preset.models[0] });
      for (const key of ["effort", "session_id", "project_access", "cwd", "project_id", "project_name", "executable", "source_thread_id", "ipc_directory", "allowed_tools"]) delete profile[key];
    }
    if (state.launch.profiles[name].adapter === "api") state.launch.profiles[name].project_access = "read";
    if (field === "base_url") delete state.launch.profiles[name].api_key_ref;
    fill_api_key(state.launch.profiles[name]);
  }
  state.launch.notice = "";
  if (field === "adapter") render_launch_settings();
  else render_launch_summaries();
  publish_view();
}

/** Put one instance's draft back exactly as it was, including fields that were never set. */
function restore_launch_profile(name, profile) {
  state.launch.profiles[name] = JSON.parse(JSON.stringify(profile));
  render_launch_settings();
  publish_view();
}

/** Capture local overrides before asynchronous work or navigation can change the draft. */
function launch_options() {
  const draft = JSON.parse(JSON.stringify({ participants: state.launch.profiles, ...state.launch.workspace, entry: "web" }));
  for (const profile of Object.values(draft.participants)) if (profile.adapter === "api") profile.project_access = "read";
  return draft;
}

/** A new room also carries the optional smart scheduling choice; only a complete, enabled choice is sent. */
function creation_launch_options() {
  const { enabled, provider, model, api_key_ref } = state.launch.scheduler;
  return { ...launch_options(), ...(enabled && provider && model && api_key_ref ? { scheduler: { provider, model, api_key_ref } } : {}) };
}

/** Choose whether the new discussion's host writes named follow-ups for each expert between rounds. */
function write_named_followup(value) {
  state.named_followup = Boolean(value);
  publish_view();
}

/** Choose whether a new room opens a discussion right away; the room itself is always the same collaboration room. */
function write_create_discussion(value) {
  state.create_discussion = Boolean(value);
  publish_view();
}

/** A fresh form turns smart scheduling on when some provider already has a saved key. */
function default_scheduler() {
  const providers = state.launch.scheduler_providers || {};
  const provider = Object.keys(providers).find((name) => state.launch.api_keys?.[providers[name].base_url]);
  if (!provider) return {};
  const { base_url, models } = providers[provider];
  return { enabled: true, provider, model: models[0] || "", api_key_ref: state.launch.api_keys[base_url] };
}

/** Change the smart scheduling draft; a new provider starts from its preset model and any key saved for its root. */
function write_scheduler(field, value) {
  const scheduler = state.launch.scheduler;
  scheduler[field] = value;
  if (field === "provider" || (field === "enabled" && value && !scheduler.provider)) {
    scheduler.provider ||= Object.keys(state.launch.scheduler_providers || {})[0] || "";
    const preset = state.launch.scheduler_providers?.[scheduler.provider];
    scheduler.model = preset?.models[0] || "";
    scheduler.api_key_ref = preset ? state.launch.api_keys?.[preset.base_url] || "" : "";
  }
  publish_view();
}

/** Ask the local service to send the decision model one tiny question; throws its reason on failure. */
async function check_scheduler() {
  const { provider, model, api_key_ref } = state.launch.scheduler;
  await local_launch_request("scheduler-check", { provider, model, api_key_ref });
}

/** Save the scheduling provider's key to the local private store, under that provider's official root. */
async function save_scheduler_api_key(api_key) {
  const scheduler = state.launch.scheduler;
  const base_url = state.launch.scheduler_providers?.[scheduler.provider]?.base_url;
  if (!base_url) throw new Error("请先选择智能调度供应商");
  const result = await local_launch_request("api-key", { base_url, api_key });
  state.launch.api_keys = { ...state.launch.api_keys, [base_url]: result.api_key_ref };
  if (state.launch.scheduler === scheduler && state.launch.scheduler_providers[scheduler.provider].base_url === base_url) scheduler.api_key_ref = result.api_key_ref;
  publish_view();
}

/** Describe effective placement and binding from the same explicit draft sent to the launcher. */
function launch_summary(name) {
  const profile = state.launch.profiles[name] || {};
  if (profile.adapter === "api") return { client: `API · ${profile.model || "待选择模型"}`, session: "按房间记录接续",
    cwd: "不访问本地文件", project: "房间上下文", access: "项目只读" };
  if (!profile.adapter) return { client: "尚未选择客户端", session: "尚未配置",
    cwd: "选择客户端后确定", project: "选择客户端后确定" };
  const cli_directory = ["codex_cli", "claude", "antigravity_cli"].includes(profile.adapter);
  const project_name = profile.project_name || state.launch.workspace.discussion_project;
  const project_id = profile.project_id;
  const metadata_only = ["codex_cli", "claude"].includes(profile.adapter);
  const fixed_project = profile.session_id && !metadata_only;
  const project = fixed_project ? "沿用指定会话的项目" : metadata_only
    ? (project_name ? `${project_name}（任务说明，不切换软件项目）` : "不指定项目，按工作目录执行")
    : profile.adapter === "codex" ? [project_name, project_id ? `ID: ${project_id}` : ""].filter(Boolean).join(" · ") || "无项目聊天"
      : project_id || project_name || "软件默认项目";
  const directory = profile.cwd || state.launch.workspace.cwd;
  const access = !cli_directory ? "按 App 权限" : !directory ? "无项目目录"
    : launch_access(name) === "write" ? "项目可写" : "项目只读";
  const label = LAUNCH_CLIENTS[name]?.find(item => item.value === profile.adapter)?.label || "尚未选择客户端";
  const choice = [profile.model, profile.effort && `${profile.effort} 档`].filter(Boolean).join(" · ");
  return { client: cli_directory && choice ? `${label} · ${choice}` : label,
    session: profile.session_id ? "复用指定会话" : "新建会话",
    cwd: !cli_directory && profile.session_id ? "沿用指定会话的目录"
      : directory || (cli_directory ? "本次讨论的私有目录" : "由 App 项目确定"), project, access };
}

/** Clients whose existing conversation the runner can resume by ID; agy and API always start their own. */
const SESSION_CLIENTS = ["codex_cli", "codex", "claude"];
function launch_can_bind_session(name, launch = state.launch) {
  return SESSION_CLIENTS.includes(launch.profiles[name]?.adapter);
}

/** Only native CLI adapters expose a project read/write choice in this page. */
function launch_can_set_access(name, launch = state.launch) {
  return MODEL_CLIENTS.includes(launch.profiles[name]?.adapter);
}

/** API participants remain read-only regardless of inherited workspace or stale profile settings. */
function launch_access(name) {
  if (state.launch.profiles[name]?.adapter === "api") return "read";
  return state.launch.profiles[name]?.project_access || state.launch.workspace.project_access || "read";
}

/** Classic select options; an empty value inherits the launch-wide setting. */
function access_options(value = "", inherit = "") {
  const options = [...(inherit ? [["", inherit]] : []), ["read", "只读"], ["write", "可写"]];
  return options.map(([key, label]) => `<option value="${key}" ${(value || (inherit ? "" : "read")) === key ? "selected" : ""}>${label}</option>`).join("");
}

/** Refresh classic readbacks without replacing the input currently being edited. */
function render_launch_summaries() {
  document.querySelectorAll("[data-launch-summary]").forEach(node => {
    const name = node.dataset.launchSummary;
    if (!LAUNCH_CLIENTS[name]) return;
    const summary = launch_summary(name);
    node.textContent = `${summary.session} · 工作目录：${summary.cwd}（${summary.access}） · 项目：${summary.project}`;
  });
}

/** Consume only the successful launch's transient fields, preserving edits made while waiting. */
function clear_launch_overrides(draft) {
  for (const [name, profile] of Object.entries(draft.participants)) {
    for (const field of ["session_id", "project_access"]) {
      if (state.launch.profiles[name]?.[field] === profile[field]) delete state.launch.profiles[name]?.[field];
    }
  }
  for (const field of ["cwd", "discussion_project", "project_access"]) {
    if (state.launch.workspace[field] === draft[field]) delete state.launch.workspace[field];
  }
  render_launch_settings();
  publish_view();
}

/** Let the user browse for the project folder on the computer running the local service. */
async function pick_launch_directory() {
  try {
    const result = await local_launch_request("pick-directory", {});
    if (result.path) write_launch_field("workspace", "cwd", result.path);
    state.launch.error = "";
  } catch (error) { state.launch.error = error.message; }
  publish_view();
}

/** Save machine defaults without per-discussion session IDs or project write access. */
async function save_launch_defaults() {
  // Defaults are per platform; an extra instance's model and effort apply to its own discussion only.
  const participants = Object.fromEntries(Object.entries(launch_options().participants).filter(([name]) => platform_of(name) === name).map(([name, profile]) => {
    const { session_id, project_access, ...defaults } = profile;
    return [name, defaults];
  }));
  try {
    await local_launch_request("settings", { participants });
    state.launch.saved_profiles = { ...state.launch.saved_profiles, ...JSON.parse(JSON.stringify(participants)) };
    state.launch.notice = "已保存本机软件配置，后续讨论可复用";
    state.launch.error = "";
  } catch (error) { state.launch.error = error.message; }
  render_launch_settings();
  publish_view();
}

/** Start an existing room with local client configuration, preserving browser ownership credentials. */
async function launch_current_room() {
  const room_id = state.room.id;
  try {
    const key = `discuss-access:${room_id}`;
    let token = localStorage.getItem(key);
    if (!token) throw new Error("此浏览器缺少房间凭据，请使用创建房间的浏览器");
    const draft = launch_options();
    const result = await submit_local_launch({ ...draft, room_id, token }, state.room.title || "已有讨论");
    clear_launch_overrides(draft);
    state.launch.notice = result.status === "running" ? "启动已提交，实际执行请查看进度回执" : "本次启动已有记录，请查看房间状态";
    state.launch.error = "";
    if (state.room?.id === room_id) await refresh_room();
  } catch (error) { state.launch.error = error.message; }
  render_launch_settings();
  publish_view();
}

/** Load the selected paused room's original connection paths after proving browser ownership. */
async function load_room_configuration() {
  const room_id = state.room.id;
  state.launch.repair_error = '';
  try {
    const token = localStorage.getItem(`discuss-access:${room_id}`);
    if (!token) throw new Error('此浏览器缺少房间凭据，请使用原浏览器或原接入配置');
    const result = await local_launch_request('room-config', { room_id, token });
    if (state.room?.id === room_id) state.launch.repair = { ...result, notice: '' };
  } catch (error) { if (state.room?.id === room_id) state.launch.repair_error = error.message; }
  render_room_configuration();
  publish_view();
}

/** Edit only the connection field displayed for this room, separately from machine defaults. */
function write_room_connection(name, value) {
  const repair = state.launch.repair;
  if (repair?.room_id !== state.room?.id || !repair.participants[name]) return;
  const profile = repair.participants[name];
  profile[profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable'] = value;
  repair.notice = '';
  publish_view();
}

/** Change Codex's entrypoint in this room's draft, retaining its private session binding. */
function write_room_adapter(name, value) {
  const repair = state.launch.repair;
  const profile = repair?.participants[name];
  if (repair?.room_id !== state.room?.id || !['codex', 'codex_cli'].includes(profile?.adapter)
    || !['codex', 'codex_cli'].includes(value)) return;
  profile.adapter = value;
  repair.notice = '';
  publish_view();
}

/** Save a version-checked connection change without automatically restarting the discussion. */
async function save_room_configuration() {
  const repair = state.launch.repair;
  if (repair?.room_id !== state.room?.id) return;
  const participants = Object.fromEntries(Object.entries(repair.participants).map(([name, profile]) => {
    const field = profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable';
    return [name, { [field]: profile[field], ...(['codex', 'codex_cli'].includes(profile.adapter) ? { adapter: profile.adapter } : {}) }];
  }));
  state.launch.repair_error = '';
  try {
    const token = localStorage.getItem(`discuss-access:${repair.room_id}`);
    if (!token) throw new Error('此浏览器缺少房间凭据，请重新核对');
    const result = await local_launch_request('room-config', { room_id: repair.room_id, token,
      version: repair.version, runtime_revision: repair.runtime_revision, participants });
    if (state.room?.id === repair.room_id) {
      state.launch.repair = { ...result, notice: result.applied ? '本场接入设置已保存，服务已采用；可在进度看板重启并核对实际发言。'
        : '本场接入设置已保存；服务尚未确认采用，请先核对本机服务再重启。' };
      await refresh_room();
    }
  } catch (error) { if (state.room?.id === repair.room_id) state.launch.repair_error = error.message; }
  render_room_configuration();
  publish_view();
}

/** Keep the classic theme's paused-room correction controls in sync with the shared draft. */
function render_room_configuration() {
  const panel = element('local-room-configuration');
  if (!panel) return;
  const runtime = state.room?.runtime;
  panel.hidden = !state.launch.available || state.launch.remote || runtime?.mode !== 'automatic' || runtime.status !== 'paused' || state.room?.archived;
  element('local-launch-settings').parentElement.hidden = runtime?.mode !== 'automatic' || (state.launch.available && runtime.status !== 'ready');
  const repair = state.launch.repair?.room_id === state.room?.id ? state.launch.repair : null;
  const fields = element('local-room-configuration-fields');
  if (fields.dataset.roomId !== state.room?.id || !fields.contains(document.activeElement)) {
    fields.innerHTML = repair ? Object.entries(repair.participants).map(([name, profile]) => {
      const field = profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable';
      const adapter = ['codex', 'codex_cli'].includes(profile.adapter) ? `<label>${escape_html(name)} · 接入方式<select data-room-adapter="${escape_html(name)}"><option value="codex"${profile.adapter === 'codex' ? ' selected' : ''}>Codex App</option><option value="codex_cli"${profile.adapter === 'codex_cli' ? ' selected' : ''}>Codex CLI</option></select></label>` : '';
      return `${adapter}<label>${escape_html(name)} · ${field === 'ipc_directory' ? 'Sidecar 目录' : '软件路径'}<input data-room-connection="${escape_html(name)}" value="${escape_html(profile[field] || '')}"></label>`;
    }).join('') : '';
    fields.dataset.roomId = state.room?.id || '';
  }
  element('local-room-configuration-save').hidden = !repair;
  element('local-room-configuration-notice').textContent = state.launch.repair_error || repair?.notice || '';
}

/** Render the same local setup controls in the classic theme. */
/** Keep the classic form on the same read-only catalog contract as the role cards. */
function render_launch_model_fields(name) {
  const catalog = launch_model_state(name), profile = state.launch.profiles[name] || {};
  if (!catalog.supported) return "";
  const models = catalog.items.map(item => `<option value="${escape_html(item.value)}" ${item.value === (profile.model || "__default__") ? "selected" : ""} ${item.disabled ? "disabled" : ""}>${escape_html(item.label)}</option>`).join("");
  const efforts = [{ label: "默认强度", value: "" }, ...(catalog.efforts || []).map(value => ({ label: value, value }))];
  const strength = catalog.efforts?.length ? `<label>思考强度<select data-launch-name="${name}" data-launch-field="effort">${efforts.map(item => `<option value="${item.value}" ${item.value === (profile.effort || "") ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>` : "";
  return `<label>模型<select data-launch-name="${name}" data-launch-field="model">${models}</select></label><p class="local-note">${escape_html(catalog.loading ? "正在读取软件模型列表…" : catalog.error || catalog.source)}</p>${strength}`;
}

function render_launch_settings() {
  for (const id of ["local-launch-settings", "new-local-launch-settings"]) {
    const container = element(id);
    if (!container) continue;
    container.hidden = !state.launch.available;
    container.parentElement.hidden = false;
    const create_toggle = container.parentElement.querySelector('[data-launch-name="create"]');
    if (create_toggle) { create_toggle.checked = state.launch.create; create_toggle.disabled = !state.launch.available; }
    container.innerHTML = Object.entries(LAUNCH_CLIENTS).map(([name, clients]) => {
      const profile = state.launch.profiles[name] || {};
      const fields = profile.adapter === "antigravity" ? [["ipc_directory", "Sidecar IPC 目录"]]
        : [["executable", "原生可执行文件路径"]];
      if (profile.adapter === "codex") fields.push(["source_thread_id", "来源聊天 ID（新建会话时使用）"]);
      if (profile.adapter === "claude") fields.push(["allowed_tools", "允许的工具（每行一项，可选）"]);
      fields.push(["session_id", "复用会话 ID（仅本次，可选）"], ["cwd", "此 AI 的工作目录（可选）"], ["project_name", "此 AI 的项目（可选）"]);
      if (["codex", "antigravity", "antigravity_cli"].includes(profile.adapter)) fields.push(["project_id", "软件中的项目 ID（可选）"]);
      const summary = launch_summary(name);
      const permission = launch_can_set_access(name) ? `<label>此 AI 的项目文件<select data-launch-name="${name}" data-launch-field="project_access">${access_options(profile.project_access, "沿用本次设置")}</select></label>`
        : profile.adapter === "api" ? `<p class="local-note">项目文件只读</p>` : "";
      return `<fieldset><legend>${name}</legend><p class="local-note" data-launch-summary="${name}">${summary.session} · 工作目录：${escape_html(summary.cwd)}（${summary.access}） · 项目：${escape_html(summary.project)}</p><label>执行客户端<select data-launch-name="${name}" data-launch-field="adapter"><option value="">选择 CLI / App</option>${clients.map(client => `<option value="${client.value}" ${profile.adapter === client.value ? "selected" : ""}>${client.label}</option>`).join("")}</select></label>${render_launch_model_fields(name)}${fields.map(([field, label]) => `<label>${label}<textarea rows="${field === "allowed_tools" ? 2 : 1}" data-launch-name="${name}" data-launch-field="${field}">${escape_html(Array.isArray(profile[field]) ? profile[field].join("\n") : profile[field] || "")}</textarea></label>`).join("")}${permission}</fieldset>`;
    }).join("") + (Object.keys(state.launch.profiles).some(name => launch_can_set_access(name)) ? `<label>本次 CLI 项目文件<select data-launch-name="workspace" data-launch-field="project_access">${access_options(state.launch.workspace.project_access)}</select></label>` : "")
      + `<label>本次工作目录（可选）<input data-launch-name="workspace" data-launch-field="cwd" value="${escape_html(state.launch.workspace.cwd || "")}"></label><label>本次 AI 项目（可选）<input data-launch-name="workspace" data-launch-field="discussion_project" value="${escape_html(state.launch.workspace.discussion_project || "")}"></label>`;
  }
  for (const id of ["local-launch-notice", "new-local-launch-notice"]) {
    if (element(id)) element(id).textContent = [state.launch.error || state.launch.notice,
      !state.launch.available && state.launch.connect_command ? `在这台电脑运行 ${state.launch.connect_command}，使用命令打开的网页完成连接。` : ""].filter(Boolean).join(" ");
  }
  for (const id of ["local-launch-save", "new-local-launch-save"]) if (element(id)) element(id).disabled = !state.launch.available;
  if (element("local-launch-start")) element("local-launch-start").disabled = !state.launch.available || state.room?.runtime?.mode !== "automatic" || state.room?.runtime?.status !== "ready";
  render_room_configuration();
}

/** Persist a manually edited summary with the snapshot it was based on. */
async function save_context(event) {
  event.preventDefault();
  await request_json(`/api/rooms/${state.room.id}/state`, { actor: "用户", text: element("state-input").value, brief: element("brief-input").value, until: state.snapshot_id });
  state.context_dirty = false;
  await refresh_room();
  show_toast("讨论状态已保存，原始记录保持不变");
}

/** Copy a participation entrypoint without bundling any discussion context. */
async function copy_context(mode = "online") {
  const members = access_snapshot().members.filter(member => (member.access === "online") === (mode === "online"));
  const selected = mode === "online" ? members.find(member => member.name === element("author-select").value) : null;
  const member = selected || (members.length === 1 ? members[0] : null);
  if (member) return copy_member_join(member.name);
  select_tab("access");
  show_toast("请在接入页选择具体成员的「参与说明」");
}

/** Copy a bounded background startup contract without starting any external task. */
async function copy_background() {
  return copy_context("cli");
}

/** Keep optional app placement local and include it in manual cold-start instructions. */
function workspace_instruction() {
  const workspace = runtime_workspace();
  const lines = [workspace.discussion_project ? `讨论所属项目：${workspace.discussion_project}` : "",
    workspace.cwd ? `工作目录 cwd：${workspace.cwd}` : ""].filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n请在对应项目和目录中打开会话；实际文件权限以软件配置为准。` : "";
}

/** Persist only optional local placement fields, never public room metadata. */
function runtime_workspace() {
  const workspace = { discussion_project: element("runtime-project").value.trim() || undefined,
    cwd: element("runtime-cwd").value.trim() || undefined };
  localStorage.setItem(`discuss-workspace:${state.room.id}`, JSON.stringify(workspace));
  return workspace;
}

/** Describe a selected mode separately from actual execution. */
function runtime_label(runtime = {}) {
  const mode = runtime.mode === "automatic" ? "全自动讨论" : "手动复制冷启动";
  const status = runtime.expired ? "已到截止时间" : ({ ready: "尚未启动", running: "运行已启用，实际进展以执行回执为准", paused: "已暂停", stopped: "已停止", concluded: "已收束" }[runtime.status] || "尚未启动");
  return `${mode} · ${status}`;
}

/** Show only persisted business evidence, including actionable failure details. */
function execution_label(event) {
  if (!event) return "尚无自动执行回执";
  const status = { pending: "待接入", dispatched: "已交付，等待开始", started: "实际执行中", completed: "本步已完成", cancelled: "已撤销", failed: "需要处理" }[event.status] || event.status;
  return `${event.participant} · ${status}${event.result ? ` · ${event.result}` : ""}`;
}

/** Save an explicit mode selection; never start software from a preference change. */
async function choose_runtime(mode) {
  const room_id = state.room.id;
  const path = `/api/rooms/${room_id}/runtime`;
  const runtime = await request_json(path);
  if (runtime.mode !== mode) {
    if (!localStorage.getItem(`discuss-access:${room_id}`)) throw new Error("此浏览器缺少房间控制凭据，请使用创建房间的浏览器");
    await request_json(path, { action: "configure", mode, revision: runtime.revision });
  }
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(mode === "automatic" ? "已选择全自动；请完成本机接入配置后启动" : "已选择手动复制冷启动");
}

/** Pause automatic execution, or the topic phase when no run is active. */
async function pause_discussion() {
  if (state.room.runtime?.status === "running") return pause_runtime();
  await request_json(`/api/rooms/${state.room.id}/topic`, { actor: "用户", phase: "paused" });
  await refresh_room();
  show_toast("讨论已暂停，原安排保留");
}

/** Resume with the topic's current limits; the server also preserves an active summary deadline. */
async function restart_discussion() {
  const path = `/api/rooms/${state.room.id}/runtime`;
  const runtime = await request_json(path);
  await request_json(path, { action: "start", mode: "automatic", revision: runtime.revision, deadline: 0 });
  await refresh_room();
  show_toast("已重启，原安排会重新交给对应 AI；需本机接入程序保持运行");
}

/** Only the failed attempt for the still-retained task can restart this discussion. */
function can_retry_execution(execution, room) {
  const runtime = room.runtime;
  if (!execution || room.archived || room.phase !== "paused" || runtime?.mode !== "automatic"
    || runtime.status !== "paused" || runtime.latest_execution?.id !== execution.id
    || runtime.latest_execution.status !== "failed") return false;
  const turn = room.current_turn;
  const active_turn = turn && ["pending", "notified"].includes(turn.status);
  return execution.role === "host" ? !active_turn && execution.participant === room.host
    : active_turn && turn.id === execution.turn_id && turn.expert === execution.participant;
}

/** Recheck the selected failed attempt before resuming its retained task with a new execution. */
async function retry_execution(event_id) {
  const room_id = state.room.id;
  const room = await request_json(`/api/rooms/${room_id}`);
  const execution = room.runtime?.failures?.find(item => item.id === event_id);
  if (!can_retry_execution(execution, room)) throw new Error("执行或安排已变化，请刷新后重试");
  await request_json(`/api/rooms/${room_id}/runtime`, {
    action: "start", mode: "automatic", revision: room.runtime.revision, deadline: 0,
  });
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(`已重新安排 ${execution.participant} 执行，原失败记录保留`);
}

/** Skip the selected assignment: the user posts a "skipped" answer for the expert, so the plan moves on to the next one like after any answer. */
async function skip_turn() {
  const room = state.room;
  const turn = room.current_turn;
  if (!turn || !["pending", "notified"].includes(turn.status)) throw new Error("当前没有可跳过的发言安排，请刷新后核对");
  const room_id = room.id, path = `/api/rooms/${room_id}`;
  const runtime = room.runtime || {};
  const resume = runtime.mode === "automatic" && (runtime.status === "paused" || runtime.expired);
  const revision = runtime.revision;
  let saved = false;
  try {
    await request_json(`${path}/messages`, { author: turn.expert, submitted_by: "用户", kind: "opinion", turn_id: turn.id,
      text: "（本次发言已被用户跳过）", submission_id: new_submission_id() });
    saved = true;
    if (resume) await request_json(`${path}/runtime`, { action: "start", mode: "automatic", revision, deadline: 0 });
  } catch (error) {
    if (saved && resume) throw new Error(`本次发言已跳过，但未能继续讨论：${error.message}。核对后可点“重启”继续`);
    throw error;
  } finally {
    if (state.room?.id === room_id) await refresh_room();
  }
  if (state.room?.id === room_id) show_toast("已跳过本次发言，按计划交给下一位");
}

/** Resume the automatic run after the user reopens a concluded discussion. */
async function resume_after_limit_decision() {
  const path = `/api/rooms/${state.room.id}/runtime`;
  const runtime = await request_json(path);
  await request_json(path, { action: "start", mode: "automatic", revision: runtime.revision, deadline: 0 });
}

/** Reopen a concluded discussion with a fresh round and time budget; history stays. */
async function reopen_discussion({ max_rounds, max_minutes }) {
  await request_json(`/api/rooms/${state.room.id}/limits`, { actor: "用户", action: "reopen", max_rounds, max_minutes });
  await resume_after_limit_decision();
  await refresh_room();
  show_toast("讨论已重启，按新的轮次与时长上限继续");
}

/** End early without a summary, keeping every original message. */
async function conclude_discussion() {
  const turn = state.room.current_turn;
  if (turn && ["pending", "notified"].includes(turn.status)) {
    await request_json(`/api/rooms/${state.room.id}/turns/${turn.id}`, { actor: "用户", status: "cancelled" });
  }
  await request_json(`/api/rooms/${state.room.id}/topic`, { actor: "用户", phase: "concluded" });
  await refresh_room();
  show_toast("讨论已直接收束，历史记录保留");
}

/** Turn this free room into a discussion within the given limits and start the run; the local service takes it over at its next check. */
async function start_room_discussion({ goal, max_rounds, max_minutes, execution_minutes = 0, named_followup = false }) {
  const room_id = state.room.id, path = `/api/rooms/${room_id}`;
  if (!localStorage.getItem(`discuss-access:${room_id}`)) throw new Error("此浏览器缺少房间控制凭据，请使用创建房间的浏览器");
  await request_json(`${path}/discussion`, { action: "start", ...(goal ? { goal } : {}), limits: { max_rounds, max_minutes, execution_minutes }, named_followup });
  const runtime = await request_json(`${path}/runtime`);
  await request_json(`${path}/runtime`, { action: "start", mode: "automatic", revision: runtime.revision, deadline: 0 });
  await refresh_room();
  show_toast("讨论已开启，由主持人推进；需本机接入程序保持运行");
}

/** Conclude the discussion and go on as a free room; every message and the conclusion stay. */
async function end_room_discussion() {
  await request_json(`/api/rooms/${state.room.id}/discussion`, { action: "end" });
  await refresh_room();
  show_toast("讨论已结束，房间回到自由协作，历史记录保留");
}

/** Revoke active execution before the local adapters are stopped. */
async function pause_runtime() {
  await request_json(`/api/rooms/${state.room.id}/runtime`, { action: "pause", revision: state.room.runtime.revision });
  await refresh_room();
  show_toast("已暂停；旧执行不能继续写入");
}

/** Download JSON through a temporary object URL without exposing its contents in the page. */
function download_private_json(config, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Give one writable member only its own room-scoped credential. */
function download_member_access(name) {
  const room = state.room, access = access_snapshot();
  const member = access.members.find(item => item.name === name);
  if (!access.can_manage || !member?.available || member.access === "online") throw new Error("当前浏览器没有此成员可下载的私有配置");
  download_private_json({ site: location.origin, room: room.id, token: member_credentials(room.id)[name].token }, `member-${room.id}-${name}.json`);
  state.access_error = "";
  flash_access_notice(`已下载 ${name} 的私有配置`);
}

/** Copy the same room-scoped credential as one line of text for an agent that cannot take a file. */
async function copy_member_access_text(name) {
  const room = state.room, access = access_snapshot();
  const member = access.members.find(item => item.name === name);
  if (!access.can_manage || !member?.available || member.access === "online") throw new Error("当前浏览器没有此成员可复制的凭证");
  await copy_text(JSON.stringify({ site: location.origin, room: room.id, token: member_credentials(room.id)[name].token }));
  flash_access_notice(`已复制 ${name} 的凭证文本（含 token）`);
}

/** Confirm a copy or download briefly in the member rail; the note clears itself. */
function flash_access_notice(message) {
  state.access_error = "";
  state.access_notice = message;
  clearTimeout(state.access_notice_timer);
  state.access_notice_timer = setTimeout(() => {
    if (state.access_notice !== message) return;
    state.access_notice = "";
    publish_view();
  }, TOAST_DURATION_MS);
}

/** Copy a member-specific entry instruction; only the launch variant carries the credential, never conversation context. */
async function copy_member_join(name, with_credential = false) {
  const room = state.room, access = access_snapshot();
  const member = access.members.find(item => item.name === name);
  if (!access.can_manage || !member) throw new Error("请使用房主浏览器选择本房间成员");
  if (with_credential && (member.access !== "manual" || !member.available)) throw new Error("当前浏览器没有此成员可复制的凭证");
  const params = new URLSearchParams({ participant: name, mode: member.access === "online" ? "online" : "cli" });
  const address = `${location.origin}/r/${room.id}?${params}`;
  const skills = `请调用 discuss-participant${room.host === name ? " 和 discuss-host" : ""}。`;
  let instruction;
  if (member.access === "online") instruction = "你是在线只读成员，请在原聊天回答，由用户或授权主持人代发；不要尝试直接写入房间。模型与思考强度在原网页设置。";
  else if (member.access === "runner") instruction = `${skills}等待本机程序交付有效任务，按 task 中的 access_file 和 execution 凭据操作${room.mode === "free" ? "；自由协作的回答必须绑定本次有效 execution_id" : ""}。不要另建定时任务；只处理本次有效执行，失效或撤销后停止提交。下载的持久成员私有文件不能替代自动执行凭据。`;
  else if (with_credential) instruction = `${skills}凭证文本在下方：每条 codiscuss 命令都在同一命令内把它原样设为环境变量 DISCUSS_ACCESS（不回显；首条 room view 也要带，否则无法识别你），命令省略 --access-file；先执行 codiscuss room view ${room.id} --site ${location.origin} --as ${name}，随后立即执行 codiscuss member register ${room.id} --site ${location.origin} --as ${name} 完成注册（只需一次，会话 ID 由程序自动附带，不要自己填写），之后命令保持本站点、房间和身份。模型与思考强度在原软件中设置。${manual_trigger_instruction(room)}${workspace_instruction()}`;
  else instruction = `${skills}使用属于你的私有文件 member-${room.id}-${name}.json，由用户提供它在本机的实际完整路径；先执行 codiscuss room view ${room.id} --site ${location.origin} --as ${name} --access-file "实际完整路径"；随后立即执行 codiscuss member register ${room.id} --site ${location.origin} --as ${name} --access-file "实际完整路径" 完成注册（只需一次，会话 ID 由程序自动附带，不要自己填写），之后命令保持本站点、房间和身份。不要读取或公开文件中的 token；若用户给的是凭证文本而非文件，把它设为环境变量 DISCUSS_ACCESS（不要回显）并省略 --access-file。模型与思考强度在原软件中设置。${manual_trigger_instruction(room)}${workspace_instruction()}`;
  const credential = with_credential ? `
凭证文本（含 token，仅限你使用）：${JSON.stringify({ site: location.origin, room: room.id, token: member_credentials(room.id)[name].token })}` : "";
  await copy_text(`请以 ${name} 身份参与房间。
${instruction}
房间入口：${address}
先核对最新阶段、任务和原文编号，再按房间协议参与。${credential}`);
  if (state.room?.id === room.id) flash_access_notice(with_credential ? `已复制 ${name} 的启动指令（含 token）` : `已复制 ${name} 的参与说明`);
}

/** How a manual member learns it is its turn: free rooms are pulled by the member, discussions only on the host's assignment. */
function manual_trigger_instruction(room) {
  return room.mode === "free" ? "首次复制后，可由人工或软件原生定时触发；自行提交，不必每轮复制回答。"
    : "这是全自动讨论。现在只先了解房间（议题、参与者、已有发言），不要发言，不要自建定时任务；轮到你时会被唤醒。唤醒后先重读最新内容（turn current、新增发言），确认轮到你再认领发言权并提交；没有安排就结束本次检查。";
}

/** Download a private per-room setup file for the independent local runner. */
function export_runtime() {
  const token = localStorage.getItem(`discuss-access:${state.room.id}`);
  if (!token) throw new Error("此浏览器缺少房间控制凭据，请使用创建房间的浏览器");
  const saved = member_credentials(state.room.id);
  // A manual expert answers with its own credential and has nothing for the local service to configure.
  const manual = new Set((state.room.members || []).filter(member => member.access === "manual").map(member => member.name));
  const participants = Object.fromEntries(Object.keys(state.room.experts).filter(name => state.room.experts[name] === "cli" && !manual.has(name))
    .map(name => [name, { adapter: state.launch.profiles[name]?.adapter || "待配置" }]));
  const members = Object.fromEntries(Object.entries(saved).filter(([name]) => !manual.has(name)).map(([name, value]) => [name, { token: value.token }]));
  const workspace = runtime_workspace();
  const config = { site: location.origin, room: state.room.id, token, ...workspace, participants, members };
  download_private_json(config, `discussion-${state.room.id}.json`);
  show_toast("已导出私有接入配置；按部署说明填写本机软件路径，不要公开此文件");
}

/** Supply participation defaults for a new topic. */
function default_experts() { return {}; }

/** Keep a roster per room use and delivery method; software drafts remain per instance. */
function update_creation_mode() {
  const kind = element("new-room-kind").value;
  const key = kind;
  if (key === state.creation_mode) return;
  const previous = { host: element("new-room-host").value, experts: read_expert_inputs("new-expert-modes") };
  state.creation_drafts[state.creation_mode] = previous;
  // The roster starts empty and carries over only members the user added; configured software is never added for them.
  const experts = previous.experts;
  // Discussions run automatically; manual and web members stay available only in free rooms.
  const eligible = kind === "free" ? experts : Object.fromEntries(Object.keys(experts)
    .filter(name => experts[name] === "cli" && LAUNCH_CLIENTS[platform_of(name)]).map(name => [name, "cli"]));
  const local_names = Object.keys(eligible).filter(name => eligible[name] !== "online");
  const draft = state.creation_drafts[key] || { experts: eligible, host: local_names.includes(previous.host) ? previous.host : local_names[0] || "" };
  render_expert_inputs("new-expert-modes", draft.experts);
  render_host_options("new-room-host", Object.keys(draft.experts), draft.host);
  state.creation_mode = key;
  publish_view();
}

/** Preserve dynamic instance names in the hidden select that backs the visible host controls. */
function render_host_options(id, names, selected) {
  const control = element(id);
  control.innerHTML = ["用户", ...names].map(name => `<option value="${escape_html(name)}">${escape_html(display_name(name))}</option>`).join("");
  control.value = selected;
}

/** Owner stop for a free room: void the member's live execution and queued requests. */
async function interrupt_member(member_id) {
  const room_id = state.room.id;
  await request_json(`/api/rooms/${room_id}/members/${member_id}/interrupt`, {});
  if (state.room?.id === room_id) await refresh_room();
}

/** Confirm one ordinary member's suggestion, keeping retries bound to its source and target. */
async function convert_suggestion({ message_id, member_id }) {
  const room_id = state.room.id;
  const result = await request_json(`/api/rooms/${room_id}/suggestions`, { message_id, member_id });
  if (state.room?.id !== room_id) return;
  state.messages = state.messages.map(message => message.id === message_id ? { ...message,
    suggestions: message.suggestions.map(suggestion => suggestion.member_id === member_id
      ? { ...suggestion, request_id: result.request.id } : suggestion) } : message);
  await refresh_room();
}

/** Adopt smart scheduling's recommendation: interrupt the host now, or ask the member once the host is done. */
async function adopt_recommendation({ message_id, mode }) {
  const room_id = state.room.id;
  await request_json(`/api/rooms/${room_id}/recommendations/${message_id}`, { action: "adopt", mode });
  if (state.room?.id === room_id) await refresh_room();
}

/** Rate one smart-scheduling decision; rating null withdraws the verdict. */
async function rate_decision({ decision_id, rating, should_be = "", note = "" }) {
  const room_id = state.room.id;
  await request_json(`/api/rooms/${room_id}/scheduler-decisions/${decision_id}`, { rating, should_be, note });
  if (state.room?.id === room_id) await refresh_room();
}

/** A completed creation starts the next form with fresh mode defaults. */
function reset_creation_mode() {
  state.creation_mode = "free";
  state.creation_drafts = {};
}

/** Render independently configurable expert modes without changing identity names. */
function render_expert_inputs(container_id, experts) {
  element(container_id).innerHTML = [...new Set([...Object.keys(default_experts()), ...Object.keys(experts).filter(platform_of)])].map((name) =>
    `<label>${name}<select data-expert="${name}" aria-label="${name} 参与方式"><option value="">不参与</option><option value="cli">本机唤醒</option><option value="manual">手动接入</option><option value="online">网页代发 · 只读</option></select></label>`).join("");
  element(container_id).querySelectorAll("[data-expert]").forEach((control) => { control.value = experts[control.dataset.expert] || ""; });
}

/** Read only selected experts and their declared participation modes. */
function read_expert_inputs(container_id) {
  return Object.fromEntries(Array.from(element(container_id).querySelectorAll("[data-expert]"))
    .filter((control) => control.value).map((control) => [control.dataset.expert, control.value]));
}

/** Render the overview and preserve an unsaved host-management draft. */
function render_topic() {
  const room = state.room;
  element("topic-phase").textContent = PHASE_LABELS[room.phase];
  const authors = ["用户", ...Object.keys(room.experts).filter(name => room.experts[name] === "online")];
  render_host_options("author-select", authors.filter(name => name !== "用户"), authors.includes(element("author-select").value) ? element("author-select").value : "用户");
  element("topic-host").textContent = `主持人：${display_name(room.host)} · 可以同时作为专家参与`;
  element("discussion-limits-status").textContent = limits_label(room.limits);
  for (const field of ["goal", "focus", "user_request", "background", "boundaries"]) element(`topic-${field}`).textContent = room[field] || "尚未填写";
  element("topic-experts").textContent = Object.entries(room.experts).map(([name, mode]) =>
    `${name} · ${mode === "cli" ? "本地 CLI，可读可写" : "在线 AI，只读"}${name === room.host ? " · 兼任主持人" : ""}`).join("\n");
  element("turn-history").href = `${location.origin}/r/${room.id}/turns?page=1`;
  element("host-operator").textContent = `当前以 ${display_name(room.host)} 的主持职责管理话题。AI 主持人通过 CLI 操作；用户可在这里协助。`;
  if (!state.topic_dirty) {
    for (const field of ["title", "goal", "focus", "user_request", "background", "boundaries"]) element(`topic-${field}-input`).value = room[field] || "";
    render_host_options("topic-host-select", Object.keys(room.experts).filter(name => room.experts[name] === "cli"), room.host);
    element("topic-phase-select").value = room.phase;
    for (const key of ["max_rounds", "max_minutes", "execution_minutes"]) {
      const input = element(`topic-limit-${key}-input`);
      input.value = room.limits?.[key] || "";
      input.disabled = !["preparing", "paused"].includes(room.phase);
    }
    render_expert_inputs("topic-expert-modes", room.experts);
  }
  const previous_expert = element("turn-expert-select").value;
  element("turn-expert-select").innerHTML = Object.keys(room.experts).map((name) => `<option>${escape_html(name)}</option>`).join("");
  if (room.experts[previous_expert]) element("turn-expert-select").value = previous_expert;
  render_current_turn();
}

/** Display the actual assignment state without implying an external delivery. */
function render_current_turn() {
  const turn = state.room.current_turn;
  const active = turn && ["pending", "notified"].includes(turn.status);
  const inactive = ["paused", "concluded"].includes(state.room.phase);
  element("turn-status").textContent = turn_label(turn, state.room);
  element("turn-note").textContent = turn_guidance(turn, state.room);
  element("turn-expert").textContent = turn ? `#${turn.id} · ${turn.expert}` : "由主持人安排下一位专家";
  element("turn-question").textContent = turn?.question || "在下方展开主持管理，填写本轮待回应的问题。";
  element("copy-turn").disabled = !active || inactive;
  element("confirm-notified").disabled = !turn || turn.status !== "pending" || inactive;
  element("forward-turn").disabled = !active || inactive || state.room.experts[turn?.expert] !== "online";
  element("cancel-turn").disabled = !active;
  element("view-turn-answer").hidden = !turn?.answer_id;
  const limited = state.room.limits?.reached;
  const unavailable = active || inactive || limited || !Object.keys(state.room.experts).length;
  element("schedule-turn").disabled = Boolean(unavailable);
  element("schedule-note").textContent = inactive ? "话题已暂停或收束；恢复阶段后才能继续安排。" :
    (active ? "先完成或取消当前安排，再安排下一位。" : limited ? "已达到讨论上限，请检查到限处理；需要继续时先暂停并调整参数。" : "创建后本地专家可自行检查；在线专家需由主持人或用户联系。");
}

/** Distinguish local work discovery from contacting an online expert. */
function turn_label(turn, room) {
  if (!turn) return "尚未安排";
  if (turn.status === "pending") return { cli: "待处理（本地 CLI）", online: "待联系（在线专家）" }[room.experts[turn.expert]] || "待处理";
  return TURN_LABELS[turn.status];
}

/** Explain only the action supported by the current phase and participation mode. */
function turn_guidance(turn, room) {
  if (["paused", "concluded"].includes(room.phase)) return "话题已暂停或收束，原安排保留。恢复阶段后再通知或录入回答。";
  if (room.experts[turn?.expert] === "cli") return "已接入的本地专家可自行检查安排，无需逐轮通知；尚未接入时先完成启动。此状态不表示后台任务已运行，只有实际联系后才确认已通知。";
  return "在线专家需由主持人或用户联系。复制通知不表示送达，实际联系后再确认已通知。";
}

/** Prepare fresh member credentials only when an identity is added or changes writable capability. */
function topic_member_requests(room, experts) {
  const current = room.members || [];
  return Object.entries(experts).map(([name, capability]) => {
    const access = capability === "online" ? "online" : room.runtime?.mode === "automatic" ? "runner" : "manual";
    const operation = `topic:${name}:${access}`;
    const member = current.find(item => item.name === name && item.status === "active");
    const pending = localStorage.getItem(MEMBER_PENDING_PREFIX + room.id + ":" + operation);
    if (!pending && member && (member.access === "online") === (capability === "online")) return null;
    return prepare_member_request(room.id, operation, { name, access, adapter: "", session_mode: "new" });
  }).filter(Boolean);
}

/** Save owner-edited topic data while retaining untouched participants' existing credentials. */
async function save_topic(event) {
  event.preventDefault();
  const room = state.room;
  const payload = { actor: "用户", host: element("topic-host-select").value,
    phase: element("topic-phase-select").value, experts: read_expert_inputs("topic-expert-modes"), limits: read_limits("topic") };
  for (const field of ["title", "goal", "focus", "user_request", "background", "boundaries"]) payload[field] = element(`topic-${field}-input`).value;
  const records = topic_member_requests(room, payload.experts);
  payload.members = records.map(record => record.member);
  const result = await request_json(`/api/rooms/${room.id}/topic`, payload);
  save_room_credentials({ ...result, id: room.id }, localStorage.getItem(`discuss-access:${room.id}`), payload.members);
  records.forEach(record => localStorage.removeItem(record.key));
  if (state.room?.id === room.id) { state.topic_dirty = false; await refresh_room(); }
  show_toast("话题资料与进度已保存");
}

/** Schedule an expert with an identifier retained across uncertain retries. */
async function schedule_turn(event) {
  event.preventDefault();
  const payload = { actor: "用户", expert: element("turn-expert-select").value, question: element("turn-question-input").value.trim() };
  const signature = JSON.stringify({ room: state.room.id, ...payload });
  if (state.pending_turn?.signature !== signature) state.pending_turn = { signature, id: new_submission_id() };
  element("schedule-turn").disabled = true;
  try {
    await request_json(`/api/rooms/${state.room.id}/turns`, { ...payload, submission_id: state.pending_turn.id });
    state.pending_turn = null;
    element("turn-question-input").value = "";
    await refresh_room();
    show_toast("发言安排已创建");
  } finally { render_current_turn(); }
}

/** Copy only the addressee, question, and selective-reading entrypoint. */
async function copy_turn() {
  const turn = state.room.current_turn;
  const params = new URLSearchParams({ participant: turn.expert, mode: state.room.experts[turn.expert] });
  await copy_text(`@${turn.expert}，轮到你发言。\n待回应问题：${turn.question}\n话题入口：${location.origin}/r/${state.room.id}?${params}\n发言安排 #${turn.id}；请按需查看材料，回答时注明此安排编号和引用原文编号。`);
}

/** Confirm actual external delivery or cancel the current assignment. */
async function change_turn_status(status) {
  await request_json(`/api/rooms/${state.room.id}/turns/${state.room.current_turn.id}`, { actor: "用户", status });
  await refresh_room();
  show_toast(status === "notified" ? "已记录主持人的通知确认" : "发言安排已取消");
}

/** Prepare a host-forwarded answer while retaining the expert's own authorship. */
function prepare_turn_answer() {
  const turn = state.room.current_turn;
  if (state.room.experts[turn.expert] !== "online") throw new Error("本地 AI 须使用自身凭据提交回答");
  element("message-kind").value = "forward";
  element("author-select").value = turn.expert;
  state.turn_reply_to = turn.id;
  element("turn-answer-label").textContent = `回答安排 #${turn.id} · ${turn.expert}，由用户代发`;
  element("turn-answer-preview").hidden = false;
  update_composer_role();
  select_tab("discussion");
  element("message-input").focus();
}

/** Remove an assignment link without changing a drafted opinion. */
function cancel_turn_reply() {
  state.turn_reply_to = null;
  element("turn-answer-preview").hidden = true;
}

/** Keep moderator statements distinct from opinions in the same identity. */
function update_composer_role() {
  const mode = element("message-kind").value;
  element("author-select").disabled = mode === "moderation";
  if (mode === "moderation") element("author-select").value = "用户";
  const needs_summary = ["opinion", "forward"].includes(mode) && element("author-select").value !== "用户";
  element("message-summary-fields").hidden = !needs_summary;
  element("author-note").textContent = mode === "moderation" ? "主持发言" :
    (mode === "forward" ? "由用户代发" : (element("author-select").value === "用户" ? "发言" : "的观点代发"));
}

/** Bind the topic workflow separately from existing chat controls. */
function bind_host_controls() {
  const actions = { "topic-context": () => select_tab("context"), "edit-host-brief": () => select_tab("context"), "topic-history": () => select_tab("discussion"),
    "runtime-auto": () => choose_runtime("automatic"), "runtime-manual": () => choose_runtime("manual"),
    "runtime-export": export_runtime,
    "local-launch-save": save_launch_defaults, "new-local-launch-save": save_launch_defaults,
    "local-launch-start": launch_current_room,
    "local-room-configuration-load": load_room_configuration, "local-room-configuration-save": save_room_configuration,
    "local-room-configuration-restart": restart_discussion,
    "runtime-pause": pause_runtime, "check-discussion-limits": check_limits,
    "copy-turn": copy_turn, "confirm-notified": () => change_turn_status("notified"), "cancel-turn": () => change_turn_status("cancelled"),
    "forward-turn": prepare_turn_answer, "cancel-turn-answer": cancel_turn_reply,
    "view-turn-answer": () => show_message(state.room.current_turn.answer_id),
    "copy-host": () => copy_member_join(state.room.host) };
  Object.entries(actions).forEach(([id, action]) => element(id).addEventListener("click", () => run_action(action)));
  element("topic-form").addEventListener("submit", (event) => run_action(() => save_topic(event)));
  element("turn-form").addEventListener("submit", (event) => run_action(() => schedule_turn(event)));
  element("topic-form").addEventListener("input", () => { state.topic_dirty = true; });
  element("message-kind").addEventListener("change", () => { cancel_turn_reply(); update_composer_role(); });
}

/** Run a UI operation and surface its failure to the user. */
async function run_action(action) {
  try { await action(); } catch (error) { show_toast(error.message, true); }
  finally { publish_view(); }
}

/** Delegate room and message actions to their actual visible controls. */
function bind_delegated_actions() {
  element("room-list").addEventListener("click", (event) => {
    const management = event.target.closest("[data-manage-room]");
    if (management) {
      management.closest("details").open = false;
      return run_action(() => open_room_management(management.dataset.manageRoom, management.dataset.roomAction));
    }
    const button = event.target.closest("[data-room]");
    if (button) run_action(() => select_room(button.dataset.room));
  });
  element("messages").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.detail) run_action(() => show_message(button.dataset.detail));
    if (button.dataset.copyMessage) run_action(() => copy_text(`${location.origin}/r/${state.room.id}/messages/${button.dataset.copyMessage}`));
    if (button.dataset.reply) {
      state.reply_to = Number(button.dataset.reply);
      element("reply-label").textContent = `正在回复 #${state.reply_to} · ${display_name(button.dataset.author)}`;
      element("reply-preview").hidden = false;
      element("message-input").focus();
    }
  });
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => select_tab(tab.dataset.tab)));
}

/** Show a targeted confirmation without changing the current channel or draft. */
async function open_room_management(id, action) {
  if (action === "backup") return backup_room(id);
  if (["up", "down"].includes(action)) return move_channel({ id, direction: action === "up" ? -1 : 1 });
  const room = state.rooms.find((item) => item.id === id);
  if (!room) return;
  state.management = { id, action };
  element("manage-title").textContent = { rename: "重命名频道", archive: "存档频道", restore: "恢复频道", delete: "删除频道" }[action];
  element("manage-description").textContent = action === "delete" ? `永久删除「${room.title}」及其 ${room.message_count} 条消息、共识和发言安排。无法撤销。` :
    action === "archive" ? `存档「${room.title}」后移入已存档列表，保留记录并暂停未收束的讨论。` : action === "restore" ? `恢复「${room.title}」到讨论列表；讨论阶段仍保持暂停或收束。` : "修改名称不会影响记录和阅读地址。";
  element("manage-input-label").hidden = action !== "rename";
  element("manage-input").value = action === "rename" ? room.title : "";
  element("manage-input").required = action === "rename";
  element("manage-submit").textContent = action === "delete" ? "永久删除" : "确认";
  element("manage-submit").disabled = false;
  element("manage-dialog").showModal();
}

/** Bind classic directory menus, confirmation forms and native drag targets. */
function bind_directory_controls() {
  element("archive-toggle").addEventListener("click", toggle_archives);
  element("close-manage").addEventListener("click", () => element("manage-dialog").close());
  element("manage-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const management = { ...state.management, title: element("manage-input").value };
    if (["archive", "restore", "rename", "delete"].includes(management.action)) {
      element("manage-dialog").close();
      run_action(() => manage_channel(management));
      return;
    }
    run_action(async () => {
      element("manage-submit").disabled = true;
      try {
        await manage_channel(management);
        element("manage-dialog").close();
      } finally { element("manage-submit").disabled = false; publish_view(); }
    });
  });
  element("room-list").addEventListener("pointerdown", start_directory_drag);
  element("room-list").addEventListener("keydown", (event) => {
    const handle = event.target.closest("[data-drag-handle]");
    if (!handle || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    run_action(() => move_channel({ id: handle.closest("[data-drag-room]").dataset.dragRoom, direction: event.key === "ArrowUp" ? -1 : 1 }));
  });
}

/** Capture a title or grip without turning a normal title click into a move. */
function start_directory_drag(event) {
  const handle = event.target.closest("[data-drag-handle], [data-drag-title]");
  if (!handle || handle.disabled || event.button !== 0 || state.dragged_room) return;
  const row = handle.closest("[data-drag-room], [data-drag-folder]");
  if (!row || state.folder_moves.has(row.dataset.dragRoom)) return;
  if (row.hasAttribute("data-drag-folder") && (state.folder_order_pending || state.folders.some(folder => folder.pending))) return;
  if (row.hasAttribute("data-drag-room") && state.directory_pending.has("room-order")) return;
  delete handle.dataset.suppressDragClick;
  handle.removeEventListener("click", suppress_directory_drag_click, true);
  if (event.pointerType === "touch" && handle.hasAttribute("data-drag-title")) return;
  event.preventDefault();
  event.stopPropagation();
  handle.addEventListener("click", suppress_directory_drag_click, true);
  state.dragged_room = { id: row.dataset.dragRoom || row.dataset.dragFolder, kind: row.hasAttribute("data-drag-folder") ? "folder" : "room", folder_id: row.closest("[data-room-folder]")?.dataset.roomFolder || null,
    origin_x: event.clientX, origin_y: event.clientY, pointer: event.pointerId, handle, row,
    list: handle.closest("[data-room-directory]"), target: null, moved: false, preview: null };
  handle.setPointerCapture(event.pointerId);
  handle.addEventListener("lostpointercapture", finish_directory_drag);
  document.addEventListener("pointermove", update_directory_drag);
  document.addEventListener("pointerup", finish_directory_drag);
  document.addEventListener("pointercancel", finish_directory_drag);
  document.addEventListener("keydown", cancel_directory_drag, true);
}

/** Consume only the pointer click generated by a completed drag, not a later click. */
function suppress_directory_drag_click(event) {
  const handle = event.currentTarget;
  if (handle.dataset.suppressDragClick && event.detail > 0) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  delete handle.dataset.suppressDragClick;
  handle.removeEventListener("click", suppress_directory_drag_click, true);
}

/** Show the dragged title beside the pointer while leaving the directory in place. */
function render_directory_drag_preview(drag, event) {
  if (!drag.preview) {
    drag.preview = document.createElement("div");
    drag.preview.className = "channel-drag-preview";
    drag.preview.textContent = drag.kind === "folder" ? ordered_folders().find((folder) => folder.order_id === drag.id)?.name : state.rooms.find((room) => room.id === drag.id)?.title;
    drag.preview.setAttribute("aria-hidden", "true");
    document.body.append(drag.preview);
    drag.row.classList.add("drag-source");
    drag.list.classList.add("directory-dragging");
  }
  const left = Math.max(DIRECTORY_DRAG_OFFSET, Math.min(event.clientX + DIRECTORY_DRAG_OFFSET, window.innerWidth - drag.preview.offsetWidth - DIRECTORY_DRAG_OFFSET));
  const top = Math.max(DIRECTORY_DRAG_OFFSET, Math.min(event.clientY + DIRECTORY_DRAG_OFFSET, window.innerHeight - drag.preview.offsetHeight - DIRECTORY_DRAG_OFFSET));
  drag.preview.style.transform = `translate(${left}px, ${top}px)`;
}

/** Clear both folder targets and within-folder insertion edges. */
function clear_directory_drop(drag) {
  drag.list.querySelectorAll("[data-drag-room]").forEach((row) => row.classList.remove("drop-before", "drop-after"));
  drag.list.querySelectorAll("[data-room-folder]").forEach((folder) => folder.classList.remove("drop-before", "drop-after"));
  drag.list.querySelectorAll("[data-drop-folder]").forEach((heading) => heading.classList.remove("drop-folder"));
  drag.target = null;
}

/** Highlight a folder assignment or an insertion edge without writing while moving. */
function update_directory_drag(event) {
  const drag = state.dragged_room;
  if (!drag || event.pointerId !== drag.pointer) return;
  if (!drag.moved && Math.hypot(event.clientX - drag.origin_x, event.clientY - drag.origin_y) < DIRECTORY_DRAG_THRESHOLD) return;
  drag.moved = true;
  drag.handle.dataset.suppressDragClick = "true";
  render_directory_drag_preview(drag, event);
  clear_directory_drop(drag);
  const hit = document.elementFromPoint(event.clientX, event.clientY);
  if (!hit || !drag.list.contains(hit)) return;
  if (drag.kind === "folder") return update_folder_drop(drag, hit, event.clientY);
  const folder = hit.closest("[data-room-folder]");
  const folder_id = folder?.dataset.roomFolder || null;
  if (state.folders.some(item => item.id === folder_id && item.pending)) return;
  if (folder && folder_id !== drag.folder_id) {
    folder.querySelector("[data-drop-folder]")?.classList.add("drop-folder");
    drag.target = { action: "folder", folder_id };
    return;
  }
  if (state.directory_sort === "recent") return;
  const target = hit.closest("[data-drag-room]");
  if (!target || target.dataset.dragRoom === drag.id) return;
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  drag.target = { action: "move", id: target.dataset.dragRoom, after };
  target.classList.add(after ? "drop-after" : "drop-before");
}

/** Reorder whole groups, including the virtual uncategorized group. */
function update_folder_drop(drag, hit, pointer_y) {
  const target = hit.closest("[data-room-folder]");
  if (!target || target.dataset.dragFolder === drag.id) return;
  const rect = target.getBoundingClientRect();
  const after = pointer_y > rect.top + rect.height / 2;
  const groups = ordered_folders();
  const index = groups.findIndex((folder) => folder.order_id === target.dataset.dragFolder);
  const before_id = after ? groups[index + 1]?.order_id ?? null : target.dataset.dragFolder;
  if (before_id === drag.id) return;
  drag.target = { action: "move_folder", before_id };
  target.classList.add(after ? "drop-after" : "drop-before");
}

/** Cancel a drag without changing the open conversation or its folder. */
function cancel_directory_drag(event) {
  if (event.key !== "Escape" || !state.dragged_room) return;
  event.preventDefault();
  event.stopPropagation();
  finish_directory_drag({ type: "pointercancel", pointerId: state.dragged_room.pointer });
}

/** Save only completed drops and release all temporary pointer listeners. */
function finish_directory_drag(event) {
  const drag = state.dragged_room;
  if (!drag || event.pointerId !== drag.pointer) return;
  if (event.type === "pointerup" && drag.moved) update_directory_drag(event);
  const target = drag.target;
  state.dragged_room = null;
  document.removeEventListener("pointermove", update_directory_drag);
  document.removeEventListener("pointerup", finish_directory_drag);
  document.removeEventListener("pointercancel", finish_directory_drag);
  document.removeEventListener("keydown", cancel_directory_drag, true);
  drag.handle.removeEventListener("lostpointercapture", finish_directory_drag);
  clear_directory_drop(drag);
  drag.preview?.remove();
  drag.row.classList.remove("drag-source");
  drag.list.classList.remove("directory-dragging");
  if (drag.handle.hasPointerCapture(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
  if (event.type !== "pointerup" || !target) return;
  if (target.action === "move_folder") return run_action(() => move_folder({ id: drag.id, before_id: target.before_id }));
  if (target.action === "folder") return run_action(() => manage_channel({ id: drag.id, action: "folder", folder_id: target.folder_id }));
  const rooms = visible_rooms();
  const index = rooms.findIndex((room) => room.id === target.id);
  const before_id = target.after ? rooms[index + 1]?.id ?? null : target.id;
  if (before_id !== drag.id) run_action(() => manage_channel({ id: drag.id, action: "move", before_id }));
}

/** Bind forms, filters, and explicit read/write actions. */
function bind_controls() {
  document.addEventListener("input", () => { state.navigation_version++; });
  const open_create = () => { reset_create_form(); element("room-dialog").showModal(); };
  const actions = { "new-room": open_create, "empty-create": open_create,
    "close-room-dialog": () => element("room-dialog").close(), "close-message-dialog": () => element("message-dialog").close(),
    "refresh": refresh_room, "cancel-reply": cancel_reply, "go-context": () => select_tab("context"),
    "copy-reading": () => copy_text(`${location.origin}/r/${state.room.id}`),
    "backup-room": () => backup_room(),
    "copy-reading-secondary": () => copy_text(`${location.origin}/r/${state.room.id}`),
    "copy-context": () => copy_context(), "copy-online": () => copy_context(), "copy-cli": () => copy_context("cli"), "copy-background": copy_background };
  Object.entries(actions).forEach(([id, action]) => element(id).addEventListener("click", () => run_action(action)));
  const forms = { "message-form": send_message, "room-form": submit_room, "state-form": save_context };
  Object.entries(forms).forEach(([id, action]) => element(id).addEventListener("submit", (event) => run_action(() => action(event))));
  element("search-form").addEventListener("submit", (event) => {
    event.preventDefault(); state.query = element("search-input").value.trim(); state.page = 1; run_action(refresh_room);
  });
  element("search-input").addEventListener("search", () => {
    state.query = element("search-input").value.trim(); state.page = 1; run_action(refresh_room);
  });
  element("mention-filter").addEventListener("click", () => {
    state.mention_only = !state.mention_only; state.page = 1;
    element("mention-filter").setAttribute("aria-pressed", String(state.mention_only)); run_action(refresh_room);
  });
  element("author-select").addEventListener("change", () => {
    update_composer_role();
    element("mention-filter").textContent = `@ ${element("author-select").value === "用户" ? "提到我" : element("author-select").value}`;
    if (state.mention_only) { state.page = 1; run_action(refresh_room); }
  });
  element("state-input").addEventListener("input", () => { state.context_dirty = true; });
  element("brief-input").addEventListener("input", () => { state.context_dirty = true; });
  element("message-input").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); element("message-form").requestSubmit(); }
  });
}

/** Coalesce bursts and retain changes that arrive during a previous refresh. */
function queue_live_refresh() {
  live_updates.dirty = true;
  if (!live_updates.enabled || document.hidden || live_updates.running || live_updates.timer !== null) return;
  live_updates.timer = setTimeout(flush_live_refresh, UPDATE_BATCH_MS);
}

/** Fetch committed state without disturbing drafts, filters or transcript position. */
async function flush_live_refresh() {
  live_updates.timer = null;
  if (!live_updates.enabled || document.hidden) return;
  if (state.dragged_room) {
    live_updates.timer = setTimeout(flush_live_refresh, UPDATE_DRAG_RETRY_MS);
    return;
  }
  live_updates.dirty = false;
  live_updates.running = true;
  try { await refresh_room(); } catch { set_connection(false); }
  finally {
    live_updates.running = false;
    if (live_updates.dirty) queue_live_refresh();
  }
}

/** Keep a low-frequency safety read, or retain the original polling when push is unavailable. */
function arm_update_poll() {
  clearTimeout(live_updates.poll_timer);
  if (!live_updates.enabled || document.hidden) return;
  live_updates.poll_timer = setTimeout(() => {
    queue_live_refresh();
    arm_update_poll();
  }, live_updates.connected ? REFRESH_INTERVAL_MS : FALLBACK_REFRESH_INTERVAL_MS);
}

/** Subscribe once per visible page; every connection fetches changes missed while disconnected. */
function start_live_updates() {
  if (document.hidden) return;
  live_updates.enabled = true;
  if (!live_updates.source && typeof EventSource !== "undefined") {
    const source = new EventSource("/api/updates");
    live_updates.source = source;
    source.addEventListener("open", () => {
      if (live_updates.source !== source) return;
      live_updates.connected = true;
      arm_update_poll();
    });
    for (const name of ["ready", "change"]) source.addEventListener(name, () => {
      if (live_updates.source === source) queue_live_refresh();
    });
    source.addEventListener("error", () => {
      if (live_updates.source !== source) return;
      const was_connected = live_updates.connected;
      live_updates.connected = false;
      if (was_connected) arm_update_poll();
    });
  }
  arm_update_poll();
  queue_live_refresh();
}

/** Release streams and scheduled reads while hidden or leaving the page. */
function stop_live_updates() {
  live_updates.enabled = false;
  live_updates.source?.close();
  live_updates.source = null;
  live_updates.connected = false;
  clearTimeout(live_updates.timer);
  clearTimeout(live_updates.poll_timer);
  live_updates.timer = null;
  live_updates.poll_timer = null;
}

/** Initialize forms and the shared discussion controller. */
async function initialize() {
  render_identities();
  bind_delegated_actions();
  bind_directory_controls();
  bind_controls();
  bind_attachment_controls();
  bind_host_controls();
  reset_creation_mode();
  element("new-room-kind").addEventListener("change", update_creation_mode);
  document.addEventListener("focusin", event => {
    if (event.target.dataset?.launchField === "model") load_launch_models(event.target.dataset.launchName);
  });
  document.addEventListener("input", event => {
    if (event.target.dataset?.roomConnection) write_room_connection(event.target.dataset.roomConnection, event.target.value);
    if (event.target.dataset?.roomAdapter) write_room_adapter(event.target.dataset.roomAdapter, event.target.value);
    const { launchName: name, launchField: field } = event.target.dataset || {};
    if (name && field === "model") write_launch_model(name, event.target.value);
    else if (name) write_launch_field(name, field, event.target.type === "checkbox" ? event.target.checked : event.target.value);
  });
  load_launch_settings();
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).has("codiscuss-connect")) load_launch_settings();
  });
  window.addEventListener("storage", event => { if (!event.key || event.key.startsWith(LAUNCH_PENDING_PREFIX)) refresh_launch_recoveries(); });
  element("launch-recoveries").addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.launchRetry) run_action(() => resume_launch(button.dataset.launchRetry));
    if (button?.dataset.launchDiscard) discard_launch(button.dataset.launchDiscard);
    if (button?.dataset.launchRoom) run_action(() => select_room(button.dataset.launchRoom));
  });
  load_admin_state();
  try {
    const result = await request_json("/api/rooms");
    state.rooms = result.rooms;
    set_folder_directory(result);
    const requested = new URLSearchParams(location.search).get("room");
    await select_room(state.rooms.some((room) => room.id === requested) ? requested : visible_rooms()[0]?.id);
    set_connection(true);
  } catch (error) { set_connection(false); show_toast(error.message, true); }
  start_live_updates();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop_live_updates();
    else { start_live_updates(); load_admin_state(); }
  });
  window.addEventListener("pagehide", stop_live_updates);
  window.addEventListener("pageshow", start_live_updates);
}

/** Publish a presentation snapshot shared by the legacy and Vue renderers. */
function publish_view() {
  document.dispatchEvent(new CustomEvent("discuss:view"));
}

/** Read current form drafts without transferring ownership to either renderer. */
function view_snapshot() {
  const fields = Object.fromEntries(Array.from(document.querySelectorAll("#controller-fields input[id], #controller-fields textarea[id], #controller-fields select[id], body > dialog input[id], body > dialog textarea[id], body > dialog select[id]"))
    .map((control) => [control.id, control.value]));
  const experts = Object.fromEntries(["new-expert-modes", "topic-expert-modes"].map((id) =>
    [id, element(id) ? read_expert_inputs(id) : {}]));
  return { rooms: ordered_rooms(), folders: state.folders, folder_groups: ordered_folders(), room: state.room, archive_view: state.archive_view, directory_sort: state.directory_sort, messages: state.messages, total: state.message_total,
    archive_pending: [...state.archive_changes.keys()], directory_error: state.directory_error, directory_notice: state.directory_notice,
    directory_pending: [...state.directory_pending.keys()], folder_pending: [...state.folder_moves.keys()], creating_room: state.creating_room,
    connected: state.connected, backup_pending: Boolean(state.backup_pending), page: state.page, pages: state.pages, query: state.query,
    attachment_drafts: state.attachment_drafts.map(item => ({ id: item.id, file_name: item.file.name, size: item.file.size, preview_url: item.preview_url })),
    composer_error: state.composer_error, upload_status: state.upload_status, sending_message: state.sending_message,
    mention_only: state.mention_only, reply_to: state.reply_to, turn_reply_to: state.turn_reply_to,
    free_notice: state.free_notice, free_error: state.free_error, free_proxy: state.free_proxy, order_error: state.order_error,
    create_parent: state.create_parent, access: access_snapshot(), admin: admin_snapshot(),
    tab: state.tab, snapshot_id: state.snapshot_id, context_dirty: state.context_dirty,
    theme: document.documentElement.dataset.theme, fields, experts, launch: structuredClone(state.launch), named_followup: state.named_followup, create_discussion: state.create_discussion };
}

/** Update a shared draft using the same input events as the original controls. */
function write_view_field(id, value) {
  const control = element(id);
  if (!control || !control.matches("input, textarea, select")) return;
  state.navigation_version++;
  if (["new-room-host", "topic-host-select"].includes(id) && platform_of(value)
      && !Array.from(control.options).some(option => option.value === value)) {
    control.insertAdjacentHTML("beforeend", `<option value="${escape_html(value)}">${escape_html(value)}</option>`);
  }
  control.value = value ?? "";
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  publish_view();
}

/** A participation select for one AI name; instances beyond the platforms get their own control. */
function expert_control(container_id, name) {
  const container = element(container_id);
  let control = container?.querySelector(`[data-expert="${CSS.escape(name)}"]`);
  if (!control && container && platform_of(name)) {
    container.insertAdjacentHTML("beforeend", `<label>${escape_html(name)}<select data-expert="${escape_html(name)}" aria-label="${escape_html(name)} 参与方式"><option value="">不参与</option><option value="cli">本地 CLI · 读写</option><option value="manual">手动接入</option><option value="online">在线 AI · 只读</option></select></label>`);
    control = container.querySelector(`[data-expert="${CSS.escape(name)}"]`);
  }
  return control;
}

/** Add another instance of a platform to a topic draft; it starts from the platform's software settings. */
function add_view_instance(container_id, platform, value) {
  const taken = new Set(Object.keys(read_expert_inputs(container_id)));
  let name = platform;
  for (let number = 2; taken.has(name); number++) name = `${platform}-${number}`;
  const { session_id, ...profile } = state.launch.profiles[platform] || {};
  if (name !== platform) state.launch.profiles[name] = structuredClone(profile);
  write_view_expert(container_id, name, value);
  return name;
}

/** Update one expert's participation mode in a shared topic draft. */
function write_view_expert(container_id, name, value) {
  const control = expert_control(container_id, name);
  if (!control) return;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  publish_view();
}

/** Select a quoted message for both renderers without changing its text. */
function set_view_reply(message) {
  state.reply_to = message.id;
  element("reply-label").textContent = `正在回复 #${message.id} · ${display_name(message.author)}`;
  element("reply-preview").hidden = false;
}

/** Apply filters to the continuous transcript through the existing controller. */
async function filter_view({ query = state.query, mention = state.mention_only, page = 1 }) {
  state.query = query.trim();
  state.mention_only = mention;
  state.page = page;
  element("search-input").value = state.query;
  element("mention-filter").setAttribute("aria-pressed", String(mention));
  await refresh_room();
}

/** Download one complete room snapshot independently of visible filters or later navigation. */
async function backup_room(room_id = state.room?.id) {
  if (!room_id || state.backup_pending) return;
  state.backup_pending = true;
  element("backup-room").disabled = true;
  element("backup-room").textContent = "正在备份…";
  publish_view();
  try {
    const snapshot = await request_json(`/api/rooms/${encodeURIComponent(room_id)}/backup`);
    snapshot.source_url = `${location.origin}/r/${encodeURIComponent(room_id)}`;
    await window.discuss_backup.download_room_backup(snapshot);
    show_toast(`已生成备份（${snapshot.tables.messages.length} 条消息），请查看浏览器下载。`);
  } finally {
    state.backup_pending = false;
    element("backup-room").disabled = !state.room;
    element("backup-room").textContent = "备份当前讨论";
    publish_view();
  }
}

/** Download several rooms, such as a folder or the whole directory, as one importable archive. */
async function backup_rooms({ ids, name }) {
  if (!ids.length || state.backup_pending) return;
  state.backup_pending = true;
  state.directory_notice = state.directory_error = "";
  publish_view();
  try {
    const snapshots = [];
    for (const id of ids) {
      const snapshot = await request_json(`/api/rooms/${encodeURIComponent(id)}/backup`);
      snapshots.push({ ...snapshot, source_url: `${location.origin}/r/${encodeURIComponent(id)}` });
    }
    await window.discuss_backup.download_rooms_backup(snapshots, name);
    state.directory_notice = `已生成 ${snapshots.length} 个频道的备份，请查看浏览器下载。`;
  } catch (error) {
    state.directory_error = `导出失败，未生成备份：${error.message}`;
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Upload one imported room's original files to the new attachment IDs; returns how many were missing. */
async function upload_imported_files(room_id, token, mapping, files) {
  let missing = 0;
  for (const [old_id, new_id] of Object.entries(mapping)) {
    const data = files.get(old_id);
    const response = data && await fetch(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(new_id)}/import`,
      { method: "POST", headers: { "X-Discussion-Token": token, ...admin_headers() }, body: data });
    if (!response?.ok) missing++;
  }
  return missing;
}

/** Import every room in the chosen backup files; each imported room is owned by this browser, existing rooms are skipped. */
async function import_rooms(files) {
  if (!files?.length || state.backup_pending) return;
  state.backup_pending = true;
  state.directory_notice = state.directory_error = "";
  publish_view();
  const imported = [], skipped = [], failed = [];
  let missing = 0;
  try {
    for (const file of files) {
      let rooms;
      try { rooms = await window.discuss_backup.read_room_archives(file); }
      catch (error) { failed.push(error.message.includes(file.name) ? error.message : `${file.name}：${error.message}`); continue; }
      for (const { snapshot, files: originals } of rooms) {
        const title = snapshot.tables?.rooms?.[0]?.title || file.name, token = crypto.randomUUID() + crypto.randomUUID();
        try {
          const result = await request_json("/api/rooms/import", snapshot, token);
          if (result.skipped) { skipped.push(result.title); continue; }
          save_room_credentials({ id: result.id }, token);
          missing += await upload_imported_files(result.id, token, result.attachments, originals);
          imported.push(result.title);
        } catch (error) { failed.push(`${title}：${error.message}`); }
      }
    }
    await refresh_room();
  } finally {
    state.backup_pending = false;
    publish_view();
  }
  state.directory_notice = [`已导入 ${imported.length} 个频道`, skipped.length && `跳过已存在的 ${skipped.length} 个（${skipped.join("、")}）`]
    .filter(Boolean).join("；");
  state.directory_error = [missing && `${missing} 个附件原文件缺失，消息中的这些附件无法打开`, failed.length && `未导入 ${failed.length} 项：${failed.join("；")}`]
    .filter(Boolean).join("；");
}

/** Execute a named view command, retaining existing retry and provenance rules. */
async function execute_view_action(name, value) {
  if (!["refresh", "create"].includes(name)) state.navigation_version++;
  const event = { preventDefault() {} };
  const actions = { refresh: refresh_room, room: select_room, tab: select_tab,
    archives: toggle_archives, backup: backup_room, backup_rooms, import_rooms, manage_channel, move_channel, create_folder, move_folder, rename_folder, delete_folder, sort_directory,
    send: () => send_message(event), choose_attachments: () => element("attachment-input").click(), remove_attachment, preview_attachment,
    create: (folder_id) => submit_room(event, folder_id),
    save_context: () => save_context(event), save_topic: () => save_topic(event),
    schedule: () => schedule_turn(event), filter: filter_view, reply: set_view_reply,
    cancel_reply, cancel_answer: cancel_turn_reply, prepare_answer: prepare_turn_answer,
    copy_turn, notify: () => change_turn_status("notified"), cancel_turn: () => change_turn_status("cancelled"), skip_turn,
    copy_online: () => copy_context(), copy_cli: () => copy_context("cli"), copy_background,
    choose_runtime, export_runtime, download_member_access, copy_member_access_text, copy_member_join, copy_member_launch: name => copy_member_join(name, true), pause_runtime, check_limits, pause_discussion, restart_discussion, retry_execution, conclude_discussion, start_room_discussion, end_room_discussion, reopen_discussion,
    save_launch_defaults, launch_current_room, resume_launch, discard_launch, retry_launch_connection, check_launch_connection: load_launch_settings,
    load_room_configuration, save_room_configuration, interrupt_member, change_member, reorder_speakers, invite_member, set_proxy, copy_online_notice,
    prepare_brainstorm, return_conclusion, convert_suggestion, adopt_recommendation, rate_decision,
    busy: () => { throw new Error("上一个操作仍在处理中，请稍候；长时间无响应请刷新页面"); },
    copy_reading: () => copy_text(`${location.origin}/r/${state.room.id}`), copy: copy_text };
  if (!["refresh", "busy"].includes(name)) state.free_error = "";
  try {
    await actions[name](value);
    return true;
  } catch (error) {
    if (["download_member_access", "copy_member_access_text", "copy_member_join", "copy_member_launch"].includes(name)) state.access_error = error.message;
    else if (!state.free_error) state.free_error = error.message;
    show_toast(error.message, true);
    return false;
  } finally { publish_view(); }
}

/** Change channel colors while retaining the shared room, filters, and form drafts. */
function change_view_theme(theme) {
  apply_theme(theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, document.documentElement.dataset.theme); } catch { /* Keep the session preference. */ }
}

window.discuss_view = { snapshot: view_snapshot, write_field: write_view_field,
  write_launch: write_launch_field, write_room_connection, write_room_adapter, launch_clients: LAUNCH_CLIENTS,
  launch_model_state, load_launch_models, write_launch_model, save_launch_api_key, write_scheduler, save_scheduler_api_key, check_scheduler, write_named_followup, write_create_discussion, check_launch_api, launch_summary, launch_can_set_access, launch_can_bind_session, pick_launch_directory, restore_launch_profile, reset_create_form, empty_discussion_message,
  start_drag: start_directory_drag,
  attachment_markup, attachment_size, attachment_file_icon, drop_attachments, paste_attachments,
  write_expert: write_view_expert, add_instance: add_view_instance, platform_of, execute: execute_view_action, theme: change_view_theme,
  admin: { register: register_admin, login: login_admin, logout: logout_admin,
    update_profile: update_admin_profile, avatar_from_file: admin_avatar_from_file, validate: validate_admin_form },
  request: request_json, identities: IDENTITIES, display_name, sources: SOURCE_LABELS, phases: PHASE_LABELS,
  runtime_label, execution_label, limits_label, participant_model, participant_access, can_retry_execution,
  turns: TURN_LABELS, turn_label, turn_guidance, progress_round, round_groups, limit_rounds, progress_speaker, brief_meta, max_message_length: MAX_MESSAGE_LENGTH, provenance: message_provenance, format_time };

restore_theme();
restore_directory_sort();
document.addEventListener("DOMContentLoaded", initialize);
