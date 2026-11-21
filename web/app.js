"use strict";
const t = (source, params) => window.codiscuss_i18n ? window.codiscuss_i18n.t(source, params)
  : source.replace(/\{(\w+)\}/g, (match, name) => params && name in params ? String(params[name]) : match);
/** Show text the server sent in the page language: `payload` is its `{ template, params }`, `fallback` the Chinese. */
const server_text = (payload, fallback) => (payload?.template ? t(payload.template, payload.params) : fallback);
// A shared room page (made by share_room) carries its one room here: every read is answered from it and nothing is written.
const SHARE = window.CODISCUSS_SHARE || null;
// While a share page is being assembled, the raw answers of its reads, by route.
let share_recording = null;
// Where a reader of a share page learns about the product.
const SHARE_HOME = "https://github.com/huyan1458/ai_co_discuss";
// The official share site that hosts published links (backend/share_worker.mjs); changing the domain changes only this.
const SHARE_SITE = "https://share.codiscuss.com";
// What a published link carries and how long it lives (the site enforces the same).
const SHARE_FORMAT = 1;
const SHARE_DAYS = [1, 3, 7];
const SHARE_DEFAULT_DAYS = 7;
const SHARE_MAX_BYTES = 5 * 1024 * 1024;
// Where an earlier version kept a room's published link in this browser; it moves to the room when first read.
const SHARE_LINK_PREFIX = "codiscuss-share:";
// A share page is a record of one moment: every "how long ago" and running clock is read at that moment.
if (SHARE && Number.isFinite(Date.parse(SHARE.exported_at))) {
  const exported_at = Date.parse(SHARE.exported_at);
  Date.now = () => exported_at;
}
// index.html carries the Chinese tab title; it follows the page language here.
document.title = SHARE ? t("{title} · AI CoDiscuss", { title: SHARE.title }) : t("共议聊天室 · AI CoDiscuss");

const REFRESH_INTERVAL_MS = 60000;
const FALLBACK_REFRESH_INTERVAL_MS = 12000;
// The site caps one message batch at 200.
const MESSAGE_HISTORY_BATCH = 200;
// A poll reads the room in full only when it changed or an AI is working in it; this full read still comes at least this often.
const SAFETY_REFRESH_MS = 5 * 60 * 1000;
const WORKING_STATUSES = ["dispatched", "started"];
const UPDATE_BATCH_MS = 100;
const UPDATE_DRAG_RETRY_MS = 500;
// A page back from the background after this long shows the opening load until its first full read, instead of old
// cards that then change all at once; the cap keeps the cards from staying hidden behind a read that never ends.
// A look at another window (under five minutes) or a read that is back within a second shows no load at all.
const RESUME_LOADING_AFTER_MS = 5 * 60000;
const RESUME_LOADING_SHOW_MS = 1000;
const RESUME_LOADING_MAX_MS = 15000;
const TOAST_DURATION_MS = 3500;
// How long an archived room can be taken back before the archive is saved.
const ARCHIVE_UNDO_MS = 4000;
// Limits of the new-room form's title and discussion goal, applied when the welcome page fills them from a message.
const ROOM_TITLE_MAX_LENGTH = 80;
const ROOM_GOAL_MAX_LENGTH = 1000;
const SUBMISSION_ID_BYTES = 16;
const MAX_MESSAGE_LENGTH = 32000;
const MAX_SUMMARY_LENGTH = 1000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Videos sent through the relay are shrunk from this size up; smaller ones cost little to carry as they are.
const VIDEO_COMPRESS_MIN_BYTES = 3 * 1024 * 1024;
// The largest video the page tries to shrink below MAX_ATTACHMENT_BYTES.
const VIDEO_COMPRESS_MAX_BYTES = 1024 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 10;
const PDF_CANVAS_LIMIT = 4096;
const DIRECTORY_DRAG_THRESHOLD = 4;
const DIRECTORY_TOUCH_HOLD_MS = 350;
const DIRECTORY_TOUCH_SLOP = 8;
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
// A relayed launch waits this long for the paired computer before the request is kept as a pending item.
const RELAY_WAIT_MS = 45000;
// A relayed read that goes unanswered or finds the computer briefly away is asked again after these pauses; reads change nothing.
const RELAY_READ_RETRY_MS = [1000, 3000];
// A message that failed for the network is sent again by itself after these pauses, with the same submission (and each
// file with its own), so one that did reach the site is not saved twice; only then does it become a failed card.
const SEND_RETRY_MS = [2000, 5000, 10000];
// After the connection drops, the page reconnects by itself after these pauses, the last one repeating until it is back.
const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 15000, 30000];
const RELAY_POLL_MS = 1500;
const MODEL_CATALOG_TIMEOUT_MS = 35000;
// Without the local service, local operations go through the paired computer, encrypted so the website only sees ciphertext.
const RELAY_COMMAND_POLL_MS = 250;
const RELAY_SETTINGS_WAIT_MS = 20000;
// The computer allows each operation 60 seconds, as the local website does.
const RELAY_COMMAND_WAIT_MS = 75000;
// The website answers a relayed request within its wait (9 seconds unless asked for more); a request still unanswered
// this much later is stuck in the network and is given up, so a hung connection cannot hold back reconnecting.
const RELAY_DEFAULT_WAIT_MS = 9000;
const MACHINE_REQUEST_MARGIN_MS = 15000;
// How long a pairing request waits for the computer over the relay, in milliseconds as the relay counts.
const PAIR_WAIT_MS = 15000;
const RELAY_CIPHER_INFO = "codiscuss-relay-v1";
// The rooms kept on the paired computer are read and written through its relay connection; only room routes go there.
const RELAY_PROTOCOL = "codiscuss-relay";
const RELAY_PING_MS = 25000;
const ROOM_RELAY_PATH = /^\/api\/(rooms|folders|revisions)(\/|\?|$)/;
// One part is base64-encoded, encrypted and base64-encoded again (about 16/9 of its size), and the sealed request
// must stay inside the hosted site's 512 KiB request limit (backend/worker.mjs MAX_BODY_BYTES). Parts stay small enough
// for a slow phone network to carry one well inside its wait: 256 KiB parts took 3.4 s each on a phone, and one that ran
// out of time failed the whole file, which then started over from its first part (2026-11-17: a 12 MiB recording
// arrived on the fifth try, after 72 parts had been sent for nothing).
const RELAY_UPLOAD_PART_BYTES = 128 * 1024;
// Parts in flight at once: each pays a round trip through the relay to the computer, and two overlap it.
const RELAY_UPLOAD_PARALLEL = 2;
// How long (ms) the relay waits for the computer to take one part; the page allows this plus its margin, which also
// covers sending the part over a slow network.
const RELAY_UPLOAD_WAIT_MS = 30000;
// A part lost on the way is sent again after these pauses; the computer keeps parts by number, so it stores it once.
const RELAY_UPLOAD_RETRY_MS = [1000, 2000, 4000, 8000, 15000];
// Passes over one file: its parts, then any the computer says it lacks.
const RELAY_UPLOAD_ROUNDS = 4;
// Uploads under way by file: a send tried again (SEND_RETRY_MS, or the composer's early upload) carries on from the parts
// the computer already has, under the same upload id.
const relay_uploads = new WeakMap();
// The most an upload shows until the site has confirmed the whole file.
const UPLOAD_PERCENT_BEFORE_SAVED = 99;
// Files of the computer's rooms come back in frames of about 1 MB over the one relay connection that also carries every
// room read: only this many are read at once, so a room full of images cannot hold back its messages until they time out
// (2026-11-16: opening a room with 51 screenshots read 46 MB at once; message reads and sends timed out, and the retried
// parts were sent again).
const RELAY_FILE_CONCURRENCY = 2;
// Images and media of the computer's rooms are read once they come this near the screen, not all when a room opens.
const RELAY_MEDIA_MARGIN = "1000px 0px";
// How long a relayed image or media element may keep its spinner before it says it failed; a file arriving later still shows.
const RELAY_MEDIA_TIMEOUT_MS = 90000;
// How long an image is given to decode ahead of being shown; a decode that never answers must not hold the image back.
const RELAY_MEDIA_DECODE_MS = 3000;
const COMPUTER_UNREACHABLE = t('电脑未连接：请先与电脑配对，并确认电脑开机且运行 codiscuss');
let local_connection = null;
let computer_connecting = false;
let relay_machine = null;
// Object URLs of files read from the computer's rooms, by their room route.
const relay_files = new Map();
/** Room files are read as bytes and shown from object URLs: the computer's rooms through the relay, a share page from what it carries. */
const files_by_blob = () => state.remote_rooms || Boolean(SHARE);
// Relay file reads waiting for a free slot, and how many are running (RELAY_FILE_CONCURRENCY).
const relay_file_queue = [];
let relay_file_running = 0;
// The room list and room views last read, with their ETags, by route; an unchanged read is answered 304 and reuses them.
const ROOM_READ_PATH = /^\/api\/rooms(\/[^/?]+)?$/;
const room_reads = new Map();
const DEFAULT_USER_LABEL = "User";
const DEFAULT_USER_ICON = "/icons/user.svg";
// How a manual member learns it is its turn: it is pulled by the member.
const MANUAL_TRIGGER_INSTRUCTION = "首次复制后，可由人工或软件原生定时触发；自行提交，不必每轮复制回答。";
const MANAGEMENT_LOGIN_HINT = t('需要登录管理员账号或使用创建该房间的浏览器');
const THEMES = ["channel", "channel-light"];
// proxy and host_proxy label answers relayed for the retired web chatbot members.
const SOURCE_LABELS = { demo: t('示例'), user: t('本人发言'), proxy: t('用户代发'), cli: t('CLI 发言'), api: t('API 发言'), url: t('历史 URL 发言'), host_proxy: t('主持人代发'), goal: "Goal" };
const TURN_LABELS = { pending: t('待处理'), notified: t('已通知，待回答'), answered: t('已回答'), cancelled: t('已取消') };
const PLATFORM_IDENTITIES = {
  "用户": { label: "User", initials: "U", style: "user", icon: "/icons/user.svg", description: t('发起与协助') },
  Claude: { initials: "CL", style: "claude", icon: "/icons/claude.svg", description: t('AI 身份') },
  Codex: { initials: "CX", style: "codex", icon: "/icons/openai.svg", api_label: "OpenAI API", description: t('AI 身份') },
  // The platform ID is Antigravity (the software); screens show its nickname Gemini.
  Antigravity: { label: "Gemini", initials: "GM", style: "gemini", icon: "/icons/gemini.svg", description: t('AI 身份') },
  DeepSeek: { initials: "DS", style: "deepseek", icon: "/icons/deepseek.svg", description: t('AI 身份') },
  Qwen: { initials: "QW", style: "qwen", icon: "/icons/qwen.svg", description: t('AI 身份') },
  Grok: { initials: "GK", style: "grok", icon: "/icons/grok.svg", description: t('AI 身份') },
  OpenAI: { initials: "OA", style: "codex", icon: "/icons/openai.svg", description: t('AI 身份') },
  Custom: { label: t('自定义 API'), initials: "API", style: "custom", icon: "/icons/custom-api.svg", api_label: t('自定义 API'), description: t('AI 身份') },
};
// An instance shows its platform's nickname with its own suffix: Antigravity-2 → Gemini-2.
const EXTERNAL_ICON = "/icons/external-expert.svg";
const IDENTITIES = by_platform(PLATFORM_IDENTITIES, (identity, name) => external_identity(name)
  ? external_member_identity(name)
  : ({ ...identity, label: identity.label ? identity.label + name.slice(platform_of(name).length) : name, description: t('AI 实例') }));

/** An external member shows the vendor its computer reports; a custom endpoint, or none reported yet, shows the external mark. */
function external_member_identity(name) {
  // One that has ended (expired, left, revoked) is no longer among the members but its earlier messages still show: it
  // keeps the vendor it reported, from the room's list of ended external members.
  const free = state.room?.free;
  const platform = [...free?.members || [], ...free?.ended_externals || []].find(member => member.name === name)?.external?.platform;
  const vendor = platform && platform !== "Custom" ? PLATFORM_IDENTITIES[platform] : null;
  return { label: t('外部专家'), icon: vendor?.icon || EXTERNAL_ICON, style: vendor?.style || 'external', description: t('外部专家') };
}

/** Reserved external names also retain their identity when shown in historical records. */
function external_identity(name) {
  return /^Custom-ext[0-9]*$/.test(name) || state.room?.members?.some(member => member.name === name && member.access === 'external');
}
const state = { rooms: [], folders: [], room: null, page: 1, pages: 1, query: "", mention_only: false, host_only: false, authors: [], card_kinds: [],
  named_followup: false, create_discussion: false, create_goal: null,
  archive_view: false, directory_sort: "manual", management: null, dragged_room: null, folder_moves: new Map(), folder_version: 0, removing_members: new Set(),
  reply_to: null, tab: "discussion", refresh_version: 0, context_dirty: false, topic_dirty: false,
  snapshot_id: 0, pending_room: null, toast_timer: null, queued_taken: 0,
  // When live room data stopped (page hidden, connection lost); null while it is current. Silence is judged only up to here.
  observed_until: null,
  // Back from the background: the transcript shows the opening load until the next full read finishes.
  resuming: false };
const live_updates = { source: null, connected: false, enabled: false, timer: null, poll_timer: null,
  running: false, dirty: false, full: false, revisions: "", refreshed_at: 0 };
state.messages = [];
state.message_history = null;
// Cards read with the unfiltered transcript (executions, plans, missed turns, decisions), for history older than the room view's recent ones.
state.history_cards = null;
// True until the first attempt to read the room list finishes, so the page shows loading instead of an empty directory.
state.rooms_loading = true;
// The read started by opening a room; live refreshes wait for it instead of superseding it and discarding its answer.
state.opening = null;
// Whether the directory shows the paired computer's rooms, and whether that computer is currently connected.
state.remote_rooms = false;
// The room last opened on any device, as the computer's website keeps it; "" until the room list is read.
state.last_room = "";
state.remote_online = null;
state.remote_site = "";
// The last full view and transcript of recently opened rooms: reopening one shows it at once while the site is read again,
// and only messages after the cached ones are fetched. A later retract or rewind reaches them through the room's withdrawal list.
const ROOM_CACHE_LIMIT = 12;
const room_views = new Map();
// Member settings read for a new room before it opens, used once by its first load_room_models.
const preloaded_room_models = new Map();
// How long a new room's placeholder waits for the room's content before opening it anyway.
const ROOM_PRELOAD_LIMIT_MS = 4000;
const message_histories = new Map();
const history_cards = new Map();
// Rooms kept current in the background. Below ROOM_CACHE_LIMIT, so these reads never evict each other and re-read whole transcripts.
const BACKGROUND_ROOM_LIMIT = 8;
// A working room reports progress constantly; new messages and the end of its work are read at once regardless.
const BACKGROUND_PROGRESS_INTERVAL_MS = 5000;
// marks: what the directory said of each room when it was last read. queue: room id to the mark being read.
const background_reads = { marks: new Map(), read_at: new Map(), queue: new Map(), running: false, generation: 0 };
// Whether each room was at work when the directory was last read, so its turning idle can be announced once.
const room_running_seen = new Map();
// Work that stops and starts again within this time is one piece of work: an interjection, a retry or a relay hands it on in seconds.
const IDLE_NOTICE_DELAY_MS = 8000;
// Room id to the timer that will announce the end of its work, cancelled when the room is at work again.
const idle_notices = new Map();

/**
 * Announce in the toaster each room whose work has ended and stayed ended. The room on screen is never announced:
 * its own cards already show that the work is over.
 */
function announce_idle_rooms(rooms) {
  for (const room of rooms) {
    const was_running = room_running_seen.get(room.id);
    room_running_seen.set(room.id, Boolean(room.running));
    if (room.running || room.archived) {
      clearTimeout(idle_notices.get(room.id));
      idle_notices.delete(room.id);
    } else if (was_running && !idle_notices.has(room.id)) {
      idle_notices.set(room.id, setTimeout(() => {
        idle_notices.delete(room.id);
        if (state.room?.id !== room.id) notify("info", t('房间「{name}」的工作已结束', { name: room.title }));
      }, IDLE_NOTICE_DELAY_MS));
    }
  }
}

/** Cards of a later transcript batch replace the same ones read before; each kind is keyed by its id. */
function merge_history_cards(base, batch) {
  const merged = {};
  for (const kind of ["executions", "scheduler_decisions", "host_arrangements", "cancelled_turns"]) {
    const items = new Map((base?.[kind] || []).map((item) => [item.key || item.id, item]));
    for (const item of batch?.[kind] || []) items.set(item.key || item.id, item);
    merged[kind] = [...items.values()];
  }
  return merged;
}

/** Keep one entry per room, dropping the least recently used beyond the limit. */
function cache_room_entry(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > ROOM_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}
state.connected = false;
state.reconnecting = false;
state.attachment_drafts = [];
// Composer drafts set aside by editing a queued message, newest last; each send from the composer brings one back.
state.stashed_drafts = [];
state.upload_status = "";
// A server-queued message the user chose to send now.
state.sending_preview = null;
// The queued message whose files are being read for editing, and those already in the composer while the site removes them.
state.queue_reading = 0;
state.queue_taking = new Set();
// Failed submissions retain their original room, payload and attachments for retry until the page closes.
state.failed_sends = [];
state.attachment_preview = null;
state.archive_changes = new Map();
state.archive_version = 0;
// The open import's progress for the import dialog: { done, rooms: [{ title, status, members, error }], errors }.
state.import_progress = null;
state.directory_pending = new Map();
state.directory_version = 0;
state.navigation_version = 0;
state.admin = { loaded: false, local: false, registered: false, setup_available: false, logged_in: false, profile: null, identity_version: 0 };
// needs: "" | "pairing" | "renew"; pairing_code arrives from a scanned link (#pair=CODE); prompt waits for the user's tap.
state.device = { id: "", needs: "", pairing_code: "", pairing_fp: "", prompt: null };
state.launch = { available: false, remote: false, relay: null, connect_command: "", profiles: {}, projects: [], presets: [], builtin_presets: [], hidden_builtins: [], workflows: [], description_templates: {}, workspace: {}, scheduler: {}, create_preferences: {}, error: "", recoveries: [] };
state.create_host_workflows = false;
state.create_host_permissions = null;
// Mirrors DEFAULT_API_MAX_REQUESTS in runner/adapters/profiles.mjs; this classic script cannot import it.
const DEFAULT_API_MAX_REQUESTS = 300;
state.create_api_max_requests = DEFAULT_API_MAX_REQUESTS;
// Whether the new room lets its members draw with this computer's image service; chosen per room, never remembered.
state.create_image_generation = false;
let create_preferences_pending = {}, create_preferences_saving = null, create_preferences_version = 0;
let participant_choices_pending = {}, participant_choices_saving = null;
const PLATFORM_CLIENTS = { Claude: [{ value: "claude", label: "Claude Code CLI" }],
  Codex: [{ value: "codex_cli", label: "Codex CLI" }, { value: "codex", label: "Codex App" }],
  Antigravity: [{ value: "antigravity_cli", label: "Antigravity CLI" }, { value: "antigravity", label: "Antigravity App" }] };
for (const name of Object.keys(PLATFORM_IDENTITIES).filter(name => name !== "用户")) {
  (PLATFORM_CLIENTS[name] ||= []).push({ value: "api", label: PLATFORM_IDENTITIES[name].api_label || `${PLATFORM_IDENTITIES[name].label || name} API` });
}
// A platform is a type; `Claude-review` is another instance of it. Lookups by instance name fall back to the
// platform, while iteration still lists the platforms only.
const INSTANCE_PATTERN = /^(Codex|Claude|Antigravity|DeepSeek|Qwen|Grok|OpenAI|Custom)(?:-[0-9A-Za-z_]{1,16})?$/;
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
  // A share page carries the workspace script itself.
  if (!SHARE && !document.getElementById("modern-script")) {
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

// Building a formatter costs far more than using one, and every rendered message asks for its time.
const TIME_FORMAT = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Format a server timestamp in the viewer's local timezone. */
function format_time(value) {
  return TIME_FORMAT.format(new Date(value));
}

/** Display operation feedback only in the classic renderer. */
function show_toast(message, is_error = false) {
  // The channel themes stay quiet on success; failures go to the shared toaster.
  if (document.documentElement.dataset.theme.startsWith("channel")) { if (is_error) notify("error", message); return; }
  clearTimeout(state.toast_timer);
  element("toast").textContent = message;
  element("toast").classList.toggle("error", is_error);
  element("toast").hidden = false;
  state.toast_timer = setTimeout(() => { element("toast").hidden = true; }, TOAST_DURATION_MS);
}

/** Show a transient notice in the channel's toaster; level is "error", "warning", or "info". */
function notify(level, message) {
  document.dispatchEvent(new CustomEvent("discuss:notice", { detail: { level, message } }));
}

/** Show a rethrown error in its own wording, so the action dispatcher does not show it again. */
function notify_failure(error, message) {
  notify("error", message);
  error.notified = true;
}

// The administrator login is an HttpOnly cookie the website sets; this page never sees or stores the token. An older
// version kept it in localStorage, where any script could read it, so that copy is deleted.
try { localStorage.removeItem(ADMIN_SESSION_KEY); } catch { /* Nothing stored. */ }

// Reads started early during startup, each taken by the first request for the same path: steps that would otherwise
// wait for one another are sent together. A relay room path holds the relay answer; any other path holds the parsed body.
const prefetched = new Map();

/** Start a read now for a request that will come shortly; an unused or failed one changes nothing. */
function prefetch(path, read) {
  const reading = read();
  reading.catch(() => {});
  prefetched.set(path, reading);
}

/** The early read of this path, once, or null. */
function take_prefetch(path) {
  const reading = prefetched.get(path) || null;
  prefetched.delete(path);
  return reading;
}

/** Request JSON from the local or remotely hosted discussion service. */
async function request_json(path, payload, access_token) {
  // Only backend-owned fields with explicit templates are localized; original objects and user content stay intact.
  function localize(value) {
    if (Array.isArray(value)) return value.map(localize);
    if (!value || typeof value !== "object") return value;
    const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "texts" ? item : localize(item)]));
    for (const [field, metadata] of Object.entries(value.texts || {})) {
      if (Object.hasOwn(value, field)) result[field] = server_text(metadata, value[field]);
      else {
        const parts = field.match(/[^.[\]]+/g) || [];
        let parent = result;
        for (const part of parts.slice(0, -1)) parent = parent?.[part];
        const key = parts.at(-1);
        if (parent && Object.hasOwn(parent, key)) parent[key] = server_text(metadata, parent[key]);
      }
    }
    return result;
  }
  if (SHARE) return share_answer(path, payload, localize);
  // A share page records what the site answers now, so neither a kept copy nor an early read stands in for it.
  const recording = payload === undefined && share_recording;
  const record = (body) => { if (recording) recording.set(path, structuredClone(body)); return body; };
  // The room list and a room are read conditionally: unchanged, the copy already held is reused, the same object.
  const conditional = payload === undefined && ROOM_READ_PATH.test(path);
  const cached = conditional && !recording ? room_reads.get(path) : undefined;
  // The cache keeps the localized copy, so a 304 shows the page language and still reuses the same object.
  const remember = (status, body, etag) => {
    if (status === 304 && cached) return cached.body;
    const localized = localize(body);
    if (conditional) etag ? cache_room_entry(room_reads, path, { etag, body: localized }) : room_reads.delete(path);
    return localized;
  };
  if (computer_rooms_only() && ROOM_RELAY_PATH.test(path)) {
    if (!state.remote_rooms) throw Object.assign(new Error(COMPUTER_UNREACHABLE), { preflight: true });
    const answer = await (payload === undefined && !recording && take_prefetch(path) || relay_room_request(path, payload, cached?.etag));
    if (answer.status >= 200 && answer.status < 300) record(answer.body);
    return remember(answer.status, answer.body, answer.etag);
  }
  const early = payload === undefined && !recording && take_prefetch(path);
  // An early read is this function's own answer, already localized.
  if (early) return early;
  const options = { cache: "no-store" };
  const target_room = path.match(/^\/api\/rooms\/([^/?]+)/)?.[1];
  const token = access_token || (target_room ? localStorage.getItem(`discuss-access:${target_room}`) : null);
  options.headers = token ? { "X-Discussion-Token": token } : {};
  if (cached) options.headers["If-None-Match"] = cached.etag;
  // The online website has no accounts: a paired device signs its requests with its own non-exportable key.
  if ((state.admin.devices || paired_record()) && /^\/api\/(machines|admin\/profile|admin$)/.test(path)) {
    const credential = await device_credential(payload === undefined ? "GET" : "POST", path.split("?")[0]);
    if (credential) options.headers["X-CoDiscuss-Device"] = credential;
  }
  if (payload !== undefined) {
    options.method = "POST";
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  if (/^\/api\/(machines|admin)/.test(path)) options.signal = AbortSignal.timeout((Number.isInteger(payload?.wait) ? payload.wait : RELAY_DEFAULT_WAIT_MS) + MACHINE_REQUEST_MARGIN_MS);
  const response = await fetch(path, options);
  if (response.status === 304 && cached) return cached.body;
  const result = await response.json();
  // The hosted account's session ended (signed out elsewhere, expired, password reset): back to the sign-in (#5688).
  if (response.status === 401 && result?.code === "entry_login") { keep_draft_for_login(); window.location.assign("/_entry/login"); throw Object.assign(new Error(t('请先登录')), { status: 401 }); }
  if (!response.ok) throw Object.assign(new Error(server_text(result.error_text, result.error) || t('请求失败，请重试')), { preflight: response.status >= 400 && response.status < 500, status: response.status });
  record(result);
  return conditional ? remember(response.status, result, response.headers.get("ETag")) : localize(result);
}

/** The owner's public name and avatar replace the default "User" identity for every visitor. */
function apply_admin_identity(profile) {
  Object.assign(PLATFORM_IDENTITIES["用户"], { label: profile?.username || state.entry_account || DEFAULT_USER_LABEL, icon: profile?.avatar || DEFAULT_USER_ICON });
  state.admin.identity_version++;
  if (!element("participants")) return;
  for (const id of ["author-select", "new-room-host"]) {
    const option = Array.from(element(id)?.options || []).find(item => item.value === "用户");
    if (option) option.textContent = display_name("用户");
  }
  render_participants();
}

/** Record the server's administrator state and refresh every identity-dependent view without a reload. */
function apply_admin_state(info) {
  const local = info.local === true;
  const devices = info.devices === true;
  Object.assign(state.admin, { loaded: true, local, devices, computer_rooms: info.computer_rooms === true, registered: Boolean(info.registered), setup_available: Boolean(info.setup_available),
    logged_in: devices ? Boolean(paired_record()) : Boolean(info.logged_in), profile: info.profile ? { username: info.profile.username, avatar: info.profile.avatar || "" } : null });
  apply_admin_identity(state.admin.profile);
  publish_view();
}

/** Read the public administrator state; a failure leaves the visitor view unchanged. */
async function load_admin_state() {
  // Opened through a hosted account's sign-in entry: the account's name stands in until a display name is set (#5688).
  if (state.entry_account === undefined) {
    try { const session = await fetch("/_entry/session", { credentials: "same-origin", cache: "no-store" }); state.entry_account = session.ok ? String((await session.json()).account || "") : ""; }
    catch { state.entry_account = ""; }
  }
  try { apply_admin_state(await request_json("/api/admin")); }
  catch { /* The directory request reports connection problems. */ }
}

/** Return the first problem with an administrator form, matching the server's limits. */
function validate_admin_form({ username, password, confirm, check_password = true }) {
  const name_length = [...String(username ?? "").trim()].length;
  if (username !== undefined && (name_length < 1 || name_length > ADMIN_USERNAME_MAX)) return t('用户名需要 1–{value1} 个字符', { value1: ADMIN_USERNAME_MAX });
  if (!check_password) return "";
  const length = [...String(password ?? "")].length;
  if (length < ADMIN_PASSWORD_MIN || length > ADMIN_PASSWORD_MAX) return t('密码需要 {value1}–{value2} 个字符', { value1: ADMIN_PASSWORD_MIN, value2: ADMIN_PASSWORD_MAX });
  if (confirm !== undefined && confirm !== password) return t('两次输入的密码不一致');
  return "";
}

/** Keep the Chinese server message and add a retry hint when a locked response lacks the delay. */
function admin_error(error) {
  if (error.status === 429 && !/\d/.test(error.message)) error.message += t('，请稍后再试');
  return error;
}

/** Show the owner's identity once signed in; the website keeps the login in its cookie. */
function accept_admin_session({ profile }) {
  apply_admin_state({ registered: true, setup_available: false, logged_in: true, profile, computer_rooms: state.admin.computer_rooms });
  // Pairing and the paired computer both need the session, so read them again now.
  computer_rooms_only() ? connect_computer_rooms() : load_launch_settings();
}

/** Create the single administrator account and sign in with it. */
async function register_admin({ username, password, confirm, setup_key }) {
  const problem = validate_admin_form({ username, password, confirm }) || (String(setup_key ?? "").trim() ? "" : t('请填写注册令牌'));
  if (problem) throw new Error(problem);
  try { accept_admin_session(await request_json("/api/admin/register", { username: username.trim(), password, setup_key: setup_key.trim() })); }
  catch (error) { throw admin_error(error); }
}

/** Sign in and keep the session in this browser. */
async function login_admin({ username, password }) {
  if (!String(username ?? "").trim() || !password) throw new Error(t('请填写用户名和密码'));
  try { accept_admin_session(await request_json("/api/admin/login", { username: username.trim(), password })); }
  catch (error) { throw admin_error(error); }
}

/** Leave this browser: the website ends the login and clears its cookie. */
async function logout_admin() {
  try { await request_json("/api/admin/logout", {}); }
  catch { /* Shown as signed out either way; the login also expires on its own. */ }
  state.admin.logged_in = false;
  state.launch.relay = null;
  if (state.remote_rooms) await show_computer_rooms(false).catch(() => {});
  // Operations through the paired computer need the session, so they stop with it.
  if (relay_machine) load_launch_settings();
  publish_view();
}

/** List this account's live logins, each with the browser that signed in and whether it is this one. */
async function admin_sessions() {
  return (await request_json("/api/admin/sessions")).sessions;
}

/** End one other login by id, or every login but this one with { others: true }. */
async function revoke_admin_sessions(target) {
  await request_json("/api/admin/revoke", target);
}

/** Change the password after proving the current one; the website ends every other login. */
async function change_admin_password({ current_password, password, confirm }) {
  const problem = validate_admin_form({ username: "x", password, confirm });
  if (problem) throw new Error(problem);
  try { await request_json("/api/admin/password", { current_password, password }); }
  catch (error) { throw admin_error(error); }
}

/** Save the display name and/or avatar; an empty avatar restores the default. */
async function update_admin_profile(patch) {
  if (patch.username !== undefined) {
    const problem = validate_admin_form({ username: patch.username, check_password: false });
    if (problem) throw new Error(problem);
    patch = { ...patch, username: patch.username.trim() };
  }
  const result = await request_json("/api/admin/profile", patch);
  apply_admin_state({ local: state.admin.local, devices: state.admin.devices, computer_rooms: state.admin.computer_rooms, registered: true, setup_available: false, logged_in: true, profile: result.profile });
}

/** Shrink the chosen image into a small square data URL that fits the server limit. */
async function admin_avatar_from_file(file) {
  if (!file?.type?.startsWith("image/")) throw new Error(t('请选择图片文件'));
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const loaded = new Image();
      loaded.onload = () => resolve(loaded);
      loaded.onerror = () => reject(new Error(t('无法读取这张图片')));
      loaded.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error(t('无法读取这张图片'));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ADMIN_AVATAR_SIZE;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, ADMIN_AVATAR_SIZE, ADMIN_AVATAR_SIZE);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, ADMIN_AVATAR_SIZE, ADMIN_AVATAR_SIZE);
    const data_url = canvas.toDataURL("image/jpeg", ADMIN_AVATAR_QUALITY);
    if (data_url.length > ADMIN_AVATAR_MAX_CHARS) throw new Error(t('图片过大，请换一张'));
    return data_url;
  } finally { URL.revokeObjectURL(url); }
}

/** Whether this browser may write as the room owner: its own control credential, a logged-in administrator session, or the
 *  loopback-only local site, whose server writes as the owner for every visitor (`admin_as_owner`). */
function has_room_control(room_id) {
  if (SHARE) return false;
  return Boolean(localStorage.getItem(`discuss-access:${room_id}`) || state.admin.local || state.admin.logged_in);
}

/** Explain why a management write failed when this browser has neither credential. */
function management_error_message(room_id, error) {
  if (error.status === 403 && !state.admin.logged_in && !localStorage.getItem(`discuss-access:${room_id}`)) return MANAGEMENT_LOGIN_HINT;
  return error.message;
}

let reconnect_timer = null, reconnect_attempt = 0;
/** Reconnect without waiting for the user, backing off while the site or the computer stays away. */
function schedule_reconnect() {
  if (reconnect_timer !== null || document.hidden) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnect_attempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnect_attempt += 1;
  reconnect_timer = setTimeout(() => {
    reconnect_timer = null;
    if (!state.connected && !document.hidden) reconnect_live_updates({ automatic: true });
  }, delay);
}

/** Show connection state without claiming that any AI is online; a lost connection is retried automatically. */
function set_connection(connected) {
  state.connected = connected;
  state.reconnecting = false;
  if (connected) { clearTimeout(reconnect_timer); reconnect_timer = null; reconnect_attempt = 0; }
  else { state.observed_until ??= Date.now(); schedule_reconnect(); }
  element("connection-dot").className = `status-dot ${connected ? "connected" : "failed"}`;
  element("connection-status").textContent = connected ? t('讨论网站已连接') : t('网站连接中断，可手动刷新');
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
    if (!copied) throw new Error(t('浏览器未允许自动复制，请手动选择内容复制'));
  }
  show_toast(t('已复制'));
}

/** Create a submission identifier even on non-secure HTTP origins. */
function new_submission_id() {
  const bytes = new Uint8Array(SUBMISSION_ID_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

/** The name an ID shows outside any room: its platform's nickname (Antigravity → Gemini, Antigravity-2 → Gemini-2), else the ID. */
function default_name(name) { return IDENTITIES[name]?.label || name; }

/** Resolve a UI label without changing stored identity values; the open room's member labels come first. */
function display_name(name) {
  const label = state.room?.labels?.[name] || IDENTITIES[name]?.label || name;
  return label === name && name === "用户" ? t("用户") : label === name && name === "系统" ? t("系统") : label;
}

/** Render an identity avatar from a local SVG. */
function identity_avatar(identity) {
  return identity.icon ? `<img src="${escape_html(identity.icon)}" alt="">` : identity.initials;
}

/** Render identity controls and distinguish selectable identities from connections. */
function render_identities() {
  const options = Object.keys(IDENTITIES).map((name) => `<option value="${name}">${escape_html(display_name(name))}</option>`).join("");
  element("author-select").innerHTML = options;
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
  element("archive-toggle").textContent = state.archive_view ? t('返回讨论频道') : t('已存档 ({value1})', { value1: state.rooms.filter((room) => room.archived).length });
  element("archive-toggle").setAttribute("aria-pressed", String(state.archive_view));
  element("room-list").innerHTML = rooms.map((room, index) =>
    `<div class="directory-row" data-drag-room="${room.id}"><button type="button" class="directory-grip" data-drag-handle aria-label="${escape_html(t("拖动 {name}", { name: room.title }))}" title="${escape_html(t("拖动排序；上下方向键移动"))}">⠿</button><button class="room-item ${room.id === state.room?.id ? "active" : ""}" data-room="${room.id}" title="${escape_html(room.title)}"><span class="room-item-name">${escape_html(room.title)}</span><span class="room-item-number">${room.message_count}</span></button><details class="room-actions"><summary aria-label="${escape_html(t("管理 {name}", { name: room.title }))}">⋯</summary><div>${room_menu_html(room, index, rooms.length)}</div></details></div>`).join("") || `<p class="local-note">${escape_html(t("这里还没有频道。"))}</p>`;
  if (state.creating_room) element("room-list").innerHTML += `<p class="local-note">${escape_html(t("正在创建：{name}", { name: state.creating_room.title }))}</p>`;
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
  return [...state.rooms].sort((left, right) => room_activity_time(right) - room_activity_time(left)
    || (right.latest_id || 0) - (left.latest_id || 0));
}

/**
 * When a room last moved in the list: the latest message from the owner or a member, or its creation before the first
 * one, as the row's time shows. System notices leave it in place. A computer not yet updated only reports latest_at.
 */
function room_activity_time(room) {
  const speech = room.latest_speech_at === undefined ? room.latest_at : room.latest_speech_at;
  return Date.parse(speech || room.created_at || "") || 0;
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
  return [["rename", t('重命名'), state.directory_pending.has(`rename:${room.id}`)], ["backup", t('导出对话'), state.backup_pending], [room.archived ? "restore" : "archive", room.archived ? t('恢复频道') : t('存档频道'), state.archive_changes.has(room.id)],
    ["up", t('上移'), ordering || state.directory_sort === "recent" || index === 0], ["down", t('下移'), ordering || state.directory_sort === "recent" || index === count - 1], ["delete", t('删除频道'), state.directory_pending.has(`rename:${room.id}`)]]
    .map(([action, label, disabled]) => `<button type="button" data-manage-room="${room.id}" data-room-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`).join("");
}

/** Switch only the directory filter, preserving the open conversation and drafts. */
function toggle_archives() { state.archive_view = !state.archive_view; render_rooms(); publish_view(); }

/** Dispatch directory changes without waiting for unrelated reads. */
async function manage_channel({ id, action, title, before_id, folder_id, undo }) {
  if (action === "folder") return assign_channel_folder(id, folder_id ?? null);
  if (["archive", "restore"].includes(action)) return archive_channel(id, action === "archive", { undo });
  if (action === "rename") return rename_channel(id, title);
  if (action === "move") return reorder_channel(id, before_id);
  if (action === "delete") return delete_channel(id);
}

/** Save an optimistic directory edit with a lock limited to its affected resource. */
async function update_directory(change) {
  if (state.directory_pending.has(change.key)) return;
  state.directory_pending.set(change.key, change);
  state.directory_version++;
  change.apply();
  render_rooms();
  publish_view();
  try {
    const saved = await change.save();
    change.commit?.(saved);
    return saved;
  } catch (error) {
    change.rollback();
    notify_failure(error, change.error_message?.(error) || t('{value1}失败，已恢复原状态：{value2}', { value1: change.label, value2: error.message }));
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
  return update_directory({ key: `rename:${id}`, patch, label: t('「{value1}」重命名', { value1: room.title }),
    apply: () => patch_directory_room(id, patch), rollback: () => patch_directory_room(id, { title: room.title }),
    save: () => request_json(`/api/rooms/${id}/rename`, { actor: "用户", ...patch }),
    commit: saved => patch_directory_room(id, { title: saved.title }) });
}

/** Show the new room order before its single write completes. */
async function reorder_channel(id, before_id) {
  const previous = state.rooms.map(room => room.id);
  return update_directory({ key: "room-order", label: t('频道排序'),
    apply: () => { state.rooms = move_directory_item(state.rooms, id, before_id); },
    rollback: () => { state.rooms = directory_order(state.rooms, previous); },
    save: () => request_json(`/api/rooms/${id}/move`, { actor: "用户", before_id }) });
}

/** Hide a confirmed deletion immediately and restore only that entry on failure. */
async function delete_channel(id) {
  const room = state.rooms.find(item => item.id === id);
  if (!room) return;
  const previous = state.rooms.map(item => item.id);
  return update_directory({ key: `delete:${id}`, label: t('「{value1}」删除', { value1: room.title }),
    error_message: error => t('「{value1}」删除失败，已恢复原状态：{value2}', { value1: room.title, value2: management_error_message(id, error) }),
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

/** Offer an undo notice for an archive shown but not yet saved; resolves false when the user takes it back. */
function archive_undo_window(id, title) {
  return new Promise(resolve => {
    let settled = false;
    const settle = keep => { if (!settled) { settled = true; resolve(keep); } };
    document.dispatchEvent(new CustomEvent("discuss:undo", { detail: { id: `archive:${id}`, message: t('已存档「{value1}」', { value1: title }),
      duration: ARCHIVE_UNDO_MS, view: () => execute_view_action("room", id), settle } }));
  });
}

/** Move a channel immediately and reconcile only its archive fields after saving. With undo, an archive waits out
 * the undo notice before it is saved, since saving stops the room's work and restoring would not bring that back. */
async function archive_channel(id, archived, { undo = false } = {}) {
  const room = state.room?.id === id ? state.room : state.rooms.find((item) => item.id === id);
  if (!room || state.archive_changes.has(id) || Boolean(room.archived) === archived) return;
  const previous = { archived: Boolean(room.archived), phase: room.phase };
  const change = { archived, phase: archived && room.phase && room.phase !== "concluded" ? "paused" : room.phase };
  state.archive_changes.set(id, change);
  state.archive_version++;
  display_channel_archive(id, change);
  if (archived && undo) {
    if (state.room?.id === id) await open_welcome();
    if (!await archive_undo_window(id, room.title)) {
      display_channel_archive(id, previous, change);
      state.archive_changes.delete(id);
      state.archive_version++;
      return publish_view();
    }
  }
  try {
    const saved = await request_json(`/api/rooms/${id}/${archived ? "archive" : "restore"}`, { actor: "用户" });
    display_channel_archive(id, { archived: Boolean(saved.archived), phase: saved.phase }, change);
  } catch (error) {
    notify_failure(error, t('「{value1}」{value2}失败，已恢复原状态：{value3}', { value1: room.title, value2: archived ? t('存档') : t('恢复'), value3: management_error_message(id, error) }));
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
  state.folder_moves.set(id, folder_id);
  state.folder_version++;
  display_channel_folder(id, folder_id);
  try {
    const saved = await request_json(`/api/rooms/${id}/folder`, { actor: "用户", folder_id });
    display_channel_folder(id, saved.folder_id ?? null);
    show_toast(t('话题归类已更新'));
  } catch (error) {
    notify_failure(error, t('「{value1}」归类失败，已恢复原状态：{value2}', { value1: room.title, value2: error.message }));
    display_channel_folder(id, previous_folder);
    throw error;
  } finally {
    state.folder_moves.delete(id);
    state.folder_version++;
  }
}

/** Display a provisional folder while its identifier is being assigned. */
async function create_folder({ name, directories = [] }) {
  const folder = { id: `pending-${new_submission_id()}`, name: name.trim(), directories, pending: true };
  return update_directory({ key: "create-folder", label: t('文件夹「{value1}」创建', { value1: folder.name }),
    apply: () => { state.folders = [...state.folders, folder]; },
    rollback: () => { state.folders = state.folders.filter(item => item.id !== folder.id); },
    save: () => request_json("/api/folders", { name: folder.name, directories }),
    commit: saved => { state.folders = state.folders.map(item => item.id === folder.id ? saved : item); } });
}

/** Rename the exact folder and replace its project paths, without moving its conversations or changing selection. */
async function rename_folder({ id, name, directories }) {
  const folder = state.folders.find(item => item.id === id);
  if (!folder || folder.pending || !name.trim()) return;
  const display = (value, paths) => { state.folders = state.folders.map(item => item.id === id ? { ...item, name: value, directories: paths } : item); };
  return update_directory({ key: `folder-name:${id}`, label: t('文件夹「{value1}」保存', { value1: folder.name }),
    apply: () => display(name.trim(), directories), rollback: () => display(folder.name, folder.directories),
    save: () => request_json(`/api/folders/${encodeURIComponent(id)}/rename`, { name: name.trim(), directories }),
    commit: saved => display(saved.name, saved.directories) });
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
    return await update_directory({ key: "folder-order", removed_folder: id, label: t('文件夹「{value1}」移除', { value1: folder.name }),
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
  groups.splice(state.uncategorized_position ?? groups.length, 0, { id: "", order_id: "__uncategorized__", name: t('未归类') });
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
    await update_directory({ key: "folder-order", label: t('文件夹排序'), apply: () => reorder(next), rollback: () => reorder(previous),
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
  element("room-subtitle").textContent = t('{value1}{value2} 条发言', { value1: room.archived ? t('已存档 · ') : '', value2: room.message_count });
  element("message-count").textContent = room.message_count;
  element("room-goal").textContent = room.goal || t('尚未填写议题目标。');
  element("latest-id").textContent = `#${room.latest_id}`;
  element("state-version").textContent = t('整理至 #{value1}', { value1: room.state_until });
  element("state-update-note").textContent = t('当前记录至 #{value1}；保存后标记为本次打开的 #{value2}。', { value1: room.latest_id, value2: state.snapshot_id });
  if (!state.context_dirty) {
    element("state-input").value = room.state_text;
    element("brief-input").value = room.host_brief?.text || "";
    state.snapshot_id = room.latest_id;
    element("state-update-note").textContent = t('保存时标记整理至 #{value1}，原始发言保持不变。', { value1: state.snapshot_id });
  }
  render_topic();
  render_host_brief();
}

/** Rounds as labelled in the UI: counted by the round budget when the room has one, otherwise by the roster. */
function round_groups(room) {
  return Array.isArray(room.round_groups) ? room.round_groups : null;
}

/** Describe the designated respondent without claiming that their app is generating. */
function progress_speaker(room) {
  const turn = room.current_turn;
  if (room.phase === "concluded") return t('讨论已收束');
  if (room.phase === "paused") return t('已暂停{value1}', { value1: turn && ["pending", "notified"].includes(turn.status) ? t(' · 原安排 {value1}', { value1: turn.expert }) : "" });
  if (turn && ["pending", "notified"].includes(turn.status)) return t('等待 {value1} 回答 · {value2}', { value1: turn.expert, value2: turn_label(turn, room) });
  return room.round_groups?.length || room.answered_turns || turn?.status === "answered" ? t('等待主持人安排下一步') : t('尚未开始发言');
}

/** Explain an empty transcript using the room's actual progression state. */
function empty_discussion_message(room) {
  // A room opened for the first time has no transcript until the site answers; it is not an empty discussion.
  if (state.messages_loading) return t('正在读取消息…');
  if (room.archived || room.phase === 'concluded') return t('讨论已结束，尚未产生发言记录。');
  return t('写下任务并点名成员。程序唤醒由本机服务交付；手动成员需在原会话触发。');
}

/** Keep a saved brief's evidence cutoff visible next to the live assignment status. */
function brief_meta(room) {
  const brief = room.host_brief;
  return brief?.text ? t('{value1} 主持 · {value2} 更新 · 整理至 #{value3}', { value1: display_name(room.host), value2: new Date(brief.updated_at).toLocaleString("zh-CN"), value3: brief.until }) : t('{value1} 主持 · 尚未发布简报', { value1: display_name(room.host) });
}

/** Render the host's own concise account, independently from the full state editor. */
function render_host_brief() {
  const room = state.room;
  element("host-brief-panel").hidden = !room;
  if (!room) return;
  room.rendered_brief = render_room_markdown(room.host_brief?.text || t('主持人尚未更新结论、共识、歧义与下一步意图。'));
  element("progress-speaker").textContent = progress_speaker(room);
  element("host-brief-text").innerHTML = room.rendered_brief;
  element("host-brief-meta").textContent = brief_meta(room);
}

/** Describe roles separately from authors and the actual submitter. */
function message_provenance(message) {
  const role = message.kind === "receipt" ? t('运行回执') : message.kind === "moderation" ? t('主持发言') : (message.author === "用户" ? t('用户发言') : t('专家观点'));
  const forwarding = message.submitted_by && message.submitted_by !== message.author ? t(' · {value1} 代发', { value1: display_name(message.submitted_by) }) : "";
  return `${role}${forwarding}`;
}

/** Render continuous history while retaining expanded answers and reading position. */
// Rendered copies by the cached record they came from, so leaving a filter reuses them instead of rendering every
// message's Markdown again.
const rendered_messages = new WeakMap();
function render_messages(result) {
  const previous = new Map(state.messages.map((message) => [message.id, message]));
  // Cached history is read once; a later retract or rewind reaches it through the room's withdrawal list.
  const withdrawn = new Map((state.room?.withdrawals || []).map((item) => [item.message_id, item.kind]));
  const messages = result.messages.map((message) => {
    const saved = previous.get(message.id) || rendered_messages.get(message);
    const kind = withdrawn.get(message.id) || message.withdrawn || "";
    let shown;
    // A message shown straight from its send response is replaced by the copy the transcript reads.
    if (saved && !saved.just_sent) shown = (saved.withdrawn || "") === kind ? saved : { ...saved, withdrawn: kind };
    else shown = { ...message, withdrawn: kind, rendered_text: link_attachment_placeholders(render_room_markdown(message.text), message.attachments),
      rendered_summary: render_room_markdown(message.summary || "") };
    rendered_messages.set(message, shown);
    return shown;
  });
  // An unchanged transcript keeps its array, so views that depend on it are not recomputed.
  if (messages.length !== state.messages.length || messages.some((message, index) => message !== state.messages[index])) state.messages = messages;
  state.message_total = result.total;
  // A message shown straight from its send response brings no cards; the ones already read stay.
  if ("cards" in result) state.history_cards = result.cards;
  state.messages_loading = false;
  state.messages_failure = "";
  // The Vue transcript renders from state.messages; the hidden controller markup is not rebuilt on every refresh.
  state.pages = result.pages;
}

/** The read of one transcript batch after message `after`. */
function history_batch_path(room_id, query, after) {
  // Large batches: a long transcript loads in one round-trip, and the site counts the room's messages once, not per batch.
  const params = new URLSearchParams({ q: query, withdrawn: "include", limit: MESSAGE_HISTORY_BATCH });
  // The full transcript also takes the cards of each batch; a search shows no cards.
  if (!query) params.set("cards", "1");
  params.set("after", after);
  return `/api/rooms/${room_id}/messages?${params}`;
}

/** Join bounded cursor batches for the interactive transcript; refresh only new records. */
async function load_message_history(room_id, version) {
  const query = state.query;
  const history = await read_message_history(room_id, query, () => version === state.refresh_version);
  if (history) state.message_history = { key: `${room_id}?${new URLSearchParams({ q: query, withdrawn: "include" })}`, messages: history.messages };
  return history;
}

/** Read the messages after the cached ones into the cache; null once `wanted` says the answer is no longer needed. */
async function read_message_history(room_id, query, wanted) {
  const key = `${room_id}?${new URLSearchParams({ q: query, withdrawn: "include" })}`;
  const messages = [...message_histories.get(key) || []];
  let cards = history_cards.get(key) || null;
  let has_more = true;
  while (has_more) {
    const result = await request_json(history_batch_path(room_id, query, messages.at(-1)?.id || 0));
    if (!wanted()) return null;
    messages.push(...result.messages);
    if (result.cards) cards = merge_history_cards(cards, result.cards);
    has_more = result.has_more;
  }
  cache_room_entry(message_histories, key, messages);
  if (cards) cache_room_entry(history_cards, key, cards);
  return { messages, cards, total: messages.length, page: 1, pages: 1 };
}

/** Forget background reads when the directory changes to another computer's rooms. */
function reset_background_reads() {
  background_reads.generation++;
  background_reads.marks.clear();
  background_reads.read_at.clear();
  background_reads.queue.clear();
}

/**
 * Queue the rooms not on screen that are working or changed since last read, so switching to one shows its latest state.
 * A room idle since this page opened is left unread.
 */
function sync_background_rooms(rooms) {
  const { marks, read_at, queue } = background_reads;
  const now = Date.now();
  const wanted = rooms.filter((room) => {
    if (room.id === state.room?.id) return false;
    const mark = `${room.latest_id}:${Boolean(room.running)}`;
    const known = marks.get(room.id);
    if (known === undefined && !room.running) { marks.set(room.id, mark); return false; }
    return known !== mark || (room.running && now - (read_at.get(room.id) || 0) >= BACKGROUND_PROGRESS_INTERVAL_MS);
  });
  wanted.sort((first, second) => second.latest_id - first.latest_id);
  for (const room of wanted.slice(0, BACKGROUND_ROOM_LIMIT)) queue.set(room.id, `${room.latest_id}:${Boolean(room.running)}`);
  return run_background_reads();
}

/** Read queued rooms one at a time, so background rooms never crowd out the open room's reads. */
async function run_background_reads() {
  if (background_reads.running) return;
  background_reads.running = true;
  try {
    while (background_reads.queue.size && !document.hidden) {
      const [room_id, mark] = background_reads.queue.entries().next().value;
      background_reads.queue.delete(room_id);
      await read_background_room(room_id, mark);
    }
  } finally { background_reads.running = false; }
}

/** Cache one room's view and new messages; the open room's own reads take over if the user switches to it meanwhile. */
async function read_background_room(room_id, mark) {
  const generation = background_reads.generation;
  const wanted = () => generation === background_reads.generation && state.room?.id !== room_id;
  background_reads.read_at.set(room_id, Date.now());
  try {
    const [room, history] = await Promise.all([request_json(`/api/rooms/${room_id}`), read_message_history(room_id, "", wanted)]);
    if (!history || !wanted()) return;
    cache_room_entry(room_views, room_id, room);
    background_reads.marks.set(room_id, mark);
  } catch (error) {
    // Nothing on screen depends on this read. A refused room waits for its next change; a network failure retries on the next directory read.
    if (error.preflight && wanted()) background_reads.marks.set(room_id, mark);
    console.debug("background room read failed", room_id, error);
  }
}

/** The unfiltered transcript cached for a room, shaped like a loaded history, or null. */
function cached_message_history(room_id) {
  const key = `${room_id}?${new URLSearchParams({ q: "", withdrawn: "include" })}`;
  const messages = message_histories.get(key);
  return messages ? { messages, cards: history_cards.get(key) || null, total: messages.length, page: 1, pages: 1 } : null;
}

/** Show the room and transcript as each arrives, independently of the directory read. */
async function refresh_room_content(room_id, version, versions) {
  const current = () => version === state.refresh_version && state.room?.id === room_id;
  const room_read = request_json(`/api/rooms/${room_id}`).then((room) => {
    if (!current()) return;
    cache_room_entry(room_views, room_id, room);
    state.room = merge_room_folder(room, versions.folder, versions.archive, versions.directory);
    render_room();
    // With a transcript already shown, the new room state waits for the new transcript and both show in one snapshot:
    // the room's requests and working cards laid out against the old messages, then again against the new ones, made
    // the page collapse and refill for a moment after every send. A room opened for the first time shows at once.
    if (!history_read || !state.messages.length) publish_view();
    load_room_models();
  });
  const history_read = state.tab === "discussion" ? load_message_history(room_id, version).then(async (result) => {
    // A room opened for the first time has only its directory entry: the topic card and the transcript wait for each
    // other and show together, so neither pushes the other down when it arrives (user 2026-11-18, #4818).
    if (!state.room?.experts) await room_read;
    if (current() && result) { render_messages(result); publish_view(); }
  }) : null;
  // Only a transcript not yet read shows the loading state; re-reading an empty room keeps its empty view.
  const history_key = `${room_id}?${new URLSearchParams({ q: state.query, withdrawn: "include" })}`;
  if (history_read && !state.messages.length && state.message_history?.key !== history_key) { state.messages_loading = true; publish_view(); }
  try {
    await Promise.all([room_read, history_read]);
    if (current()) publish_view();
  } catch (error) {
    // With the room's messages already on screen a failed re-read changes nothing there: the connection status says it,
    // and reconnecting reads again by itself. Only a room with nothing to show tells why in its place (2026-11-17: a
    // relay blip put a full-width error under the cards every few minutes).
    if (current()) {
      state.messages_loading = false;
      if (!state.messages.length) state.messages_failure = error.message;
      else set_connection(false);
      publish_view();
    }
    throw error;
  }
}

/** Refresh a room with version guards so slower requests cannot change the active view. */
async function refresh_room({ room: read_room = true } = {}) {
  if (state.dragged_room) return;
  if (computer_rooms_only() && !state.remote_rooms) {
    state.rooms = [];
    set_folder_directory({});
    render_rooms();
    set_connection(true);
    return;
  }
  const version = ++state.refresh_version;
  const folder_version = state.folder_version;
  const archive_version = state.archive_version;
  const directory_version = state.directory_version;
  const room_id = state.room?.id;
  // The room and its transcript are read beside the directory rather than after it, saving a round trip on every open.
  const directory_read = request_json("/api/rooms");
  const reading = state.room && read_room ? room_id : null;
  const content_read = reading ? refresh_room_content(room_id, version, { folder: folder_version, archive: archive_version, directory: directory_version }) : null;
  // A room removed meanwhile answers 404; the directory decides what is shown, so such answers may go unread.
  content_read?.catch(() => {});
  if (reading) live_updates.refreshed_at = Date.now();
  const directory = await directory_read;
  if (version !== state.refresh_version) return;
  sync_background_rooms(directory.rooms);
  announce_idle_rooms(directory.rooms);
  if (!state.directory_pending.size && directory_version === state.directory_version) {
    state.rooms = directory.rooms.map((room) => merge_room_folder(room, folder_version, archive_version, directory_version));
    set_folder_directory(directory);
  }
  render_rooms();
  publish_view();
  if (directory.last_room !== undefined && !state.room) state.last_room = directory.last_room;
  if (state.room && !state.rooms.some((item) => item.id === state.room.id)) return select_room(visible_rooms()[0]?.id);
  if (!state.room || !read_room) {
    if (!state.room && !state.welcome && visible_rooms().length) return select_room(opening_room());
    render_rooms();
    set_connection(true);
    return;
  }
  await content_read;
  if (version !== state.refresh_version || state.room?.id !== room_id) return;
  render_rooms();
  set_connection(true);
}

/** Select a room and reset room-specific draft and filter state. */
// The room last opened in this browser, reopened on the next visit instead of the first in the list.
const LAST_ROOM_KEY = "ai-codiscuss-last-room";

/**
 * The room to open when none is chosen: the address's room, else the one last opened on any device (kept by the
 * computer's website), else the one last opened in this browser, else the first listed.
 */
function opening_room() {
  let last = null;
  try { last = localStorage.getItem(LAST_ROOM_KEY); } catch { /* Storage may be unavailable. */ }
  const wanted = [new URLSearchParams(location.search).get("room"), state.last_room, last].find((id) => id && state.rooms.some((room) => room.id === id));
  return wanted || visible_rooms()[0]?.id;
}

/** Tell the computer's website which room was opened, so another device opens it next; failures change nothing. */
function remember_room(room_id) {
  try { localStorage.setItem(LAST_ROOM_KEY, room_id); } catch { /* Keep working without remembering. */ }
  if (state.last_room === room_id || (computer_rooms_only() && !state.remote_rooms)) return;
  state.last_room = room_id;
  request_json("/api/rooms/last", { room_id }).catch(() => {});
}

// A hosted account's sign-in that ran out sends the page to the entry's sign-in; the open room's unsent text waits in
// this tab's storage and comes back when the room opens again (#5696).
const LOGIN_DRAFT_KEY = "discuss-login-draft";
function keep_draft_for_login() {
  const text = element("message-input")?.value || "";
  if (!state.room?.id || !text.trim()) return;
  try { sessionStorage.setItem(LOGIN_DRAFT_KEY, JSON.stringify({ room: state.room.id, text })); } catch { /* Storage may be unavailable. */ }
}
function take_draft_after_login(room_id) {
  let kept = null;
  try { kept = JSON.parse(sessionStorage.getItem(LOGIN_DRAFT_KEY) || "null"); } catch { kept = null; }
  if (!kept || kept.room !== room_id) return;
  try { sessionStorage.removeItem(LOGIN_DRAFT_KEY); } catch { /* Nothing to clear. */ }
  if (!element("message-input").value) element("message-input").value = kept.text;
}

// Each room keeps its unsent composer (text, files, reply) while another room is open, until this page closes.
const room_composer_drafts = new Map();

/** Keep the open room's unsent text, files, reply and stashed drafts aside; true when there was something to keep. */
function keep_room_composer() {
  const room_id = state.room?.id;
  if (!room_id) return false;
  const text = element("message-input").value;
  const reply = state.reply_to ? { id: state.reply_to, label: element("reply-label").textContent } : null;
  if (!text.trim() && !state.attachment_drafts.length && !reply && !state.stashed_drafts.length) { room_composer_drafts.delete(room_id); return false; }
  room_composer_drafts.set(room_id, { text, drafts: state.attachment_drafts, reply, stashed: state.stashed_drafts });
  state.attachment_drafts = [];
  state.stashed_drafts = [];
  return true;
}

/** Put back what the room had in its composer when it was left. */
function restore_room_composer(room_id) {
  const kept = room_id && room_composer_drafts.get(room_id);
  if (!kept) return;
  room_composer_drafts.delete(room_id);
  state.stashed_drafts = kept.stashed || [];
  fill_composer(kept.text, kept.drafts, kept.reply);
}

async function select_room(room_id) {
  if (room_id) { state.welcome = false; state.welcome_folder = null; }
  keep_room_composer();
  state.navigation_version++;
  state.refresh_version++;
  const listed = state.rooms.find((room) => room.id === room_id);
  // A room opened before is shown as last read, with the directory's newer title, folder and archive state, until the site answers.
  const cached = listed && room_views.get(room_id);
  state.room = cached ? { ...cached, ...listed } : listed;
  state.upload_status = "";
  state.sending_preview = null;
  state.page = 1;
  state.query = "";
  state.mention_only = false;
  state.host_only = false;
  state.authors = [];
  state.card_kinds = [];
  state.context_dirty = false;
  state.topic_dirty = false;
  clear_attachment_drafts();
  for (const stashed of state.stashed_drafts) release_files(stashed.drafts);
  state.stashed_drafts = [];
  state.launch.repair = null;
  state.launch.room_models = null;
  state.messages = [];
  state.message_history = null;
  state.history_cards = null;
  element("message-input").value = "";
  element("search-input").value = "";
  element("mention-filter").setAttribute("aria-pressed", "false");
  cancel_reply();
  restore_room_composer(state.room?.id);
  if (state.room) take_draft_after_login(state.room.id);
  select_tab("discussion", { refresh: false });
  // A share page is one file or one fixed address: its location and this browser's last room stay as they are.
  if (!SHARE) history.replaceState(null, "", state.room ? `/?room=${encodeURIComponent(room_id)}` : "/");
  if (state.room && !SHARE) remember_room(room_id);
  if (state.room) state.archive_view = Boolean(state.room.archived);
  else {
    element("host-brief-panel").hidden = true;
    element("room-title").textContent = t('让讨论开始');
    element("room-subtitle").textContent = t('创建一个房间，从一句话开始。');
    element("room-goal").textContent = t('进入房间后查看本次议题。');
    element("message-count").textContent = "0";
    element("latest-id").textContent = "#0";
  }
  const cached_history = cached && cached_message_history(room_id);
  state.messages_loading = Boolean(state.room) && !cached_history;
  state.messages_failure = "";
  render_rooms();
  if (cached) render_room();
  if (preloaded_room_models.has(room_id)) load_room_models();
  if (cached_history) {
    render_messages(cached_history);
    // Marks the transcript as read, so re-reading an empty room does not bring the loading state back.
    state.message_history = { key: `${room_id}?${new URLSearchParams({ q: "", withdrawn: "include" })}`, messages: cached_history.messages };
  }
  publish_view();
  const reading = state.opening = refresh_room();
  try { await reading; }
  catch (error) { if (state.room?.id === room_id && !state.messages.length) state.messages_failure = error.message; throw error; }
  finally {
    if (state.opening === reading) state.opening = null;
    if (state.messages_loading && state.room?.id === room_id) { state.messages_loading = false; publish_view(); }
  }
}

/** Switch between history, manually maintained state, and participation guidance; `refresh: false` when the caller reads the room itself. */
function select_tab(tab_name, { refresh = true } = {}) {
  state.navigation_version++;
  state.tab = tab_name;
  document.querySelectorAll("[data-tab]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tab_name);
    tab.setAttribute("aria-selected", String(tab.dataset.tab === tab_name));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => { panel.hidden = panel.dataset.panel !== tab_name; });
  if (tab_name === "discussion" && refresh) run_action(refresh_room);
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
  if ([...text].length > MAX_MESSAGE_LENGTH) throw new Error(t('留言最多 {value1} 字，原文已保留，请调整后提交', { value1: MAX_MESSAGE_LENGTH }));
  // The owner always speaks as the user; naming members is the server's job.
  const members = state.room.free?.members || [];
  const payload = { author: "用户", text, reply_to: state.reply_to, kind: "chat", submitted_by: "用户" };
  const active = members.filter(member => member.status === "active" && (member.access !== "manual" || member.registered_at)
    && (member.access !== "external" || member.external?.claimed_at !== 0)).map(member => member.name);
  // Members are named by the nickname shown on screen (or their name); the request carries the member name.
  const named_here = mentioned_members(text, active);
  const mentioned_member = name => named_here.has(name);
  const session = state.room.session;
  const session_live = session && ["active", "paused"].includes(session.status);
  if (session_live) {
    const direct = active.filter(mentioned_member);
    if (direct.length) payload.to = direct;
    return payload;
  }
  // @mentions outside code name members (@全体成员 or @all names them all, answering at once or in turn as smart scheduling decides;
  // @全体依次 or @all-seq has them answer one after another, the host first); without any, the server gives the message to the only member or the host.
  const sequential = mentioned(text, "全体依次") || mentioned(text, "all-seq");
  const everyone = !sequential && (mentioned(text, "全体成员") || mentioned(text, "all"));
  const named = sequential || everyone ? active : active.filter(mentioned_member);
  if (named.length) payload.to = named;
  if (sequential && named.length) payload.sequential = true;
  if (everyone && named.length) payload.order = "auto";
  // The site queues the message while members still work (or earlier ones wait) and posts it once the room is idle.
  if (state.room.free?.queued_messages?.queueing !== false) payload.queue = true;
  return payload;
}

/**
 * How a member may be @named: by the nickname shown on screen, and always by its member name. A nickname shared with
 * another member (or equal to another member's name) is ambiguous and is not used, so the member name stays the only way.
 */
function mention_handles(name, names) {
  const nickname = display_name(name);
  const taken = names.filter(other => other !== name).flatMap(other => [other, display_name(other)]);
  return nickname && nickname !== name && !taken.includes(nickname) ? [nickname, name] : [name];
}

/**
 * What renders as a mention: the user, each member by the handle @ offers for it, and the group mentions the send path
 * recognises (@全体成员 / @all, @全体依次 / @all-seq); a member ID with a nickname stays plain text.
 */
function mention_highlights() {
  const names = (state.room?.members || []).map(member => member.name);
  return ["用户", display_name("用户"), "全体成员", "all", "全体依次", "all-seq", ...names.map(name => mention_handles(name, names)[0])];
}

/** Render room text with the open room's mentions marked and `#123` message references clickable. */
function render_room_markdown(text) {
  return window.discuss_markdown.render_markdown(text, mention_highlights(), { message_refs: true });
}

/**
 * The members a text @names, longest handle first: once "@Claude评审" names one member, the shorter "@Claude" inside it
 * does not also name another (Chinese nicknames have no space after them).
 */
function mentioned_members(text, names) {
  let prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  const handles = names.flatMap(name => mention_handles(name, names).map(handle => ({ name, handle })))
    .sort((left, right) => right.handle.length - left.handle.length);
  const found = new Set();
  for (const { name, handle } of handles) {
    const pattern = new RegExp(`(^|[\\s(（，,。；;：:、])@${handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "gu");
    prose = prose.replace(pattern, (match, lead) => { found.add(name); return lead + " ".repeat(match.length - lead.length); });
  }
  return found;
}

/** Whether plain text (not code or quotes) names a member with @, so a typed mention selects it. */
function mentioned(text, name) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^>.*$/gm, "");
  return new RegExp(`(^|[\\s(（，,。；;：:、])@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "u").test(prose);
}

/** Clear this room's text, project and roster, then restore the user's last reusable choices. */
function reset_create_form(folder = null) {
  element("room-form").reset();
  render_expert_inputs("new-expert-modes", default_experts());
  render_host_options("new-room-host", [], "");
  state.launch.workspace = folder_workspace(folder);
  state.create_goal = null;
  apply_create_preferences();
  state.launch.profiles = JSON.parse(JSON.stringify(state.launch.saved_profiles || {}));
  Object.values(state.launch.profiles).forEach(fill_api_key);
  render_launch_settings();
  publish_view();
  return refresh_create_preferences();
}

/** A room created in a folder starts in the folder's project paths: the first is its main directory, the rest its other
 * directories. Only the local service resolves paths, so a device reaching its computer through the queued relay starts empty. */
function folder_workspace(folder) {
  const [cwd, ...extra_directories] = folder?.directories || [];
  if (!cwd || !state.launch.available) return {};
  return extra_directories.length ? { cwd, extra_directories } : { cwd };
}

/** Restore choices without touching the new room's title, project, members, host or goal text. */
function apply_create_preferences() {
  const preferences = state.launch.create_preferences || {};
  const scheduler = preferences.scheduler;
  const base_url = state.launch.scheduler_providers?.[scheduler?.provider]?.base_url;
  state.launch.scheduler = scheduler ? { ...scheduler, api_key_ref: state.launch.api_keys?.[base_url] || "" } : default_scheduler();
  state.named_followup = preferences.named_followup ?? false;
  state.create_discussion = preferences.drive === "discussion";
  state.create_goal = preferences.drive === "goal" ? { objective: state.create_goal?.objective || "",
    max_continues: preferences.goal_max_continues ?? 0, max_minutes: preferences.goal_max_minutes ?? 0,
    idle_seconds: preferences.goal_idle_seconds ?? GOAL_IDLE_SECONDS } : null;
  state.create_chain_rounds = preferences.chain_rounds ?? DEFAULT_CHAIN_ROUNDS;
  state.create_host_workflows = preferences.host_workflows ?? false;
  state.create_host_permissions = preferences.host_permissions ?? null;
  state.create_api_max_requests = preferences.api_max_requests ?? DEFAULT_API_MAX_REQUESTS;
  state.create_relay_rounds = preferences.relay_rounds ?? 0;
  for (const field of ["max_rounds", "max_minutes"]) {
    const control = element(`new-room-limit-${field}`);
    if (control && preferences[field] !== undefined) control.value = String(preferences[field]);
  }
}

/** Remember only changed preference fields; cancellation of the form does not undo these choices. */
function write_create_preferences(patch) {
  const current = state.launch.create_preferences || {};
  const changed = Object.fromEntries(Object.entries(patch).filter(([field, value]) => JSON.stringify(current[field]) !== JSON.stringify(value)));
  if (!Object.keys(changed).length) return;
  state.launch.create_preferences = { ...current, ...changed };
  create_preferences_pending = { ...create_preferences_pending, ...changed };
  create_preferences_version++;
  flush_create_preferences();
  publish_view();
}

/** Serialize preference patches so a slower earlier save cannot overwrite the latest operation. */
function flush_create_preferences() {
  if (create_preferences_saving) return create_preferences_saving;
  if (!state.launch.available || !Object.keys(create_preferences_pending).length) return Promise.resolve();
  const patch = create_preferences_pending;
  create_preferences_pending = {};
  create_preferences_saving = local_launch_request("settings", { create_preferences: patch }).catch(error => {
    create_preferences_pending = { ...patch, ...create_preferences_pending };
    notify("error", t('建房偏好未保存：{value1}', { value1: error.message }));
    return false;
  }).then(result => {
    create_preferences_saving = null;
    if (result !== false) return flush_create_preferences();
  });
  return create_preferences_saving;
}

/** Reopen with the paired computer's latest choices, keeping edits made while the read was in flight. */
async function refresh_create_preferences() {
  if (!state.launch.available) return;
  const version = create_preferences_version;
  await flush_create_preferences();
  try {
    const settings = await local_launch_request("settings");
    if (version !== create_preferences_version) return;
    for (const field of ["api_keys", "scheduler_providers", "workflows"]) {
      if (settings[field] !== undefined) state.launch[field] = settings[field];
    }
    state.launch.create_preferences = { ...settings.create_preferences, ...create_preferences_pending };
    apply_create_preferences();
    publish_view();
  } catch (error) { notify("error", t('建房偏好未读取：{value1}', { value1: error.message })); }
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

// A member description tells the scheduler and the host what this member is good at. A template per platform lives on
// the computer running the local service (this browser only without one); a draft typed on a card overrides it for the
// room being created or the member being invited.
const DESCRIPTION_TEMPLATE_PREFIX = "discuss-description-template:";
const description_drafts = {};
// A display label a card brings from a named preset; the room keeps it so screens show it instead of the instance name.
const label_drafts = {};
// The saved preset each card was added from, by card name: its "update preset" saves back to that preset.
const preset_origins = {};

/** Templates this browser kept before they moved to the local service, by platform. */
function browser_description_templates() {
  const templates = {};
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(DESCRIPTION_TEMPLATE_PREFIX)) templates[key.slice(DESCRIPTION_TEMPLATE_PREFIX.length)] = localStorage.getItem(key);
    }
  } catch { /* Unreadable storage holds no templates. */ }
  return templates;
}

/** This platform's saved description template, or "" when none. */
function description_template(name) {
  if (state.launch.available) return state.launch.description_templates[platform_of(name)] || "";
  return browser_description_templates()[platform_of(name)] || "";
}

/** Keep a platform's template; an empty text removes it. */
async function save_description_template(name, text) {
  const platform = platform_of(name);
  if (!state.launch.available) {
    const key = DESCRIPTION_TEMPLATE_PREFIX + platform;
    if (text.trim()) localStorage.setItem(key, text.trim()); else localStorage.removeItem(key);
    return publish_view();
  }
  const { [platform]: _, ...rest } = state.launch.description_templates;
  try { await save_presets({ description_templates: text.trim() ? { ...rest, [platform]: text.trim() } : rest }); }
  catch (error) { show_toast(t('默认描述未保存：{value1}', { value1: error.message }), true); }
}

/** Move templates this browser kept into the local service once, so every browser on this computer sees them. */
async function move_browser_description_templates() {
  const kept = browser_description_templates();
  if (!Object.keys(kept).length) return;
  try {
    await save_presets({ description_templates: { ...kept, ...state.launch.description_templates } });
    for (const platform of Object.keys(kept)) localStorage.removeItem(DESCRIPTION_TEMPLATE_PREFIX + platform);
  } catch (error) { console.warn("Moving description templates failed:", error.message); }
}

/** Save the user's presets, default descriptions and/or deleted built-ins in the local service and keep its answer. */
async function save_presets(input) {
  const result = await local_launch_request("presets", input);
  Object.assign(state.launch, { presets: result.presets, description_templates: result.description_templates,
    builtin_presets: result.builtin_presets || [], hidden_builtins: result.hidden_builtins || [] });
  publish_view();
}

// Expert presets: a named instance with its description, prompt and project access, added in one click.
// The user's own preset replaces a built-in one of the same name.
/** Every preset the add row offers: built-in ones first, then the user's. */
function expert_presets() {
  const own = new Set(state.launch.presets.map(preset => preset.name));
  return [...state.launch.builtin_presets.filter(preset => !own.has(preset.name)), ...state.launch.presets];
}

/** A free instance name from a base: Claude → Claude-2, Codex-review → Codex-review2. */
function unique_instance(base, taken) {
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base}${base.includes("-") ? "" : "-"}${number}`)) number++;
  return `${base}${base.includes("-") ? "" : "-"}${number}`;
}

/** Start an instance's card from its platform's software settings plus the preset's choices. */
function apply_expert_preset(name, preset) {
  const { session_id, system_prompt, ...base } = state.launch.profiles[platform_of(name)] || {};
  const profile = { ...structuredClone(base), project_access: full_only_hint(base.adapter) ? "full" : preset.project_access || "read" };
  for (const field of ["model", "effort", "system_prompt"]) if (Object.hasOwn(preset, field)) profile[field] = preset[field];
  state.launch.profiles[name] = profile;
  description_drafts[name] = preset.description || "";
  // A second copy of a preset keeps the number its instance name got: 评审官 → 评审官2.
  if (preset.label) label_drafts[name] = preset.label + name.slice(preset.name.length);
  // A workflow's card is built for that workflow alone and never updates a saved preset.
  if (expert_presets().includes(preset)) preset_origins[name] = preset.name;
  else delete preset_origins[name];
  publish_view();
}

/** The saved preset a card was added from, or "" for a card of its own. */
function preset_origin(name) {
  return preset_origins[name] || "";
}

/** Rename one card before the room or invitation is submitted; empty goes back to its default name. */
function write_label_draft(name, text) {
  if (text) label_drafts[name] = text;
  else delete label_drafts[name];
  publish_view();
}

/** The display name a card was given, empty when it shows its default. */
function label_draft(name) {
  return label_drafts[name] || "";
}

/** The name a draft card shows: its given label, else the platform's default. The open room's labels belong to
 * that room's members, not to a draft that happens to reuse one of their names. */
function member_label(name) {
  return label_drafts[name] || default_name(name);
}

/** The instance a preset of this platform is saved under for a free name: the name itself when it is already one, else platform-name. */
function preset_identity(name, label) {
  const platform = platform_of(name), text = label.trim();
  // A name typed with the platform's nickname (Gemini-1) maps to the platform's ID (Antigravity-1).
  const nickname = default_name(platform);
  const own = nickname !== platform && text.startsWith(`${nickname}-`) ? platform + text.slice(nickname.length) : text;
  if (platform_of(own) === platform) return own;
  // An ID keeps only English letters, digits and underscores; a Chinese name becomes the label of a numbered ID.
  const suffix = text.replace(/[^0-9A-Za-z_]/g, "").slice(0, 16);
  if (suffix && suffix !== platform) return `${platform}-${suffix}`;
  const taken = new Set(expert_presets().map(preset => preset.name));
  let number = 1;
  while (taken.has(`${platform}-preset${number}`)) number++;
  return `${platform}-preset${number}`;
}

/** Add a preset to the new-room draft under a free name. */
function add_preset_instance(container_id, preset, value) {
  const name = unique_instance(preset.name, new Set(Object.keys(read_expert_inputs(container_id))));
  apply_expert_preset(name, preset);
  write_view_expert(container_id, name, value);
  return name;
}

/** Save one card as the user's preset, under a new display label or, without one, updating the preset of its own name. */
async function save_expert_preset(name, label) {
  const profile = state.launch.profiles[name] || {};
  const id = label === undefined ? preset_origins[name] || name : preset_identity(name, label);
  const shown = label === undefined ? expert_presets().find(item => item.name === id)?.label || "" : label.trim();
  const preset = { name: id, ...shown && shown !== id ? { label: shown } : {}, description: description_draft(name).trim(), project_access: profile.project_access || "read" };
  // Model and effort are always kept, "" meaning the software's own default, so a card added from the preset never
  // takes whatever the platform's card was last set to.
  for (const field of ["model", "effort"]) preset[field] = profile[field] || "";
  if (Object.hasOwn(profile, "system_prompt") && profile.system_prompt !== "") preset.system_prompt = profile.system_prompt;
  try {
    await save_presets({ presets: [...state.launch.presets.filter(item => item.name !== id), preset] });
    show_toast(t('已存为预设「{value1}」', { value1: preset.label || id }));
    return true;
  } catch (error) { show_toast(t('预设未保存：{value1}', { value1: error.message }), true); return false; }
}

/** Remove the preset of this name from the add row: the user's own one, and a built-in one of the same name with it. */
async function delete_expert_preset(name) {
  const builtin = state.launch.builtin_presets.some(item => item.name === name);
  const shown = expert_presets().find(item => item.name === name)?.label || name;
  try {
    await save_presets({ presets: state.launch.presets.filter(item => item.name !== name),
      ...builtin ? { hidden_builtins: [...state.launch.hidden_builtins, name] } : {} });
    show_toast(t('已删除预设「{value1}」', { value1: shown }));
  } catch (error) { show_toast(t('预设未删除：{value1}', { value1: error.message }), true); }
}

/** The description a card currently shows: its own draft, else its platform's template. */
function description_draft(name) {
  return description_drafts[name] ?? description_template(name);
}

/** Start a fresh card without the name and description an earlier card of this name left behind. */
function clear_card_drafts(name) {
  delete description_drafts[name];
  delete label_drafts[name];
  delete preset_origins[name];
}

/** Change one card's description before the room or invitation is submitted. */
function write_description_draft(name, text) {
  description_drafts[name] = text;
  publish_view();
}

/** Save descriptions by member name with the room credential, else this browser's administrator authority; a failure leaves the room as created. */
async function send_descriptions(room_id, token, descriptions) {
  const filled = Object.fromEntries(Object.entries(descriptions).filter(([, text]) => text?.trim()));
  if (!room_id || !Object.keys(filled).length) return;
  try { await request_json(`/api/rooms/${room_id}/descriptions`, { descriptions: filled }, token); }
  catch (error) { notify("warning", t('成员描述未保存：{value1}，可在发言顺序的成员菜单里重新填写。', { value1: error.message })); }
}

/** Save display labels by member name with the room credential, else this browser's administrator authority; a failure leaves the members under their names. */
async function send_labels(room_id, token, labels) {
  const filled = Object.fromEntries(Object.entries(labels).filter(([, text]) => text?.trim()));
  if (!room_id || !Object.keys(filled).length) return;
  try { await request_json(`/api/rooms/${room_id}/labels`, { labels: filled }, token); }
  catch (error) { notify("warning", t('成员显示名未保存：{value1}，房间里按成员名显示。', { value1: error.message })); }
}

/** Save the new room's round limit with the room credential; a failure leaves the room on the default. */
async function send_chain_rounds(room_id, token, max_rounds) {
  if (!room_id || !token || max_rounds === DEFAULT_CHAIN_ROUNDS) return;
  try { await request_json(`/api/rooms/${room_id}/budget`, { max_rounds }, token); }
  catch (error) { notify("warning", t('推进轮数未保存：{value1}，房间沿用默认 {value2} 轮，可在房间页修改。', { value1: error.message, value2: DEFAULT_CHAIN_ROUNDS })); }
}

/**
 * Edit one member's description inside the room, and its display name when one is given (empty removes it); the next
 * decision by the scheduler or host uses the description, screens show the name.
 */
async function describe_member(name, text, label) {
  const room_id = state.room.id;
  try {
    // Without the room credential the website acts with this browser's administrator authority (the local site's visitors).
    const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
    await request_json(`/api/rooms/${room_id}/descriptions`, { descriptions: { [name]: text } }, token);
    if (label !== undefined) await request_json(`/api/rooms/${room_id}/labels`, { labels: { [name]: label } }, token);
    if (state.room?.id === room_id) await refresh_room();
  } catch (error) { notify("error", error.message); throw error; }
}

/** Change how many rounds the host may run from one owner message; chains still running follow the new value. */
async function set_chain_rounds(max_rounds) {
  const room_id = state.room.id;
  try {
    // Without the room credential the website acts with this browser's administrator authority (the local site's visitors).
    const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
    await request_json(`/api/rooms/${room_id}/budget`, { max_rounds }, token);
    if (state.room?.id === room_id) await refresh_room();
  } catch (error) { notify("error", error.message); throw error; }
}

/** Let a chain that stopped at its round limit run on for more rounds; the dispatch it held back goes out at once. */
async function continue_chain(chain_id, rounds) {
  const room_id = state.room.id;
  try {
    // Without the room credential the website acts with this browser's administrator authority (the local site's visitors).
    const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
    await request_json(`/api/rooms/${room_id}/chains/${chain_id}`, { action: "continue", rounds }, token);
    if (state.room?.id === room_id) await refresh_room();
  } catch (error) { notify("error", error.message); throw error; }
}

/** Allow operations a woken member's software refused; the local service passes the rules from its next run. */
async function allow_denials({ name, rules }) {
  const room_id = state.room.id;
  await local_launch_request("room-member-allow", { room_id, token: localStorage.getItem(`discuss-access:${room_id}`), name, rules });
}

/**
 * Save one choice of a woken member (project files, model and effort, App or CLI) on this computer. The page shows
 * the new choice at once and the save runs behind it; a refused save puts the old choice back and throws.
 * @param {string} command The local service's command.
 * @param {string} name The member.
 * @param {object} choice The changed fields of its saved profile, also sent as the command's payload.
 */
async function save_member_choice(command, name, choice) {
  const room_id = state.room.id;
  const saved = state.launch.room_models?.room_id === room_id ? state.launch.room_models : null;
  const before = saved?.participants?.[name];
  const show = (profile) => {
    if (!before || state.launch.room_models?.room_id !== room_id || !state.launch.room_models.participants?.[name]) return;
    state.launch.room_models.participants = { ...state.launch.room_models.participants, [name]: profile };
    publish_view();
  };
  show({ ...before, ...choice });
  try { await local_launch_request(command, { room_id, token: localStorage.getItem(`discuss-access:${room_id}`), name, ...choice }); }
  catch (error) { show(before); throw error; }
  if (state.room?.id !== room_id) return;
  // The saved choices are cached per runtime revision, which this change leaves alone; what is shown stays while they are read again.
  if (state.launch.room_models?.room_id === room_id) state.launch.room_models = { ...state.launch.room_models, revision: "", loading: false };
  await load_room_models();
}

/** Switch a woken member's project files between read-only and writable; the local service applies it from its next run. */
function set_member_access({ name, project_access }) {
  return save_member_choice("room-member-access", name, { project_access });
}

/** Change a woken CLI member's model and effort; the local service applies them from its next run and keeps its session. */
function set_member_model({ name, model, effort }) {
  return save_member_choice("room-member-model", name, { model, effort });
}

/** Switch an idle Codex member between the App and the CLI; its conversation stays. */
function set_member_adapter({ name, adapter }) {
  return save_member_choice("room-member-adapter", name, { adapter });
}

/** The open room as the page shows it: a member being removed is already gone while the site confirms. */
function shown_room() {
  const room = state.room;
  const removing = (room?.free?.members || room?.members || []).filter(member => state.removing_members.has(member.id)).map(member => member.name);
  if (!removing.length) return room;
  const kept = member => !state.removing_members.has(member.id);
  const named = name => !removing.includes(name);
  const order = room.speaking_order;
  const experts = room.experts && Object.fromEntries(Object.entries(room.experts).filter(([name]) => named(name)));
  return { ...room, experts, members: room.members?.filter(kept), free: room.free && { ...room.free, members: room.free.members?.filter(kept) },
    speaking_order: order && { ...order, items: order.items?.filter(item => named(item.name)), movable: order.movable?.filter(named), default: order.default?.filter(named) } };
}

/** Take a member off the page at once and save in the background; a refused removal brings the member back. */
async function remove_member(room_id, member_id) {
  state.removing_members.add(member_id);
  publish_view();
  try {
    await request_json(`/api/rooms/${room_id}/members/${member_id}`, { action: "remove" });
    if (state.room?.id === room_id) await refresh_room();
  } finally {
    state.removing_members.delete(member_id);
    publish_view();
  }
}

/** Owner changes use the website; only automatic members need the local service to reconnect. */
async function change_member({ member_id, name, action, role, latest_id, quiet = false }) {
  const room_id = state.room.id;
  if (action === "remove") return remove_member(room_id, member_id);
  if (action === "rejoin") {
    const member = (state.room.free?.members || state.room.members).find(item => item.id === member_id);
    const token = localStorage.getItem(`discuss-access:${room_id}`);
    const record = prepare_member_request(room_id, `rejoin:${member_id}`, { name, access: member.access });
    const result = member.access === "runner"
      ? await local_launch_request("room-member", { room_id, token, action: "rejoin", name, member_token: record.member.token })
      : await request_json(`/api/rooms/${room_id}/members/${member_id}`, { action: "active", token: record.member.token });
    finish_member_request(room_id, token, record, result);
    if (!quiet && state.room?.id === room_id) notify("info", member.access === "manual" ? t('{value1} 已请回，凭证已更新；请用新的启动指令让它重新注册。', { value1: name }) : t('{value1} 已请回，续接原会话。', { value1: name }));
  } else {
    const live = action === "interrupt" ? live_executions_of(member_id) : [];
    const previous_host = role === "host" ? (state.room.free?.members || state.room.members).find(item => item.role === "host" && item.id !== member_id) : null;
    await request_json(`/api/rooms/${room_id}/members/${member_id}${action === "interrupt" ? "/interrupt" : ""}`,
      action === "interrupt" ? {} : { action, ...(role ? { role } : {}), ...(latest_id !== undefined ? { latest_id } : {}) });
    warn_unstoppable(live);
    if (previous_host) await inherit_host_access(room_id, name, previous_host.name);
  }
  if (state.room?.id === room_id) await refresh_room();
}

/**
 * The new host takes over the previous host's project access as far as its own software goes; this computer decides
 * the level and the page says what changed. The host change itself is already saved, so a failure here is only reported.
 */
async function inherit_host_access(room_id, name, previous) {
  try {
    const result = await local_launch_request("room-member-access", { room_id, token: localStorage.getItem(`discuss-access:${room_id}`), name, inherit_from: previous });
    if (!result?.changed) return;
    if (state.launch.room_models?.room_id === room_id) state.launch.room_models = { ...state.launch.room_models, revision: "", loading: false };
    notify("info", t('{name} 接任主持人，项目权限已随原主持人改为“{level}”', { name, level: ACCESS_LABELS[result.project_access] || result.project_access }));
    if (state.room?.id === room_id) await load_room_models();
  } catch (error) {
    notify("warning", t('{name} 已设为主持人，但项目权限没有随原主持人调整：{reason}', { name, reason: error.message }));
  }
}

/** Reorder who has not spoken yet against the revision the board showed; a changed order is refused and the board reloads. */
async function reorder_speakers({ revision, order }) {
  const room_id = state.room.id;
  try { await request_json(`/api/rooms/${room_id}/speaking-order`, { revision, order }); }
  catch (error) {
    // A conflict means someone else's change landed first; the board reloads below, so ask for the move again (same text as the board's own notice).
    if (error.status === 409) notify("warning", t('发言顺序刚有变化，已更新为最新顺序，请重新调整'));
    else notify("error", error.message);
  }
  if (state.room?.id === room_id) await refresh_room();
}

/** Invite an independent member, retaining its credential before either delivery path runs. */
async function invite_member({ name, access, project_access = "read", session_id = "", card = "", workflow_members = null, refresh = true }) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  const taken = new Set((state.room.free?.members || state.room.members || []).map(member => member.name));
  const instance = unique_instance(name, taken);
  const adapter = (state.launch.profiles[name] || state.launch.profiles[platform_of(name)])?.adapter;
  const record = prepare_member_request(room_id, `add:${name}:${access}`, { name: instance, access, adapter: "", session_mode: "new" },
    { project_access: full_only_hint(adapter) ? "full" : project_access, session_id: session_id.trim() });
  let result;
  if (access === "runner") {
    const draft = launch_options();
    const participants = { ...draft.participants, [record.member.name]: { ...draft.participants?.[name],
      ...draft.participants?.[record.member.name], project_access: record.options?.project_access || "read",
      // An existing conversation joins with its own context; the runner resumes it instead of starting a new one.
      ...(record.options?.session_id ? { session_id: record.options.session_id } : {}) } };
    result = await local_launch_request("room-member", { room_id, token, action: "add", name: record.member.name, access,
      member_token: record.member.token, participants, cwd: draft.cwd });
  } else result = await request_json(`/api/rooms/${room_id}/members`, record.member);
  // A name a removed member once used stays bound locally, so the local service may admit this one under the next free name.
  if (typeof result.member === "string" && result.member !== record.member.name) record.member = { ...record.member, name: result.member };
  finish_member_request(room_id, token, record, result);
  if (card && workflow_members) workflow_members[card] = record.member.name;
  // The admission answer carries the new roster, so the next invitation in a batch names its instance without a full reload.
  if (state.room?.id === room_id && result.free?.members && state.room.free) state.room.free = result.free;
  await Promise.all([send_descriptions(room_id, token, { [record.member.name]: description_draft(name) }),
    send_labels(room_id, token, { [record.member.name]: label_drafts[name] })]);
  delete description_drafts[name];
  delete label_drafts[name];
  if (state.room?.id === room_id) {
    // A manual member's start step lives on the board row, the composer bar and the invite dialog; no extra notice.
    const notice = access === "manual" ? ""
        : record.options?.session_id && window.discuss_backup.adapter_profile(adapter)?.copy_bound
          ? t('{value1} 已加入，在原会话的分叉上工作；原会话里看不到房间里的后续记录。', { value1: record.member.name })
        : record.options?.session_id ? t('{value1} 已接入原会话；它工作时请不要在原窗口继续操作。', { value1: record.member.name })
        : t('{value1} 已加入，之后点名它即会由本机服务唤醒。', { value1: record.member.name });
    if (notice) notify("info", notice);
    if (refresh) await refresh_room();
  }
}

/** Clear only the composer that produced the saved message. */
async function finish_message(result, job) {
  const { room_id } = job;
  if (state.room?.id !== room_id) {
    show_toast(t('发往「{room}」的留言已保存 · #{id}', { room: job.room_title, id: result.message.id }));
    return;
  }
  show_toast(t('留言已保存 · #{value1}', { value1: result.message.id }));
  state.query = "";
  state.mention_only = false;
  state.host_only = false;
  state.authors = [];
  state.card_kinds = [];
  element("search-input").value = "";
  element("mention-filter").setAttribute("aria-pressed", "false");
  state.page = 1;
  // The sending card stays, now showing the saved number, until the room is read again: the saved card then takes its
  // place in the same render as the room's other changes (its request, the host's working card). Swapping it in first
  // and the rest a moment later laid the transcript out twice, and on a phone the page jumped and flashed in between.
  const saved_id = result.message.id;
  job.queueing = null;
  job.preview = { ...job.preview, saved_id };
  publish_view();
  await refresh_room().catch(() => {});
  if (state.room?.id === room_id && !state.messages.some(message => message.id === saved_id)) {
    const messages = [...state.messages, { ...result.message, just_sent: true }].sort((a, b) => a.id - b.id);
    render_messages({ messages, total: state.message_total + 1, page: 1, pages: 1 });
  }
}

/** Move the local sending card to the room's queue once the site confirms it. */
async function finish_queued(result, room_id) {
  if (state.room?.id !== room_id) return;
  if (state.room.free) state.room = { ...state.room, free: { ...state.room.free, queued_messages: result.queue } };
  run_action(refresh_room);
}

/** Act on the room's queued owner messages; the site posts what may go and returns the queue. */
async function queue_request(payload) {
  const room_id = state.room.id;
  let queue;
  try { queue = await request_json(`/api/rooms/${room_id}/queue`, payload); }
  catch (error) {
    // A refused action usually means the queue moved on (a message went out meanwhile); show what is queued now.
    if (state.room?.id === room_id) await refresh_room().catch(() => {});
    throw error;
  }
  if (state.room?.id === room_id && state.room.free) state.room = { ...state.room, free: { ...state.room.free, queued_messages: queue } };
  publish_view();
  if (state.room?.id === room_id) await refresh_room();
}

/** Answer or cancel one question (`operation`: answer | cancel) with the version the card shows; the room refreshes either way. */
async function question_request({ id, operation, body }) {
  const room_id = state.room.id;
  try { await request_json(`/api/rooms/${room_id}/questions/${id}/${operation}`, body); }
  finally { if (state.room?.id === room_id) await refresh_room().catch(() => {}); }
}

/** Put text, files and the reply (`{ id, label }` or null) in the composer as they are given. */
function fill_composer(text, drafts, reply) {
  cancel_reply();
  if (reply) {
    state.reply_to = reply.id;
    element("reply-label").textContent = reply.label;
    element("reply-preview").hidden = false;
  }
  state.attachment_drafts = drafts;
  element("message-input").value = text;
  element("message-input").dispatchEvent(new Event("input", { bubbles: true }));
  render_attachment_drafts();
}

/** Read a queued message's files for the composer; its row says so meanwhile and the message stays queued. */
async function read_queued_files(item, room_id) {
  state.queue_reading = item.id;
  publish_view();
  try {
    return await Promise.all(item.attachments.map(async (file) => {
      const bytes = await read_room_file(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(file.id)}/content`);
      return { id: file.id, file: new File([bytes], file.file_name, { type: file.content_type || "" }) };
    }));
  } finally { state.queue_reading = 0; }
}

/** Put a queued message in the composer, stashing a draft already there; returns what a failed removal has to undo. */
function take_into_composer(item, files) {
  const typed = element("message-input").value;
  let stash = null;
  if (typed.trim() || state.attachment_drafts.length) {
    const reply = state.reply_to ? { id: state.reply_to, label: element("reply-label").textContent } : null;
    stash = { text: typed, drafts: state.attachment_drafts, reply };
    state.stashed_drafts.push(stash);
    notify("info", t('输入框原有草稿已暂存，这条发出后恢复'));
  }
  const drafts = files.map(({ id, file }, index) => {
    const draft = { id: new_submission_id(), file, preview_url: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "", uploaded: id, actor: "用户" };
    const placeholder = draft_placeholder(draft, index + 1);
    if (item.text.includes(placeholder)) draft.placeholder = placeholder;
    return draft;
  });
  fill_composer(item.text, drafts, null);
  return { drafts, count: drafts.length, stash };
}

/**
 * The site refused or lost the removal of a message already in the composer. The composer only gives it back once the
 * site confirms the message is still queued and nothing was changed; in every other case the text stays where it is.
 */
async function recover_taken_queued(item, room_id, taken, error) {
  if (state.room?.id !== room_id) { notify("warning", t('未能确认这条排队消息的状态，内容已保留在输入框，请确认未发出后再发送')); return; }
  let confirmed = true;
  await refresh_room().catch(() => { confirmed = false; });
  const queued = confirmed && state.room?.free?.queued_messages?.items?.some(entry => entry.id === item.id);
  const untouched = element("message-input").value === item.text && state.attachment_drafts === taken.drafts && taken.drafts.length === taken.count;
  if (queued && untouched) {
    release_files(taken.drafts);
    state.stashed_drafts = state.stashed_drafts.filter(entry => entry !== taken.stash);
    fill_composer(taken.stash?.text ?? "", taken.stash?.drafts ?? [], taken.stash?.reply ?? null);
    notify("error", t('未能编辑，消息仍在排队：{value1}', { value1: error.message }));
  } else if (queued) notify("warning", t('消息仍在排队，输入框里是副本，发送前请先删除排队中的原消息'));
  else notify("warning", t('未能确认这条排队消息的状态，内容已保留在输入框，请确认未发出后再发送'));
}

/** Remove a message from the queue behind the composer that already shows it; its row stays hidden until the site agrees. */
async function finish_taking_queued(item, room_id, taken) {
  try {
    const queue = await request_json(`/api/rooms/${room_id}/queue`, { action: "delete", id: item.id });
    if (state.room?.id === room_id && state.room.free) state.room = { ...state.room, free: { ...state.room.free, queued_messages: queue } };
    publish_view();
    if (state.room?.id === room_id) await refresh_room().catch(() => {});
  } catch (error) {
    await recover_taken_queued(item, room_id, taken, error);
  } finally {
    state.queue_taking.delete(item.id);
    publish_view();
  }
}

/**
 * Take a queued message off the queue and put it in the composer: the owner rewrites it and sends it as a new message.
 * The row and the composer change in one step, before the site is asked, so the message is on screen at every moment
 * (user 2026-11-18, #4536). A draft already in the composer is stashed and comes back once the next message leaves the
 * composer (like Claude Code's Ctrl+S). Its files come back as already uploaded drafts; they are read first, so a failed
 * read leaves the message queued.
 */
async function edit_queued(item) {
  const room_id = state.room.id;
  const files = item.attachments.length ? await read_queued_files(item, room_id) : [];
  if (state.room?.id !== room_id) return;
  if (!state.room.free?.queued_messages?.items?.some(entry => entry.id === item.id)) throw new Error(t('这条排队消息已发出或已删除'));
  const taken = take_into_composer(item, files);
  state.queue_taking.add(item.id);
  state.queued_taken = (state.queued_taken || 0) + 1;
  publish_view();
  finish_taking_queued(item, room_id, taken);
}

/** Send what the composer holds; once it has left the composer, the draft stashed by editing a queued message comes back. */
function send_from_composer(event) {
  const sending = send_message(event);
  if (state.stashed_drafts.length && !element("message-input").value && !state.attachment_drafts.length) {
    const stashed = state.stashed_drafts.pop();
    fill_composer(stashed.text, stashed.drafts, stashed.reply);
    publish_view();
  }
  return sending;
}

async function delete_queued(id) {
  await queue_request({ action: "delete", id });
}

/**
 * Send a queued message now. The row leaves the tray at once (QueuedMessages hides it) and the message shows as a
 * sending card until the refreshed transcript carries it; a refusal brings the row back with the reason.
 */
async function send_queued(id) {
  const item = state.room?.free?.queued_messages?.items?.find(entry => entry.id === id);
  const preview = item && !state.sending_preview
    ? { author: "用户", text: item.text, created_at: new Date().toISOString(), files: item.attachments.map(file => ({ name: file.file_name })) } : null;
  if (preview) { state.sending_preview = preview; publish_view(); }
  try { await queue_request({ action: "send", id }); }
  finally { if (preview && state.sending_preview === preview) { state.sending_preview = null; publish_view(); } }
}

// The unsaved submissions of this page, in click order, including the one on its way to the site.
const send_queue = [];

/** Cards belonging to the open room, until its saved messages replace them. */
function room_sending_previews() {
  const cards = send_queue.filter(job => job.room_id === state.room?.id && !job.queueing && !job.queued && !job.preview.failed
    && !(job.preview.saved_id && state.messages.some(message => message.id === job.preview.saved_id)))
    .map(job => job.preview);
  if (state.sending_preview) cards.push(state.sending_preview);
  return cards;
}

/** Predict the server's queue decision using the recipients and the room's current work. */
function predicted_queue(payload, queue) {
  if (!payload.queue || !queue) return null;
  const items = queue.items || [];
  const waits = name => queue.busy_members?.includes(name) || items.some(item => item.to?.includes(name));
  const side = payload.to?.length && !payload.sequential && payload.order !== "auto";
  const likely = side ? payload.to.every(waits) : queue.busy || items.length;
  return likely ? { queued_ids: items.map(item => item.id) } : null;
}

/** A pushed queue row can arrive before the POST receipt; only the in-flight local row can be its duplicate. */
function room_queueing_previews() {
  const items = state.room?.free?.queued_messages?.items || [];
  return send_queue.filter(job => job.room_id === state.room?.id && job.queueing && !job.queued && !job.preview.failed
    && (job.preview.waiting || !items.some(item => !job.queueing.queued_ids.includes(item.id))))
    .map(job => job.preview);
}

/** Capture the room, contents and receipt before releasing the composer for the next message. */
async function send_message(event) {
  event.preventDefault();
  if (!state.room) return;
  const drafts = state.attachment_drafts, payload = message_payload();
  if (!payload.text && !drafts.length) return;
  const id = new_submission_id();
  payload.submission_id = id;
  const preview = { id, author: payload.author, text: payload.text, created_at: new Date().toISOString(), attachment_start: draft_start(drafts) || 1,
    files: drafts.map(file => ({ id: file.id, name: file.file.name, preview_url: file.preview_url, uploaded: Boolean(file.uploaded) })) };
  const job = { id, room_id: state.room.id, room_title: state.room.title || state.room.id, drafts, payload, preview };
  element("message-input").value = "";
  state.attachment_drafts = [];
  cancel_reply();
  render_attachment_drafts();
  return enqueue_send(job);
}

/** Start after the preceding submission settles, even if it failed. */
function enqueue_send(job) {
  const previous = send_queue.at(-1)?.submitted || Promise.resolve();
  job.submitted = new Promise(resolve => { job.finish_submission = resolve; });
  job.queueing = predicted_queue(job.payload, state.room.free?.queued_messages);
  job.preview = { ...job.preview, waiting: true };
  send_queue.push(job);
  job.done = previous.then(() => deliver_send(job)).finally(() => {
    job.finish_submission();
    send_queue.splice(send_queue.indexOf(job), 1);
    publish_view();
  });
  publish_view();
  return job.done;
}

async function deliver_send(job) {
  const { room_id, drafts, payload } = job;
  if (job.queueing && state.room?.id === room_id) {
    job.queueing.queued_ids = (state.room.free?.queued_messages?.items || []).map(item => item.id);
  }
  job.preview = { ...job.preview, waiting: false };
  publish_view();
  let saved = false;
  const deliver = async () => {
    payload.attachment_ids = await upload_message_attachments(room_id, payload.submitted_by, drafts);
    if (draft_start(drafts)) payload.attachment_start = draft_start(drafts);
    // The saved card shows these files from this browser's own copy rather than reading them back through the relay.
    for (const item of drafts) {
      const path = `/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(item.uploaded)}/content`;
      if (!relay_files.has(path)) relay_files.set(path, Promise.resolve(URL.createObjectURL(item.file)));
    }
    return request_json(`/api/rooms/${room_id}/messages`, payload);
  };
  try {
    let result;
    for (let attempt = 0; ; attempt += 1) {
      try { result = await deliver(); break; }
      catch (error) {
        // Only a failure of the network is tried again (unconfirmed, the computer briefly away, a dropped or timed-out
        // request); a refusal by the site would be refused again.
        const network = error.unconfirmed || error.offline || ["TypeError", "AbortError", "TimeoutError"].includes(error.name);
        if (!network || attempt >= SEND_RETRY_MS.length) throw error;
        job.preview = { ...job.preview, retrying: attempt + 1 };
        publish_view();
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS[attempt]));
      }
    }
    saved = true;
    job.finish_submission();
    // The sender's room rises as soon as the message is saved, without waiting for the next directory read.
    if (result.message?.created_at) patch_directory_room(room_id, { latest_speech_at: result.message.created_at });
    if (result.queued) {
      job.queued = true;
      await finish_queued(result, room_id);
    }
    else await finish_message(result, job);
  } catch (error) {
    if (saved) notify_failure(error, t('留言已保存，但页面刷新失败：{value1}', { value1: error.message }));
    else {
      job.preview = { ...job.preview, failed: error.message };
      state.failed_sends = [...state.failed_sends, job];
      if (state.room?.id !== room_id) notify("error", t('发往「{room}」的消息未发出，回到该房间可重新发送', { room: job.room_title }));
      error.notified = true;
    }
    throw error;
  } finally {
    if (saved) release_files(drafts);
    if (state.room?.id === room_id) state.upload_status = "";
  }
}

/** Let go of the local previews of files no card shows any more. */
function release_files(drafts) {
  for (const file of drafts) if (file.preview_url) URL.revokeObjectURL(file.preview_url);
}

/**
 * Send a failed card's message again, as it was, with the same submission (so a send that did reach the site is not
 * saved twice); whatever is in the composer now stays there. Failed cards are this page's own and any number may wait.
 */
async function retry_sending(id) {
  const failed = state.failed_sends.find((item) => item.id === id);
  if (!failed || state.room?.id !== failed.room_id) return;
  state.failed_sends = state.failed_sends.filter((item) => item !== failed);
  return enqueue_send({ ...failed, preview: { ...failed.preview, failed: "", retrying: 0 } });
}

/** Drop a failed card and the message it held. */
function discard_sending(id) {
  const failed = state.failed_sends.find((item) => item.id === id);
  if (!failed || state.room?.id !== failed.room_id) return;
  release_files(failed.drafts);
  // Files of a send the site never saved are taken back; one it did save refuses, and stays with its message.
  failed.drafts.forEach(discard_draft_upload);
  state.failed_sends = state.failed_sends.filter((item) => item !== failed);
}

/** Format sizes for the file cards and composer. */
function attachment_size(size) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}

// Attachments opened in the file preview window: Markdown and HTML rendered, CSV/TSV as tables, subtitles as a
// timeline, Office documents in their previews, a Premiere project unpacked to its XML, the rest as source.
const TEXT_ATTACHMENT = /\.(md|markdown|txt|log|csv|tsv|json|jsonc|ya?ml|toml|ini|xml|html?|css|vue|[cm]?js|jsx|tsx?|py|sql|sh|ps1|bat|srt|vtt|ass|ssa|lrc|fcpxml|kdenlive|mlt|otio|edl|docx|xlsx|xls|ods|pptx|prproj)$/i;

/** Whether an attachment opens in the file preview window. */
function is_text_attachment(file) {
  return TEXT_ATTACHMENT.test(file.file_name);
}

// What a file is, by extension, so an attachment is shown as a known kind rather than a bare file: [label, icon tone].
// Mirrors FILE_TYPES in frontend/file-preview.js, which this classic script cannot import.
const ATTACHMENT_KINDS = [
  [/^(docx?|rtf|odt)$/, t('文档'), "blue"], [/^(xlsx?|ods|csv|tsv)$/, t('表格'), "green"], [/^(pptx?|odp|key)$/, t('演示文稿'), "orange"],
  [/^pdf$/, "PDF", "red"], [/^(mp4|m4v|webm|mov|mkv|avi|wmv|flv|ogv|mts|m2ts|3gp)$/, t('视频'), "purple"],
  [/^(mp3|wav|ogg|oga|opus|m4a|aac|flac|aiff?|wma)$/, t('音频'), "purple"], [/^(srt|vtt|ass|ssa|lrc|sub|sbv)$/, t('字幕'), "purple"],
  [/^(prproj|fcpxml|fcpbundle|kdenlive|mlt|otio|edl|aep|aepx|drp|veg|imovieproj)$/, t('剪辑工程'), "purple"],
  [/^(json|jsonc|ya?ml|toml|ini|xml|env)$/, t('配置数据'), "gray"], [/^(md|markdown|txt|log)$/, t('文本'), "blue"],
  [/^(html?|css|vue|[cm]?js|jsx|tsx?|py|sql|sh|ps1|bat)$/, t('代码'), "gray"], [/^(zip|rar|7z|tar|gz|tgz)$/, t('压缩包'), "gray"],
];

/** `[label, tone]` of a file's kind, or a plain file for an extension not listed. */
function attachment_kind(file_name) {
  const extension = String(file_name).match(/\.([a-z0-9]{1,12})$/i)?.[1].toLowerCase() || "";
  const kind = ATTACHMENT_KINDS.find(([pattern]) => pattern.test(extension));
  return kind ? [kind[1], kind[2]] : [t('文件'), "blue"];
}

/** Render a file-shaped type badge; the extension is a label, not a preview capability. */
function attachment_file_icon(file_name) {
  const extension = String(file_name).match(/\.([a-z0-9]{1,12})$/i)?.[1].toUpperCase().slice(0, 5) || "FILE";
  const tone = attachment_kind(file_name)[1];
  return `<span class="attachment-file-icon" data-tone="${tone}" aria-hidden="true">
    <svg viewBox="0 0 36 44" fill="none"><path d="M4 0h19l13 13v27a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4Z" fill="currentColor"/><path d="M23 0v9a4 4 0 0 0 4 4h9" fill="#fff" fill-opacity=".3"/></svg>
    <span>${extension}</span></span>`;
}

/**
 * Keep original files in memory until sending; reject an invalid selection as a whole. Each file also puts its
 * placeholder (`[图片 #n]` / `[文件 #n]`, n its position) into the text where it was pasted or dropped, or at the caret the
 * file picker was opened from, else at the end,
 * as Claude Code does with a pasted screenshot: the text says where each file belongs, and members read it the same way.
 */
function add_attachments(files, target = null) {
  // Without a room the welcome page's composer collects them for the room its first message creates.
  if (state.room?.archived) return;
  const selected = Array.from(files);
  if (state.attachment_drafts.length + selected.length > MAX_MESSAGE_ATTACHMENTS) notify("warning", t('每条消息最多 10 个附件'));
  else if (selected.some(file => file.size > MAX_ATTACHMENT_BYTES && !can_compress_video(file))) notify("warning", t('单个附件最多 20 MiB'));
  else {
    const added = selected.map(file => ({ id: new_submission_id(), file,
      preview_url: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "", uploaded: null, actor: null }));
    state.attachment_drafts.push(...added);
    // Files already in the draft move to the room's current numbers first, so the whole draft counts from one start.
    renumber_placeholders(null);
    added.forEach(item => { item.placeholder = draft_placeholder(item, state.attachment_drafts.indexOf(item) + 1); });
    insert_placeholders(added.map(item => item.placeholder).join(" "), target);
    preupload_drafts(added);
  }
  render_attachment_drafts();
  publish_view();
}

// The composer's textarea the file picker was opened from: its files' placeholders go where its caret was.
let attachment_target = null;

/** Open the file picker; `target` is the textarea whose caret takes the chosen files' placeholders. */
function choose_attachments(target = null) {
  attachment_target = target;
  element("attachment-input").click();
}

/**
 * `[图片 #n]` for an image the page previews, `[文件 #n]` for any other file. Files are numbered across the room, as
 * Claude Code numbers pasted images across a conversation: the `position`-th file of this draft takes the room's next
 * number plus its place. The site moves the numbers on if another message took them first (`attachment_start`).
 */
function draft_placeholder(item, position) {
  return `[${item.preview_url ? "图片" : "文件"} #${attachment_base() + position - 1}]`;
}

/** The room-wide number the first file of the draft takes; 1 before a room exists. */
function attachment_base() {
  return state.room?.next_attachment_number || 1;
}

/** The number the draft's first placeholder carries, which the site counts from when it saves the message. */
function draft_start(drafts) {
  const number = Number(/#(\d+)\]$/.exec(drafts[0]?.placeholder || "")?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Put placeholders at the caret of the textarea the files came through, else at the end of the message text. */
function insert_placeholders(text, target) {
  const editor = target?.closest?.("textarea");
  if (editor) {
    const start = editor.selectionStart, end = editor.selectionEnd;
    const lead = start > 0 && !/\s$/.test(editor.value.slice(0, start)) ? " " : "";
    editor.setRangeText(`${lead}${text} `, start, end, "end");
    // The textarea's own listeners (Vue's v-model, or the classic page) take the change as typing.
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    if (editor !== element("message-input")) return;
  }
  const input = element("message-input");
  if (editor) return;
  // Trailing spaces give way to the separating space; a trailing line break is the user's own and stays.
  const base = input.value.replace(/[ \t]+$/, "");
  input.value = `${base}${base && !base.endsWith("\n") ? " " : ""}${text} `;
}

/** Deleting a file's placeholder while typing removes that file, as in Claude Code's own prompt; true when one went. */
function drop_unreferenced_attachments(text) {
  const gone = state.attachment_drafts.filter(item => item.placeholder && !String(text).includes(item.placeholder));
  if (!gone.length) return false;
  // The composer removes a token whole; an edit it could not intercept (an input method) may leave half of one behind.
  let cleaned = String(text);
  for (const { placeholder } of gone) {
    const escaped = placeholder.replace(/[[\]]/g, "\\$&");
    // `[图片 #1` not followed by a digit (that would be `#10`), or `图片 #1]` not preceded by `[`.
    cleaned = cleaned.replace(new RegExp(`${escaped.slice(0, -2)}(?![\\d\\]])|(?<!\\[)${escaped.slice(2)}`), "");
  }
  if (cleaned !== text) write_view_field("message-input", cleaned, { publish: false });
  remove_attachment(gone.map(item => item.id));
  return true;
}

/** Drop one file's placeholder from the text and renumber the rest, so `#n` always names the n-th file. */
function renumber_placeholders(removed) {
  const input = element("message-input");
  let text = removed ? input.value.replace(new RegExp(`${removed.placeholder.replace(/[[\]]/g, "\\$&")} ?`), "") : input.value;
  const changed = state.attachment_drafts.map((item, index) => ({ item, next: draft_placeholder(item, index + 1) }))
    .filter(({ item, next }) => item.placeholder && item.placeholder !== next);
  // Two passes, so `#2 → #1` cannot be taken for a `#1` that is itself about to move.
  changed.forEach(({ item }, index) => { text = text.split(item.placeholder).join(`\u0000${index}\u0000`); });
  changed.forEach(({ item, next }, index) => { text = text.split(`\u0000${index}\u0000`).join(next); item.placeholder = next; });
  if (text !== input.value) write_view_field("message-input", text, { publish: false });
}

/** Release local previews when a draft is sent or its room is left. */
function clear_attachment_drafts() {
  for (const file of state.attachment_drafts) if (file.preview_url) URL.revokeObjectURL(file.preview_url);
  state.attachment_drafts = [];
  render_attachment_drafts();
}

/** Remove unsent files (one ID, or several when their placeholders were deleted from the text) and their placeholders. */
function remove_attachment(ids) {
  for (const id of [ids].flat()) {
    const file = state.attachment_drafts.find(item => item.id === id);
    if (!file) continue;
    if (file.preview_url) URL.revokeObjectURL(file.preview_url);
    state.attachment_drafts = state.attachment_drafts.filter(item => item !== file);
    discard_draft_upload(file);
    renumber_placeholders(file);
  }
  render_attachment_drafts();
  publish_view();
}

/** Display shared file drafts and upload progress in the classic theme. */
function render_attachment_drafts() {
  const container = element("attachment-drafts");
  if (!container) return;
  container.innerHTML = state.attachment_drafts.map(item => `<div class="attachment-draft">${item.preview_url ? `<img src="${item.preview_url}" alt="">` : ""}
    <span>${escape_html(item.file.name)}<small>${attachment_size(item.file.size)}</small></span>
    <button type="button" data-remove-attachment="${item.id}" aria-label="${escape_html(t("移除 {name}", { name: item.file.name }))}">×</button></div>`).join("");
  element("attachment-status").textContent = state.upload_status;
}

/** Whether this browser can try to shrink this file. */
function can_compress_video(file) {
  return Boolean(file.type?.startsWith("video/")) && file.size <= VIDEO_COMPRESS_MAX_BYTES && typeof VideoEncoder === "function" && typeof VideoDecoder === "function";
}

/** A video is shrunk when the relay has to carry it, or when the site would not take it as it is. */
function wants_compression(file) {
  return can_compress_video(file) && (file.size > MAX_ATTACHMENT_BYTES || (state.remote_rooms && file.size >= VIDEO_COMPRESS_MIN_BYTES));
}

/** The compression module, loaded only when a video needs it. */
function load_video_compressor() {
  return import("/video-compress.js");
}

/**
 * Replace a draft video with a smaller copy. Compression is an optimisation: whatever goes wrong, a video the site can
 * take goes up as it is; only one too large for the site stops here.
 */
async function compress_draft(item) {
  const original = item.file;
  item.compression = new AbortController();
  report_upload_percent(item, 0, "compress");
  let compressed = null;
  try {
    const { compress_video } = await load_video_compressor();
    compressed = await compress_video(original, { max_bytes: MAX_ATTACHMENT_BYTES, signal: item.compression.signal,
      on_progress: (share) => report_upload_percent(item, Math.min(UPLOAD_PERCENT_BEFORE_SAVED, Math.floor(share * 100)), "compress") });
  } catch (error) { console.warn("video compression failed", error); }
  report_upload_percent(item, state.remote_rooms ? 0 : null);
  if (compressed) {
    item.file = compressed;
    render_attachment_drafts();
    publish_view();
  } else if (original.size > MAX_ATTACHMENT_BYTES && !item.removed) {
    throw Object.assign(new Error(t('这段视频无法压缩到 20 MiB 以内，请剪短后再发')), { video_too_large: true });
  }
}

/** Shrink a draft video once, before its first upload; a try that failed is made again when it is sent. */
async function prepare_draft_file(item) {
  if (item.prepared || !wants_compression(item.file)) return;
  item.preparing ??= compress_draft(item).finally(() => { item.preparing = null; });
  await item.preparing;
  item.prepared = true;
}

/** Upload one draft file as `actor`; an earlier upload under another actor is replaced by a fresh submission. */
async function upload_draft(room_id, actor, item) {
  await prepare_draft_file(item);
  // Taken out of the composer while it was compressing: nothing goes up.
  if (item.removed) return;
  item.upload_submission ??= item.id;
  if (item.actor && item.actor !== actor) { item.upload_submission = new_submission_id(); item.uploaded = null; }
  item.actor = actor;
  item.room_id = room_id;
  const params = new URLSearchParams({ file_name: item.file.name, actor, submission_id: item.upload_submission });
  // 100% is kept for the site having the file: every part can be in while the computer is still handing it over.
  const result = await post_room_file(`/api/rooms/${room_id}/attachments?${params}`, item.file, localStorage.getItem(`discuss-access:${room_id}`),
    (share) => report_upload_percent(item, Math.min(UPLOAD_PERCENT_BEFORE_SAVED, Math.floor(share * 100))))
    .catch((error) => { report_upload_percent(item, null); throw error; });
  item.uploaded = result.attachment.id;
  if (item.upload_percent != null) report_upload_percent(item, 100);
}

/**
 * Tell the cards showing it how far one draft file has come in `phase` ("compress" or "upload"): a whole percent, or null
 * when nothing is measured (a direct upload to this website reports none). It goes to them alone: a snapshot of the
 * whole view for every part would redraw the room while the reader scrolls.
 */
function report_upload_percent(item, percent, phase = "upload") {
  if ((item.upload_percent ?? null) === percent && (percent === null || item.upload_phase === phase)) return;
  item.upload_percent = percent;
  item.upload_phase = phase;
  document.dispatchEvent(new CustomEvent("discuss:upload-percent", { detail: { id: item.id, percent, phase } }));
}

/** How far a draft file in the composer or being sent has come; its percent is null when none is measured. */
function upload_progress(id) {
  const item = [...state.attachment_drafts, ...send_queue.flatMap(job => job.drafts)].find(draft => draft.id === id);
  return { percent: item?.upload_percent ?? null, phase: item?.upload_phase ?? "upload" };
}

/**
 * Start uploading files as soon as they are in the composer, one after another, so sending has only the text left to
 * post. A failure here stays silent, as sending uploads the file again and reports there, except a video that cannot be
 * made small enough, which the sender should hear about before writing the message. The welcome page has no room yet.
 */
let preupload_chain = Promise.resolve();
function preupload_drafts(items) {
  const room = state.room;
  if (!room || room.archived) return;
  for (const item of items) {
    item.uploading = preupload_chain = preupload_chain.then(() => item.removed || item.uploaded ? null : upload_draft(room.id, "用户", item))
      .catch((error) => { if (error.video_too_large) notify("warning", error.message); })
      .finally(() => { item.uploading = null; if (item.removed) discard_draft_upload(item); });
  }
}

/** Take back a removed file uploaded ahead of sending; files never sent are also cleared by the site after a day. */
function discard_draft_upload(item) {
  item.removed = true;
  item.compression?.abort();
  if (item.uploading || !item.uploaded || !item.room_id) return;
  const path = `/api/rooms/${encodeURIComponent(item.room_id)}/attachments/${encodeURIComponent(item.uploaded)}/discard`;
  item.uploaded = null;
  request_json(path, {}).catch(() => null);
}

/** Upload once per actual uploader, retaining receipts across ambiguous send failures. */
async function upload_message_attachments(room_id, actor, drafts) {
  const identifiers = [];
  for (const [index, item] of drafts.entries()) {
    // A file still uploading from the composer finishes first, so it is not sent twice.
    if (item.uploading) await item.uploading;
    if (!item.uploaded || item.actor !== actor) {
      if (state.room?.id === room_id) state.upload_status = t('正在上传 {value1}/{value2} · {value3}', { value1: index + 1, value2: drafts.length, value3: item.file.name });
      render_attachment_drafts();
      publish_view();
      await upload_draft(room_id, actor, item);
    }
    identifiers.push(item.uploaded);
    // The sending card (or the queue tray's row) shows each file as uploading until it is in; its status says what is left.
    const job = send_queue.find(job => job.drafts === drafts);
    if (job && !job.preview.files[index].uploaded) {
      job.preview.files[index].uploaded = true;
      job.preview = { ...job.preview, files: [...job.preview.files] };
      publish_view();
    }
  }
  return identifiers;
}

/** Intercept only actual file drops; ordinary text dragging keeps its default behavior. */
function drop_attachments(event) {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  if (event.type === "drop") add_attachments(event.dataTransfer.files, event.target);
}

/** Paste screenshots without replacing normal clipboard text handling. */
function paste_attachments(event) {
  const files = Array.from(event.clipboardData?.files || []);
  if (!files.length) return;
  event.preventDefault();
  add_attachments(files, event.target);
}

/** What a preview button carries, so the preview opens at once instead of first asking the site about the file. */
function attachment_preview_attributes(file) {
  const name = escape_html(file.file_name);
  return `data-preview-attachment="${escape_html(file.id)}" data-attachment-room="${escape_html(file.room_id)}" data-file-name="${name}" data-content-type="${escape_html(file.content_type)}" data-file-size="${Number(file.size) || 0}" data-created-at="${escape_html(file.created_at || "")}" data-message-id="${Number(file.message_id) || 0}" aria-label="${escape_html(t("预览 {name}", { name: file.file_name }))}"`;
}

/** A download link's attributes; files of the computer's rooms are read through the relay. */
function attachment_download_link(file) {
  const url = `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
  return files_by_blob() ? { href: "#", "data-relay-href": url, "data-file-name": file.file_name } : { href: `${url}?download=1` };
}

function attachment_download_attributes(file) {
  return Object.entries(attachment_download_link(file)).map(([key, value]) => `${key}="${escape_html(value)}"`).join(" ");
}

/**
 * Turn `[图片 #n]` / `[文件 #n]` in a rendered message into a link to its n-th attachment: a preview for what the page
 * can show, a download for the rest. Text outside the attachment count stays as written.
 */
function link_attachment_placeholders(html, files = []) {
  // A share page made without its attachments says so, rather than showing a tag that looks like it should open.
  const omitted = (kind, number) => `<span class="attachment-placeholder is-omitted" title="${escape_html(t("分享时未包含附件"))}">${escape_html(kind === "图片"
    ? t("[图片 #{number} · 未包含在分享中]", { number }) : t("[文件 #{number} · 未包含在分享中]", { number }))}</span>`;
  if (!files?.length) return SHARE ? html.replace(/\[(图片|文件) #(\d{1,4})\]/g, (match, kind, number) => omitted(kind, number)) : html;
  // A message saved since files were numbered across the room names them by that number; an older one by its place
  // in the message, which shows as every placeholder fitting a place while not every one fits a number.
  const numbers = [...html.matchAll(/\[(?:图片|文件) #(\d{1,4})\]/g)].map(([, number]) => Number(number));
  const by_number = numbers.every(number => files.some(file => file.number === number)) || !numbers.every(number => number <= files.length);
  return html.replace(/\[(图片|文件) #(\d{1,4})\]/g, (match, kind, number) => {
    const file = by_number ? files.find(item => item.number === Number(number)) : files[Number(number) - 1];
    if (!file) return SHARE ? omitted(kind, number) : match;
    const previewable = file.content_type.startsWith("image/") || file.content_type === "application/pdf" || is_text_attachment(file);
    // The stored `[图片 #n]` / `[文件 #n]` is protocol text; only the shown label follows the page language.
    const label = escape_html(kind === "图片" ? t("[图片 #{number}]", { number }) : t("[文件 #{number}]", { number }));
    const visual = kind === "文件" && /\.html$/i.test(file.file_name) ? " data-inline-visual" : "";
    return previewable ? `<button type="button" class="attachment-placeholder"${visual} ${attachment_preview_attributes(file)} title="${escape_html(file.file_name)}">${label}</button>`
      : `<a class="attachment-placeholder" ${attachment_download_attributes(file)} download title="${escape_html(t("下载 {name}", { name: file.file_name }))}">${label}</a>`;
  });
}

// The largest box a message image shows in (frontend/markdown.css `.attachment-image img`).
const ATTACHMENT_IMAGE_MAX_WIDTH = 360, ATTACHMENT_IMAGE_MAX_HEIGHT = 320;

/**
 * The size an image the site measured shows at, as CSS variables on its button: the image and its loading box both
 * take it, so the image arriving pushes nothing below it down (2026-11-17: a screenshot growing from the 160×120 box
 * to 320px moved the cards under it on a phone). An image without a size keeps the box and its own height.
 */
function attachment_image_style(file) {
  const width = Number(file.width), height = Number(file.height);
  if (!(width > 0 && height > 0)) return "";
  const shown = Math.max(1, Math.floor(Math.min(width, ATTACHMENT_IMAGE_MAX_WIDTH, ATTACHMENT_IMAGE_MAX_HEIGHT * width / height)));
  return ` style="--image-width: ${shown}px; --image-ratio: ${width} / ${height}"`;
}

/** Render immutable file cards shared by messages, original-message dialogs, and themes. */
function attachment_markup(files = []) {
  if (!files.length) return "";
  return `<div class="message-attachments">${files.map(file => {
    const url = `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
    const name = escape_html(file.file_name);
    const preview_attributes = attachment_preview_attributes(file);
    // Files of the computer's rooms are not on this website: they are read through the relay once shown or clicked.
    const source = files_by_blob() ? `data-relay-src="${url}"` : `src="${url}"`;
    const download = attachment_download_attributes(file);
    if (file.content_type.startsWith("image/")) return `<button type="button" class="attachment-image" ${preview_attributes}${attachment_image_style(file)}>
      <img ${source} alt="${name}" loading="lazy"></button>`;
    // Audio and video play in place with the browser's own controls; a format it cannot decode still has its download.
    if (/^(audio|video)\//.test(file.content_type)) {
      const tag = file.content_type.startsWith("video/") ? "video" : "audio";
      // The Vue workspace registers the Video.js players (Chinese labels, speed, full screen); the classic page has none.
      const skinned = Boolean(customElements.get(`${tag}-player`));
      const media = `<${tag} ${source} ${skinned ? "" : "controls "}preload="metadata" playsinline aria-label="${name}"></${tag}>`;
      return `<div class="attachment-media attachment-${tag}">${skinned ? `<${tag}-player><${tag}-skin class="attachment-player">${media}</${tag}-skin></${tag}-player>` : media}
        <span class="attachment-media-failed">${escape_html(t("浏览器无法播放这个文件的格式，请点下面的文件名下载后用本机软件打开。"))}</span>
        <a class="attachment-media-name" ${download} download title="${escape_html(t("下载 {name}", { name: file.file_name }))}">${name}<small>${attachment_size(file.size)}</small></a></div>`;
    }
    const content = `${attachment_file_icon(file.file_name)}<span class="attachment-name"><span title="${name}">${name}</span><small>${attachment_kind(file.file_name)[0]} · ${attachment_size(file.size)}</small></span>`;
    const previewable = file.content_type === "application/pdf" || is_text_attachment(file);
    return `<div class="attachment-file">${previewable
      ? `<button type="button" class="attachment-file-main" ${preview_attributes}>${content}</button>`
      : `<a class="attachment-file-main" ${download} download aria-label="${escape_html(t("下载 {name}", { name: file.file_name }))}">${content}</a>`}
      ${previewable ? `<button type="button" class="attachment-download" ${preview_attributes} title="${escape_html(t("预览 {name}", { name: file.file_name }))}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>` : ""}
      <a class="attachment-download" ${download} download aria-label="${escape_html(t("下载 {name}", { name: file.file_name }))}" title="${escape_html(t("下载 {name}", { name: file.file_name }))}">
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
/**
 * An attachment's address for reading its bytes: its route on this website, or, for the computer's rooms, a Blob URL
 * read through the relay (cached, so a thumbnail already shown costs nothing).
 */
async function attachment_url(file) {
  const path = `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
  return files_by_blob() ? relay_file_url(path, { urgent: true }) : path;
}

async function preview_attachment(input) {
  const { room_id, id } = input;
  // DOM datasets use camelCase; API records use snake_case.
  const file_name = input.file_name || input.fileName, content_type = input.content_type || input.contentType;
  const file_size = input.file_size ?? input.fileSize ?? input.size, created_at = input.created_at || input.createdAt;
  const message_id = Number(input.message_id ?? input.messageId) || 0;
  close_attachment_preview();
  const preview = { page: 1, zoom: 1, render_version: 0 };
  state.attachment_preview = preview;
  // A button rendered by attachment_markup names the file; an older caller passes only its ID.
  const known = file_name && content_type;
  const file = known ? { room_id, id, file_name, content_type, size: Number(file_size) || 0, created_at: created_at || "", message_id }
    : await request_json(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(id)}`);
  if (state.attachment_preview !== preview) return;
  // The Vue workspace opens the preview window at once and reads the file there, with its loading animation; PDF
  // opens there too. The classic page reads first and keeps its dialog.
  if ((is_text_attachment(file) || file.content_type === "application/pdf") && state.text_preview) {
    state.attachment_preview = null;
    if (typeof input.source === "boolean") state.text_preview(file, input.source);
    else state.text_preview(file);
    return;
  }
  if (file.content_type.startsWith("image/") && state.image_viewer) {
    state.attachment_preview = null;
    state.image_viewer(file);
    return;
  }
  file.url = file.download_url = files_by_blob() ? await attachment_url(file) : file.url || await attachment_url(file);
  if (state.attachment_preview !== preview) return;
  if (is_text_attachment(file)) {
    state.attachment_preview = null;
    location.assign(file.download_url);
    return;
  }
  preview.file = file;
  const is_pdf = file.content_type === "application/pdf";
  element("attachment-title").textContent = file.file_name;
  element("attachment-download").href = file.download_url;
  element("attachment-image").hidden = is_pdf;
  element("attachment-canvas").hidden = true;
  element("attachment-pdf-controls").hidden = !is_pdf;
  element("attachment-preview-status").textContent = is_pdf ? t('正在读取 PDF…') : "";
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
    if (state.attachment_preview === preview) element("attachment-preview-status").textContent = t('无法预览此 PDF：{value1}。可下载原文件查看。', { value1: error.message });
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
      element("attachment-preview-status").textContent = t('PDF 页面读取失败：{value1}', { value1: error.message });
  }
}

/** Bind the shared picker, paste/drop handlers, and accessible preview dialog once. */
function bind_attachment_controls() {
  element("choose-attachments").addEventListener("click", () => element("attachment-input").click());
  element("attachment-input").addEventListener("change", event => { add_attachments(event.target.files, attachment_target); attachment_target = null; event.target.value = ""; });
  for (const event of ["dragover", "drop"]) element("message-form").addEventListener(event, drop_attachments);
  element("message-input").addEventListener("paste", paste_attachments);
  document.addEventListener("click", event => {
    preview_clicked_attachment(event);
    const remove = event.target.closest("[data-remove-attachment]");
    if (remove) remove_attachment(remove.dataset.removeAttachment);
  });
  element("close-attachment").addEventListener("click", () => element("attachment-dialog").close());
  element("attachment-dialog").addEventListener("close", close_attachment_preview);
  element("attachment-image").addEventListener("error", () => { element("attachment-preview-status").textContent = t('图片读取失败，可下载原文件查看'); });
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
  const summary = message.summary ? t('回答摘要 · {value1}\n{value2}\n\n完整正文\n', { value1: display_name(message.summary_by), value2: message.summary }) : "";
  element("detail-body").textContent = `${source} · ${message_provenance(message)} · ${new Date(message.created_at).toLocaleString("zh-CN")}\n\n${summary}${message.text}`;
  element("detail-body").insertAdjacentHTML("beforeend", attachment_markup(message.attachments));
  if (message.reply_to) {
    const link = document.createElement("button");
    link.textContent = t('↳ 查看被回复的原文 #{value1}', { value1: message.reply_to });
    link.addEventListener("click", () => run_action(() => show_message(message.reply_to)));
    element("detail-body").append(link);
  }
  if (!element("message-dialog").open) element("message-dialog").showModal();
}

/** Read numeric limits from the shared classic/modern form controls. */
function read_limits(prefix) {
  return Object.fromEntries(["max_rounds", "max_minutes"].map(key => {
    const value = element(`${prefix}-limit-${key}${prefix === "topic" ? "-input" : ""}`).value;
    return [key, Number(value)];
  }));
}

/** Rounds against the limit: the current segment, with rounds the user appended shown as M+N (M is the original limit). */
function limit_rounds(limits = {}) {
  const done = limits.segment_rounds ?? limits.completed_rounds ?? 0;
  const cap = limits.round_cap ?? limits.max_rounds ?? 0;
  const total = limits.extra_rounds ? `${limits.max_rounds}+${limits.extra_rounds}` : "";
  return { done, cap, total, text: cap ? t('{value1} / {value2}{value3} 轮', { value1: done, value2: cap, value3: total ? `（${total}）` : "" }) : t('{value1} 轮', { value1: done }) };
}

/** Describe configured boundaries and actual progress without implying completion. */
function limits_label(limits = {}) {
  const finished = state.room?.phase === "concluded";
  const rounds = limits.round_cap || limits.max_rounds ? limit_rounds(limits).text : t('{value1} 轮 · 未设轮次上限', { value1: limits.completed_rounds || 0 });
  const duration = limits.max_minutes ? t('总时长 {value1} 分钟', { value1: limits.max_minutes }) : t('未设总时长');
  const progress = finished ? t('讨论已收束') : !limits.started_at ? t('尚未计时') : t('已用 {value1} 分钟{value2}', { value1: Math.floor((limits.elapsed_seconds || 0) / 60), value2: limits.remaining_seconds == null ? "" : t(' · 剩余 {value1} 分钟', { value1: Math.ceil(limits.remaining_seconds / 60) }) });
  const status = finished ? "" : limits.reached ? t('已达上限，停止新增安排') : "";
  const action = t('到限暂停');
  return `${rounds}；${duration}；${progress}。${action}${status ? `；${status}` : ""}。`;
}

/** Why a discussion ended, from the stop reason and the limits it ran under; anything else is the user ending it. */
function stop_reason_label({ stop_reason, max_rounds, max_minutes } = {}) {
  return { round_limit: t('达到轮次上限（{value1} 轮）', { value1: max_rounds }), time_limit: t('达到时长上限（{value1} 分钟）', { value1: max_minutes }),
    goal_done: t('主持人确认目标已完成') }[stop_reason] || t('用户结束了讨论');
}

/** Read private member files only inside the controller, never in a presentation snapshot. */
function member_credentials(room_id) {
  try { return JSON.parse(localStorage.getItem(MEMBER_ACCESS_PREFIX + room_id) || "{}"); }
  catch { return {}; }
}

/** Persist accepted owner/member credentials before discarding the original retry record. */
function save_room_credentials(room, token, members = []) {
  if (token) localStorage.setItem(`discuss-access:${room.id}`, token);
  const saved = member_credentials(room.id);
  for (const member of members) {
    const public_member = (room.members || room.free?.members || []).find(item => item.name === member.name);
    saved[member.name] = { token: member.token, access: member.access, id: public_member?.id };
  }
  localStorage.setItem(MEMBER_ACCESS_PREFIX + room.id, JSON.stringify(saved));
}

/** Public administrator state for the account UI; the session token never leaves the controller. */
function admin_snapshot() {
  const { loaded, local, devices, registered, setup_available, logged_in, profile, identity_version } = state.admin;
  return { loaded, local, devices, registered, setup_available, logged_in, identity_version, profile: profile && { ...profile } };
}

/** Build only non-secret status metadata for the currently selected room. */
function access_snapshot() {
  const room = state.room;
  if (!room) return { can_manage: false, members: [], notice: "", error: "" };
  const saved = member_credentials(room.id);
  return { can_manage: has_room_control(room.id),
    members: (room.members || room.free?.members || []).filter(member => member.status !== "removed").map(member => ({
      name: member.name, access: member.access, available: member.status === "active" && Boolean(saved[member.name]?.token)
        && (!saved[member.name].id || saved[member.name].id === member.id),
    })) };
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
    experts: read_expert_inputs("new-expert-modes"), limits: read_limits("new-room"), folder_id };
  // Rooms carry their task in the conversation, so no opening brief is sent.
  return { ...common, user_request: "", mode: "free", host: common.host || "用户" };
}

/** Retain an unresolved creation instead of silently replacing it with a new request. */
function prepare_room_request(signature) {
  if (state.pending_room?.signature === signature) return state.pending_room;
  const saved = stored_launches().find(record => record.signature === signature);
  if (saved) return state.pending_room = { signature, id: saved.id, token: saved.input.token, members: saved.input.room?.members };
  if (state.pending_room && localStorage.getItem(LAUNCH_PENDING_PREFIX + state.pending_room.id)) {
    throw new Error(t('上次启动结果尚未确认，请先继续原请求；如要放弃重试，请移除对应待办。原房间不会被删除。'));
  }
  state.pending_room = { signature, id: new_submission_id(), token: crypto.randomUUID() };
  return state.pending_room;
}

/**
 * Read a new room's details, transcript and member settings together while its placeholder shows, so the room then opens
 * complete in one step. Answers the room's details, or null when they are slow or fail and the room opens the usual way.
 */
async function preload_room(room_id) {
  const reads = Promise.all([request_json(`/api/rooms/${room_id}`), read_message_history(room_id, "", () => true),
    state.launch.available ? local_launch_request("room-models", { room_id, quick: true }).catch(() => null) : null]).catch(() => null);
  const loaded = await Promise.race([reads, new Promise(resolve => setTimeout(resolve, ROOM_PRELOAD_LIMIT_MS, null))]);
  if (!loaded) return null;
  const [room, , models] = loaded;
  cache_room_entry(room_views, room_id, room);
  if (models) preloaded_room_models.set(room_id, models);
  return room;
}

/**
 * Show creation progress locally without blocking or later hijacking navigation. The new-room panel passes `accepted`,
 * called once the form is valid so it closes at once while the new room shows as being created, and `rejected`, called
 * when nothing was made and no retry record remains, so the form can come back as it was filled in.
 */
async function submit_room(event, folder_id = null, { accepted = null, rejected = null } = {}) {
  event.preventDefault();
  if (state.directory_pending.has("create-room")) return;
  const payload = room_creation_payload(folder_id);
  // A room needs the local service only for members it wakes or for smart scheduling.
  const launchable = state.launch.available || (!computer_rooms_only() && Boolean(state.launch.relay));
  const launching = Object.values(payload.experts).includes("cli") || (launchable && Boolean(creation_launch_options().scheduler || state.launch.workspace.cwd || state.launch.workspace.local_project));
  if (launching && !launchable) throw new Error(t('本机唤醒的成员需要连接本机服务；也可改为手动接入'));
  const launch_draft = launching ? creation_launch_options() : null;
  // A discussion is only a way to push the room forward: the room is created as a free room, then opened with these limits.
  const discussion = state.create_discussion ? { goal: payload.goal.trim(), named_followup: state.named_followup,
    limits: read_limits("new-room") } : null;
  if (discussion && !(launching && payload.host && payload.experts[payload.host] === "cli")) throw new Error(t('开启讨论需要一位由本机唤醒的 AI 主持人；请先添加并设为主持人'));
  const goal = state.create_goal ? { ...state.create_goal, objective: state.create_goal.objective.trim() } : null;
  if (goal && !goal.objective) throw new Error(t('请填写 Goal 目标'));
  if (goal && !(launching && payload.host && payload.experts[payload.host] === "cli")) throw new Error(t('开启 Goal 需要一位由本机唤醒的 AI 主持人；请先添加并设为主持人'));
  // The key joins the signature only when a discussion or goal is requested, so recovered requests keep matching their stored signature.
  const signed = (current_payload, current_draft) => JSON.stringify(discussion ? { payload: current_payload, launch_draft: current_draft, discussion }
    : goal ? { payload: current_payload, launch_draft: current_draft, goal } : { payload: current_payload, launch_draft: current_draft });
  const signature = signed(payload, launch_draft);
  const navigation = state.navigation_version;
  if (!launching) element("room-dialog").close();
  const pending = prepare_room_request(signature);
  const previous_room = state.room?.id;
  if (accepted) {
    accepted();
    // Marked as the welcome state so a directory refresh does not open another room while this one is being made.
    state.welcome = true;
    run_action(() => select_room(null));
  }
  const token = pending.token;
  pending.members ||= creation_members(payload.experts);
  // The website tracks the capability cli; a manual expert is a local reader and writer whose delivery lives in its member record.
  const experts = Object.fromEntries(Object.entries(payload.experts || {}).map(([name, mode]) => [name, mode === "manual" ? "cli" : mode]));
  const input = { ...(launch_draft || {}), room: { ...payload, ...(payload.experts ? { experts } : {}), members: pending.members, submission_id: pending.id }, token };
  const open_created = id => { state.archive_view = false; return select_room(id); };
  let room, opening = null;
  try {
    room = await update_directory({ key: "create-room", label: t('「{value1}」创建', { value1: payload.title }),
      error_message: launching ? error => `「${payload.title}」${error.message}` : null,
      apply: () => { state.creating_room = { ...payload, opened: Boolean(accepted), submission_id: pending.id }; },
      rollback: () => {
        state.creating_room = null;
        // Someone who moved on to another room stays there.
        if (accepted && !state.room && previous_room) run_action(() => select_room(previous_room));
      },
      save: async () => {
        const created = (await submit_local_launch(input, payload.title, !launching, signature)).room;
        // Only a placeholder still on screen waits: someone who moved on to another room is not opened into this one.
        return accepted && !state.room ? { ...created, ...await preload_room(created.id) } : created;
      },
      commit: saved => {
        state.creating_room = null;
        if (!state.rooms.some(existing => existing.id === saved.id)) state.rooms.push(saved);
        // The panel's room opens in the same update that ends its placeholder; a discussion or goal then starts in it.
        if (accepted && !state.room) opening = open_created(saved.id);
      } });
  } catch (error) {
    if (accepted && state.room?.id === previous_room && !localStorage.getItem(LAUNCH_PENDING_PREFIX + pending.id)) rejected?.();
    throw error;
  }
  state.pending_room = null;
  if (signed(room_creation_payload(folder_id), launching ? creation_launch_options() : null) === signature) {
    element("room-form").reset();
    render_expert_inputs("new-expert-modes", default_experts());
    if (launching) element("room-dialog").close();
  }
  if (launching) clear_launch_overrides(launch_draft);
  const starting = (async () => {
    if (discussion) await open_discussion_after_creation(room.id, discussion);
    if (goal) await open_goal_after_creation(room.id, goal);
  })();
  await Promise.all([opening, starting]);
  if (opening && (discussion || goal) && state.room?.id === room.id) await refresh_room();
  if (!accepted && state.navigation_version === navigation) await open_created(room.id);
}

/**
 * Show the new-room welcome page in the middle, leaving no room selected until the user picks or creates one. Opened for
 * a folder (a hosted account's "new conversation" in one), the room its first message creates goes into that folder
 * with the folder's project directories.
 */
function open_welcome(folder = null) {
  state.welcome = true;
  state.welcome_folder = folder?.id ? { id: folder.id, directories: [...(folder.directories || [])] } : null;
  return select_room(null);
}

/** Whether a member woken through the local service, or the paired computer, can start right away. */
function launch_ready(name) {
  if (!state.launch.available) return Boolean(state.launch.relay?.clients?.[platform_of(name)]);
  const profile = state.launch.profiles[name] || {};
  if (profile.adapter === "api") return Boolean(profile.base_url && profile.api_protocol && profile.api_key_ref && profile.model);
  return Boolean(profile.adapter && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
}

/** Create a room from the welcome page's first message: the new-room panel's saved defaults, the first AI in its list
 * that can start as the only member and host, the message's first line as the title; then send the message there. */
async function quick_create_room(text) {
  text = String(text || "").trim();
  // The files picked on the welcome page go with the first message; opening the new room would otherwise drop them.
  const drafts = state.attachment_drafts;
  if (!text && !drafts.length) return;
  state.attachment_drafts = [];
  try {
    const folder = state.welcome_folder;
    await reset_create_form(folder);
    const name = Object.keys(IDENTITIES).find(item => item !== "用户" && LAUNCH_CLIENTS[item] && (default_launch_entry(item), launch_ready(item)));
    if (!name) throw new Error(t('还没有可直接唤醒的 AI：请先配置本机 AI 的接入'));
    write_view_expert("new-expert-modes", name, "cli");
    write_view_field("new-room-host", name, { publish: false });
    const title = text.split("\n")[0] || drafts[0].file.name;
    write_view_field("new-room-title", title.slice(0, ROOM_TITLE_MAX_LENGTH), { publish: false });
    if (state.create_discussion) write_view_field("new-room-goal", (text || title).slice(0, ROOM_GOAL_MAX_LENGTH), { publish: false });
    if (state.create_goal) state.create_goal = { ...state.create_goal, objective: text || title };
    await submit_room({ preventDefault() {} }, folder?.id || null);
  } finally {
    // Still on the welcome page (creation failed): the files stay in its composer for another try.
    if (!state.room) { state.attachment_drafts = drafts; render_attachment_drafts(); }
  }
  if (!state.room) return;
  if (state.room.archived) { release_files(drafts); return; }
  element("message-input").value = text;
  state.attachment_drafts = drafts;
  await send_message({ preventDefault() {} });
}

/** Open and start the discussion of a room just created; a failure leaves the room as an ordinary free room. */
async function open_discussion_after_creation(room_id, { goal, named_followup, limits }) {
  const path = `/api/rooms/${room_id}`;
  try {
    const current = await request_json(`${path}/discussion`);
    await request_json(`${path}/discussion`, { action: "start", revision: current.revision,
      ...(goal ? { goal } : {}), limits, named_followup });
  } catch (error) {
    notify("warning", t('房间已创建，但开启讨论失败：{value1}；可在右侧成员栏重试', { value1: error.message }));
  }
}

// How long an idle room waits before the goal wakes the host, unless the owner chose otherwise (backend/goal_room.py).
const GOAL_IDLE_SECONDS = 120;

/** Open the goal of a room just created; a failure leaves the room as an ordinary free room. */
async function open_goal_after_creation(room_id, { objective, max_continues, max_minutes, idle_seconds = GOAL_IDLE_SECONDS }) {
  const path = `/api/rooms/${room_id}/goal`;
  try {
    const current = await request_json(path);
    await request_json(path, { action: "start", revision: current.revision, objective, max_continues, max_minutes, idle_seconds });
    state.create_goal = null;
  } catch (error) {
    notify("warning", t('房间已创建，但开启 Goal 失败：{value1}；可在右侧成员栏重试', { value1: error.message }));
  }
}

/** Keep a pairing code from a scanned link (#pair=CODE) for the settings form, and take it out of the address bar. */
function take_pairing_code() {
  const match = (location.hash || "").match(/(?:^#|&)pair=([0-9A-Za-z-]{12,16})/);
  if (!match) return;
  state.device.pairing_code = match[1].toUpperCase();
  state.device.pairing_fp = (location.hash.match(/(?:^#|&)fp=([0-9a-f]{32})/) || [])[1] || "";
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  notify("info", t('已读取配对码：打开 设置 → 账号，点“配对”'));
}

/** Take the code and computer fingerprint from a scanned pairing link; answers the code, or "" when it is not one. */
function take_scanned_pairing(text) {
  const hash = String(text || "").split("#")[1] || "";
  const code = (hash.match(/(?:^|&)pair=([0-9A-Za-z-]{12,16})/) || [])[1];
  if (!code) return "";
  state.device.pairing_code = code.toUpperCase();
  state.device.pairing_fp = (hash.match(/(?:^|&)fp=([0-9a-f]{32})/) || [])[1] || "";
  return state.device.pairing_code;
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
    throw new Error(t('本机连接链接无效或无法保存，请重新运行连接命令；尚未发送启动请求'));
  }
}

/** Use the local bridge directly, or the paired computer when this device has none; plaintext never goes to the public server. */
async function local_launch_request(action, payload) {
  if (SHARE) throw Object.assign(new Error(t('分享页面不包含这部分内容')), { preflight: true });
  // A website without rooms of its own reaches the computer only through the relay; pairing itself still needs the local bridge.
  if (relay_machine && (!local_connection || computer_rooms_only() && action !== "machine-link")) return relay_command(action, payload);
  // Only the computer's own page has a local service at this address; elsewhere the computer is reached through the relay alone.
  // An account entry on the computer forwards to the local website, which then reports itself as local under another address.
  if (!local_connection && !state.admin.local && !["127.0.0.1", "localhost"].includes(location.hostname)) throw Object.assign(new Error(COMPUTER_UNREACHABLE), { preflight: true });
  const headers = { "Content-Type": "application/json", "X-CoDiscuss-Local": "1" };
  if (local_connection) headers["X-CoDiscuss-Connection"] = local_connection.token;
  let response;
  try {
    // A bridged website's request carries its own credential header; the page's own site may sit behind an account entry,
    // whose sign-in is a cookie.
    response = await fetch(`${local_connection?.endpoint || ""}/api/local/${action}`, {
      method: payload === undefined ? "GET" : "POST", headers, credentials: local_connection ? "omit" : "same-origin", redirect: "error",
      body: payload === undefined ? undefined : JSON.stringify(payload),
      ...(payload === undefined || ["room-models", "models", "api-check", "scheduler-check"].includes(action)
        ? { signal: AbortSignal.timeout(["room-models", "models", "api-check", "scheduler-check"].includes(action) ? MODEL_CATALOG_TIMEOUT_MS : LOCAL_CONNECTION_TIMEOUT_MS) } : {}) });
  } catch (error) {
    if (!local_connection) throw error;
    throw new Error(t('无法连接本机服务：请在这台电脑运行 codiscuss local open，并允许浏览器访问本机网络，再重试原请求'));
  }
  // A proxy or tunnel in between may answer with a page instead of JSON; its status says more than the browser's parse error.
  const raw = await response.text();
  let result;
  try { result = JSON.parse(raw); }
  catch { throw new Error(t('本机服务返回了无法识别的内容（HTTP {status}）：{excerpt}', { status: response.status, excerpt: raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) })); }
  if (!response.ok) throw Object.assign(new Error(server_text(result.error_text, result.error) || t('本机启动请求失败')), { launch: result.launch });
  return result;
}

// Relayed answers and files are converted in plain loops: a per-character callback takes tens of milliseconds a megabyte.
function bytes_to_base64(bytes) {
  // Characters converted per String.fromCharCode call, below engines' argument limits.
  const chunk = 0x8000;
  const view = new Uint8Array(bytes);
  let text = "";
  for (let index = 0; index < view.length; index += chunk) text += String.fromCharCode.apply(null, view.subarray(index, index + chunk));
  return btoa(text);
}

function base64_to_bytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The AES-GCM key shared with the paired computer for one command; mirrors relay_cipher in runner/remote_launch.mjs. */
async function relay_cipher(private_key, public_jwk) {
  const peer = await crypto.subtle.importKey("jwk", public_jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, private_key, 256);
  const material = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: new TextEncoder().encode(RELAY_CIPHER_INFO) },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}


// ---- Device trust (.dev/plans/远程访问安全加固/PROTOCOL.md): this browser's own signing key, pairing by a code shown on a
// trusted screen, and passkey confirmations. The paired computer decides; the website only forwards. ----
const DEVICE_DB = "codiscuss-device";
const PASSKEY_TIMEOUT_MS = 60000;
let device_identity_promise = null;

function bytes_to_b64url(bytes) {
  return bytes_to_base64(new Uint8Array(bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64url_to_bytes(text) {
  const base = String(text || "").replaceAll("-", "+").replaceAll("_", "/");
  return base64_to_bytes(base + "=".repeat((4 - base.length % 4) % 4));
}

/** Open the browser's store for the device key; a browser without one keeps the key for this page only. */
function device_store(mode, use) {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DEVICE_DB, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore("keys");
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const transaction = opening.result.transaction("keys", mode), request = use(transaction.objectStore("keys"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

/** This browser's signing key, created once and never exportable; its id is the first 32 hex digits of SHA-256 of the public key. */
function device_identity() {
  device_identity_promise ||= (async () => {
    let saved = await device_store("readonly", store => store.get("device")).catch(() => null);
    if (!saved) {
      const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
      const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
      saved = { private_key: pair.privateKey, public_jwk: { kty, crv, x, y }, raw: bytes_to_b64url(raw),
        id: Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("") };
      await device_store("readwrite", store => store.put(saved, "device")).catch(() => {});
    }
    state.device.id = saved.id;
    return saved;
  })();
  return device_identity_promise;
}

/** A short device name from the browser's own description, e.g. "iPhone · Safari". */
function device_label(agent = navigator.userAgent) {
  const text = String(agent || "");
  const system = /iPhone/.test(text) ? "iPhone" : /iPad/.test(text) ? "iPad" : /Android/.test(text) ? "Android" : /Windows/.test(text) ? "Windows"
    : /Mac OS X|Macintosh/.test(text) ? "Mac" : /Linux/.test(text) ? "Linux" : "";
  const browser = /Edg\//.test(text) ? "Edge" : /Chrome\//.test(text) ? "Chrome" : /Firefox\//.test(text) ? "Firefox" : /Safari\//.test(text) ? "Safari" : "";
  return [system, browser].filter(Boolean).join(" · ") || t('未知设备');
}

// Which computer this browser paired with and that computer's key fingerprint: nothing secret, the key itself stays in IndexedDB.
const PAIRED_KEY = "codiscuss-paired";

function paired_record() {
  try { return JSON.parse(localStorage.getItem(PAIRED_KEY) || "null"); } catch { return null; }
}

/** The fingerprint of a computer's two keys, as the computer prints it in its pairing QR code. */
async function machine_fingerprint(machine) {
  const ecdh = machine.public_key, sign = machine.sign_key;
  if (!ecdh || !sign) return "";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ecdh.x}.${ecdh.y}.${sign.x}.${sign.y}`)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** This device's signed credential for one request to the website: computer, device, time, and a signature over method, path and time. */
async function device_credential(method, path) {
  const record = paired_record();
  if (!record) return "";
  const device = await device_identity();
  const time = Math.floor(Date.now() / 1000);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.private_key, new TextEncoder().encode(`${method}\n${path}\n${time}`));
  return `${record.machine_id}.${device.id}.${time}.${bytes_to_b64url(signature)}`;
}

/** This browser no longer counts as paired: the computer revoked it, or it is being unpaired here. */
function forget_pairing() {
  try { localStorage.removeItem(PAIRED_KEY); } catch { /* Nothing stored. */ }
  state.admin.logged_in = false;
  state.device.needs = state.admin.devices ? "pairing" : state.device.needs;
  publish_view();
}

/** Run a device action on the paired computer, or on this computer's own service from its local page. */
async function device_request(action, payload = {}) {
  if (relay_machine && !state.admin.local) return relay_command(action, payload);
  if (action === "device-list") return local_launch_request("devices", {});
  if (action === "device-revoke") return local_launch_request("devices", { revoke: payload.device_id });
  throw new Error(t('请在已配对的设备上操作'));
}

/**
 * Pair this browser at the computer: the code shown on the computer's screen authenticates this browser's key, and the
 * passkey is created in the same step (its challenge is bound to the code and the key). A scanned QR code also carries
 * the computer's key fingerprint, so a website handing over other keys is caught here.
 */
async function pair_this_device(code) {
  const machine = relay_machine || await load_relay_machine();
  if (!machine?.sign_key) throw new Error(t('网站上还没有绑定电脑，或电脑的 codiscuss 版本过旧'));
  const normal = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (normal.length !== 12) throw new Error(t('配对码是 12 位字母和数字'));
  const fingerprint = await machine_fingerprint(machine);
  if (state.device.pairing_fp && state.device.pairing_fp !== fingerprint) throw new Error(t('网站给出的电脑身份与二维码不符，已停止配对；请在电脑前重新扫码'));
  const device = await device_identity();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(normal), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const proof = bytes_to_b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(`codiscuss-pair-v1\n${machine.id}\n${device.raw}`)));
  const challenge = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`codiscuss-pair-passkey\n${normal}\n${device.raw}`)));
  // WebAuthn must run on the user's tap, so everything above is ready before the dialog asks for it.
  return passkey_prompt({ title: t('配对这台设备'), description: t('用这台设备的面容、指纹或设备密码确认，完成与电脑的配对。之后打开网页即可使用，无需账号和密码。'), confirm_label: t('继续'),
    run: async () => {
      // A refused passkey still asks the computer, which accepts it only when this code was made to allow no passkey.
      let refused = null;
      const created = await (typeof navigator.credentials?.create === "function" ? navigator.credentials.create({ publicKey: { challenge, rp: { id: location.hostname, name: "AI CoDiscuss" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `codiscuss · ${device_label()}`, displayName: `AI CoDiscuss · ${device_label()}` },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, attestation: "none", timeout: PASSKEY_TIMEOUT_MS } })
        : Promise.reject(Object.assign(new Error("passkeys unavailable"), { name: "NotSupportedError" })))
        .catch(error => {
          // A browser without a working credential manager (e.g. Android without Google Play services) pairs by its device key alone.
          if (PASSKEY_UNAVAILABLE.has(error?.name)) return null;
          if (error?.name !== "NotAllowedError") throw passkey_error(error);
          refused = error;
          return null;
        });
      const passkey = created && { id: bytes_to_b64url(created.rawId), client_data_json: bytes_to_b64url(created.response.clientDataJSON),
        attestation_object: bytes_to_b64url(created.response.attestationObject) };
      const answer = await pair_exchange(machine, { public_key: device.public_jwk, label: device_label(), proof, passkey });
      if (answer.status >= 400 && refused && answer.body?.need === "passkey") throw passkey_error(refused);
      if (answer.status >= 400) throw new Error(server_text(answer.body?.error_text, answer.body?.error) || t('配对失败'));
      localStorage.setItem(PAIRED_KEY, JSON.stringify({ machine_id: machine.id, fingerprint }));
      Object.assign(state.device, { needs: "", pairing_code: "", pairing_fp: "" });
      state.admin.logged_in = true;
      publish_view();
      notify(passkey ? "info" : "warning", passkey ? t('这台设备已与电脑配对') : t('这台设备已与电脑配对（经电脑允许不用通行密钥）：不需要每天确认，也不能续期，到期须回电脑前重新配对'));
      // The owner's profile, settings and the computer's rooms load now that the computer accepts this device.
      await load_admin_state();
      await load_launch_settings();
      if (computer_rooms_only()) connect_computer_rooms();
    } });
}

/** Send the unsigned pairing request through the website's pairing entry and wait for the computer's answer. */
async function pair_exchange(machine, payload) {
  const id = crypto.randomUUID();
  const { key, envelope } = await seal_relay_request(machine, id, { action: "device-pair", payload });
  const path = `/api/machines/${encodeURIComponent(machine.id)}/pair`;
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, envelope, wait: PAIR_WAIT_MS }) });
  const result = await response.json();
  if (!response.ok) throw new Error(server_text(result.error_text, result.error) || t('配对请求被网站拒绝'));
  if (result.status === "done") return open_relay_response(key, id, result.response);
  if (result.status === "offline") throw new Error(t('电脑「{value1}」不在线，请确认它开机并运行 codiscuss', { value1: machine.name }));
  // Without the live relay, the request waits in the queue; its answer is sealed for this browser alone.
  for (const started = Date.now(); Date.now() - started < RELAY_COMMAND_WAIT_MS;) {
    await new Promise(resolve => setTimeout(resolve, RELAY_COMMAND_POLL_MS));
    const command = await (await fetch(`/api/machines/${encodeURIComponent(machine.id)}/commands/${id}`)).json();
    if (command.status === "done") return open_relay_response(key, id, command.response);
  }
  throw new Error(t('电脑没有及时答复配对请求，请确认它开机并运行 codiscuss 后重试'));
}

/** The page's own passkey confirmation: WebAuthn needs the user's tap, so options are fetched first and the call runs on the tap. */
function passkey_prompt({ title, description, confirm_label, run }) {
  return new Promise((resolve, reject) => {
    state.device.prompt = { title, description, confirm_label, run: async () => {
      state.device.prompt = null;
      publish_view();
      try { resolve(await run()); } catch (error) { reject(error); }
    }, cancel: () => { state.device.prompt = null; publish_view(); reject(Object.assign(new Error(t('已取消')), { cancelled: true })); } };
    publish_view();
  });
}

// Errors meaning this browser cannot create passkeys at all, as opposed to the user cancelling.
const PASSKEY_UNAVAILABLE = new Set(["NotReadableError", "NotSupportedError", "UnknownError"]);

/** Say in plain words why the browser refused a passkey step; its own message is English and names no cause. */
function passkey_error(error) {
  if (error?.name === "NotAllowedError") return new Error(t('没有完成通行密钥确认：已取消，或这台设备上没有这个网站可用的通行密钥'));
  if (error?.name === "InvalidStateError") return new Error(t('这台设备已经为这个网站创建过通行密钥'));
  if (error?.name === "SecurityError") return new Error(t('当前网址不能使用通行密钥，请用正式网站地址打开'));
  return error;
}

/** Ask this device's passkey to sign a challenge; returns the assertion fields the computer or website checks. */
async function passkey_assertion(options) {
  const credential = await navigator.credentials.get({ publicKey: { challenge: b64url_to_bytes(options.challenge), rpId: options.rp_id,
    allowCredentials: (options.allow || []).map(id => ({ type: "public-key", id: b64url_to_bytes(id) })), userVerification: "required", timeout: PASSKEY_TIMEOUT_MS } })
    .catch(error => { throw passkey_error(error); });
  return { id: bytes_to_b64url(credential.rawId), client_data_json: bytes_to_b64url(credential.response.clientDataJSON),
    authenticator_data: bytes_to_b64url(credential.response.authenticatorData), signature: bytes_to_b64url(credential.response.signature) };
}

/** Show a pairing code for a new device; only this computer's own page can, so new devices are added in front of it. */
async function invite_device(temporary, without_passkey = false) {
  if (!state.admin.local) throw new Error(t('新设备只能在电脑前添加：请在电脑本机网页打开 设置 → 账号 → 添加设备'));
  return local_launch_request("device-pairing", { temporary, without_passkey });
}

// Requests made together while the device is locked share one confirmation.
let unlocking = null;

/** Unlock this device for a day with its passkey; the computer asks once a day, on the first request. */
function unlock_this_device() {
  unlocking ||= (async () => {
    const options = await relay_command("passkey-challenge", { purpose: "unlock" });
    return passkey_prompt({ title: t('确认是你'), description: t('用面容、指纹或设备密码确认后，这台设备 24 小时内可以操作电脑上的房间。'), confirm_label: t('确认'),
      run: async () => relay_command("device-unlock", { challenge_id: options.challenge_id, assertion: await passkey_assertion(options) }) });
  })().finally(() => { unlocking = null; });
  return unlocking;
}

// Requests made together while the device is expired share one renewal.
let renewing = null;

/** Extend this device's trust by thirty days with its passkey. */
function renew_this_device() {
  renewing ||= (async () => {
    const options = await relay_command("passkey-challenge", { purpose: "renew" });
    return passkey_prompt({ title: t('续期这台设备'), description: t('这台设备的授权已到期或快到期。用面容、指纹或设备密码确认后，再获得 30 天授权。'), confirm_label: t('用通行密钥确认'),
      run: async () => {
        await relay_command("device-renew", { challenge_id: options.challenge_id, assertion: await passkey_assertion(options) });
        state.device.needs = "";
        publish_view();
        notify("info", t('已续期 30 天'));
      } });
  })().finally(() => { renewing = null; });
  return renewing;
}

/**
 * React to what the computer asked for: pair or renew this device (shown in settings), or unlock it for the day and
 * run the request once more. Returns true when the request should be retried.
 */
async function meet_device_need(error) {
  if (error.need === "unlock") {
    await unlock_this_device();
    return true;
  }
  // An expired device that may still renew asks for its passkey at once, then carries on; cancelling leaves the button in settings.
  if (error.need === "renew") {
    try {
      await renew_this_device();
      return true;
    } catch (failure) { if (!failure.cancelled) notify("error", failure.message); }
  }
  if (error.need === "pairing" && state.admin.devices) forget_pairing();
  if (error.need === "pairing" || error.need === "renew") {
    if (state.device.needs !== error.need) notify("warning", error.need === "pairing" ? t('这台设备还没有与电脑配对：打开 设置 → 账号，扫描或输入配对码') : t('这台设备的授权已到期：打开 设置 → 账号 用通行密钥续期'));
    state.device.needs = error.need;
    publish_view();
  }
  return false;
}

/**
 * Seal one request so that only the paired computer can read it and seal the answer. This browser signs it with its
 * device key; only a pairing request goes unsigned. The send time lets the computer refuse a replay.
 */
async function seal_relay_request(machine, id, request) {
  const encoder = new TextEncoder();
  // The computer it is meant for is signed too, so the request cannot be passed on to another paired computer.
  const body = JSON.stringify({ ...request, machine: machine.id, sent_at: Date.now() });
  let plain = { body };
  if (request.action !== "device-pair") {
    const device = await device_identity();
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.private_key, encoder.encode(`${id}\n${body}`));
    plain = { body, device_id: device.id, signature: bytes_to_b64url(signature) };
  }
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const key = await relay_cipher(ephemeral.privateKey, machine.public_key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(id) }, key, encoder.encode(JSON.stringify(plain)));
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", ephemeral.publicKey);
  return { key, envelope: { key: { kty, crv, x, y }, iv: bytes_to_base64(iv), data: bytes_to_base64(data) } };
}

/** Open the computer's answer to one request as { status, body }; answers over the relay connection are compressed. */
async function open_relay_response(key, id, sealed) {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64_to_bytes(sealed.iv), additionalData: new TextEncoder().encode(`${id}:response`) },
    key, base64_to_bytes(sealed.data));
  const bytes = sealed.encoding === "gzip" ? await new Response(new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : plain;
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Hand one request to the paired computer over its open relay connection. A computer that is not connected fails at once;
 * one that does not answer within `wait` leaves the outcome unconfirmed, and nothing is resent automatically.
 */
async function relay_exchange(action, payload, wait) {
  const machine = relay_machine;
  if (!machine) throw new Error(t('没有可用的已配对电脑，请在电脑上运行 codiscuss 并连接网站'));
  const id = crypto.randomUUID();
  const target = computer_rooms_only() ? { target: "computer" } : {};
  const { key, envelope } = await seal_relay_request(machine, id, { action, payload, ...target });
  const result = await request_json(`/api/machines/${encodeURIComponent(machine.id)}/relay`, { id, envelope, ...(wait ? { wait } : {}) })
    .catch(error => {
      // A request given up in the network may still have reached the computer, so its outcome is unconfirmed. Safari
      // reports the timeout as a plain AbortError ("Fetch is aborted"); the timeout is this request's only abort.
      if (error.name === "TimeoutError" || error.name === "AbortError") throw Object.assign(new Error(t('结果待确认：电脑「{value1}」未在限时内答复，请稍后查看房间，确认是否已生效后再重试', { value1: machine.name })),
        { unconfirmed: true, launch: { stage: "unconfirmed" } });
      throw error.status === 401 ? Object.assign(error, { need: "pairing" }) : error;
    });
  if (result.status === "done") return open_relay_response(key, id, result.response);
  if (result.status === "offline") throw Object.assign(new Error(t('电脑「{value1}」不在线，请确认它开机并运行 codiscuss', { value1: machine.name })), { offline: true });
  throw Object.assign(new Error(t('结果待确认：电脑「{value1}」未在限时内答复，请稍后查看房间，确认是否已生效后再重试', { value1: machine.name })),
    { unconfirmed: true, launch: { stage: "unconfirmed" } });
}

/** Queue one operation for the paired computer on the website and poll for its answer; used when the relay is unavailable. */
async function queued_relay_command(action, payload, limit) {
  const machine = relay_machine, id = crypto.randomUUID();
  const { key, envelope } = await seal_relay_request(machine, id, { action, payload });
  const path = `/api/machines/${encodeURIComponent(machine.id)}/commands`;
  await request_json(path, { id, envelope }).catch(error => { throw error.status === 401 ? Object.assign(error, { need: "pairing" }) : error; });
  for (const started = Date.now(); Date.now() - started < limit;) {
    await new Promise(resolve => setTimeout(resolve, RELAY_COMMAND_POLL_MS));
    const command = await request_json(`${path}/${id}`);
    if (command.status === "done") return open_relay_response(key, id, command.response);
  }
  throw Object.assign(new Error(t('电脑「{value1}」未在限时内答复，请确认它开机并运行 codiscuss 后重试', { value1: machine.name })), { launch: { stage: "unconfirmed" } });
}

/** Run one local-service operation on the paired computer; a write confirmation the computer asks for runs it once more. */
async function relay_command(action, payload) {
  try { return await relay_command_once(action, payload); }
  catch (error) {
    if (await meet_device_need(error)) return relay_command_once(action, payload);
    throw error;
  }
}

/** Run one local-service operation on the paired computer and answer as the local bridge would. */
async function relay_command_once(action, payload) {
  // The folder dialog would open on the computer where nobody sees it.
  if (action === "pick-directory") throw new Error(t('请直接输入电脑上的完整路径'));
  const limit = payload === undefined ? RELAY_SETTINGS_WAIT_MS : ["room-models", "models", "api-check", "scheduler-check"].includes(action)
    ? MODEL_CATALOG_TIMEOUT_MS + RELAY_SETTINGS_WAIT_MS : RELAY_COMMAND_WAIT_MS;
  let answer;
  // A website without the relay, or a computer not connected to it (an older codiscuss), still serves the queue.
  try { answer = await relay_exchange(action, payload, limit); }
  catch (error) { if (computer_rooms_only() || (error.status !== 404 && !error.offline)) throw error; }
  const { status, body } = answer ?? await queued_relay_command(action, payload, limit);
  if (status >= 400) throw Object.assign(new Error(server_text(body.error_text, body.error) || t('本机操作失败')), { launch: body.launch, need: body.need, room_id: body.room_id });
  return body;
}

/** Read or write one room route on the paired computer's local website, as its owner, and answer as request_json would. */
async function relay_room_request(path, payload, etag) {
  try { return await relay_room_request_once(path, payload, etag); }
  catch (error) {
    if (await meet_device_need(error)) return relay_room_request_once(path, payload, etag);
    throw error;
  }
}

/** Read or write one room route on the paired computer once; a read with `etag` may answer 304 without a body. */
async function relay_room_request_once(path, payload, etag) {
  let answer;
  for (let attempt = 0; ; attempt += 1) {
    try { answer = await relay_exchange("room-api", { method: payload === undefined ? "GET" : "POST", path, body: payload, ...(etag ? { etag } : {}) }); break; }
    catch (error) {
      // Only reads are asked again: a write whose outcome is unconfirmed must not be sent twice.
      const transient = error.unconfirmed || error.offline || error instanceof TypeError;
      if (payload !== undefined || !transient || attempt >= RELAY_READ_RETRY_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RELAY_READ_RETRY_MS[attempt]));
    }
  }
  if (answer.status >= 400) throw Object.assign(new Error(server_text(answer.body?.error_text, answer.body?.error) || t('请求失败，请重试')),
    { preflight: answer.status < 500, status: answer.status, need: answer.body?.need, room_id: answer.body?.room_id });
  return answer;
}

/**
 * Read one part of a room file through the relay, asked again after a dropped or timed-out exchange as other reads
 * are: a large image takes several parts, and one lost frame would otherwise leave it failed until the page reloads.
 */
async function relay_file_part(path, offset) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await relay_exchange("room-api", { method: "GET", path, offset }); }
    catch (error) {
      if (attempt >= RELAY_READ_RETRY_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RELAY_READ_RETRY_MS[attempt]));
    }
  }
}

/** Read a whole file of the computer's rooms through the relay; larger files come in several parts. */
async function relay_room_bytes(path) {
  if (SHARE) return share_file_blob(path);
  const parts = [];
  let offset = 0, total = 0, type = "";
  do {
    const answer = await relay_file_part(path, offset);
    if (answer.status >= 400) throw Object.assign(new Error(server_text(answer.body?.error_text, answer.body?.error) || t('文件读取失败')), { status: answer.status });
    if (typeof answer.body_base64 !== "string") throw new Error(t('文件读取失败'));
    const bytes = base64_to_bytes(answer.body_base64);
    if (!bytes.length && offset < answer.total) throw new Error(t('文件读取失败'));
    parts.push(bytes);
    offset += bytes.length;
    ({ total, content_type: type } = answer);
  } while (offset < total);
  return new Blob(parts, { type });
}

/** Send one part of an upload, again after a loss on the way (network, timeout, the relay reconnecting). */
async function relay_upload_part(payload) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const answer = await relay_exchange("room-upload", payload, RELAY_UPLOAD_WAIT_MS);
      if (answer.status >= 400) throw Object.assign(new Error(server_text(answer.body?.error_text, answer.body?.error) || t('附件上传失败')), { status: answer.status, refused: true });
      return answer;
    } catch (error) {
      const lost = !error.refused && (error.unconfirmed || error.offline || error instanceof TypeError || error.status >= 500 || error.status === 429);
      if (!lost || attempt >= RELAY_UPLOAD_RETRY_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RELAY_UPLOAD_RETRY_MS[attempt]));
    }
  }
}

/**
 * Send a file to a room route on the computer in parts, a few at a time; the computer hands it to its website whole.
 * Parts it already has are not sent again when the same file is tried again (relay_uploads). `on_progress` gets the
 * share of parts the computer has confirmed, from where a resumed try starts.
 */
async function relay_upload(path, data, on_progress) {
  const bytes = new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data);
  const total = Math.max(1, Math.ceil(bytes.length / RELAY_UPLOAD_PART_BYTES));
  let upload = relay_uploads.get(data);
  if (upload?.path !== path || upload.total !== total) relay_uploads.set(data, upload = { path, total, id: crypto.randomUUID(), done: new Set() });
  on_progress?.(upload.done.size / total);
  // Rounds: the parts not yet taken; then the parts the computer says it lacks (it restarted, or a part's answer went
  // astray). A computer too old to say which starts over once, under a new id.
  for (let round = 0; round < RELAY_UPLOAD_ROUNDS; round += 1) {
    const queue = [...Array(total).keys()].filter((index) => !upload.done.has(index));
    // Every part taken but no answer for the file (the last answer was lost): the last part asks for it again.
    if (!queue.length) queue.push(total - 1);
    let finished = null, missing = null, failure = null;
    const send = async () => {
      for (let index; !failure && (index = queue.shift()) !== undefined;) {
        const payload = { id: upload.id, path, index, total, size: bytes.length,
          data: bytes_to_base64(bytes.subarray(index * RELAY_UPLOAD_PART_BYTES, (index + 1) * RELAY_UPLOAD_PART_BYTES)) };
        try {
          const answer = await relay_upload_part(payload);
          upload.done.add(index);
          on_progress?.(upload.done.size / total);
          if (answer.body?.attachment) finished = answer.body;
          else if (Array.isArray(answer.body?.missing)) missing = answer.body.missing;
        } catch (error) { failure = error; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(RELAY_UPLOAD_PARALLEL, queue.length) }, send));
    if (failure) throw failure;
    if (finished) { relay_uploads.delete(data); return finished; }
    if (missing) for (const index of missing) upload.done.delete(index);
    else relay_uploads.set(data, upload = { path, total, id: crypto.randomUUID(), done: new Set() });
  }
  throw new Error(t('附件上传失败'));
}

/** Send file bytes to a room route on this website, or on the paired computer while its rooms are shown. */
async function post_room_file(path, body, token, on_progress) {
  if (state.remote_rooms) return relay_upload(path, body, on_progress);
  const response = await fetch(path, { method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...(token ? { "X-Discussion-Token": token } : {}) }, body });
  const result = await response.json();
  if (!response.ok) throw new Error(server_text(result.error_text, result.error) || t('附件上传失败'));
  return result;
}

/** Read the bytes of a room file from this website, or from the paired computer while its rooms are shown. */
async function read_room_file(path) {
  if (files_by_blob()) return new Uint8Array(await (await relay_room_bytes(path)).arrayBuffer());
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(t('附件读取失败'));
  return new Uint8Array(await response.arrayBuffer());
}

/** Run one relay file read when a slot is free; a file the user opened (`urgent`) goes ahead of images on the page. */
function queue_relay_file(read, urgent) {
  return new Promise((resolve, reject) => {
    const job = () => {
      relay_file_running += 1;
      read().then(resolve, reject).finally(() => { relay_file_running -= 1; relay_file_queue.shift()?.(); });
    };
    if (relay_file_running < RELAY_FILE_CONCURRENCY) job();
    else if (urgent) relay_file_queue.unshift(job);
    else relay_file_queue.push(job);
  });
}

/** Read one file of the computer's rooms through the relay once, and keep it as an object URL for this page. */
function relay_file_url(path, { urgent = false } = {}) {
  if (!relay_files.has(path)) {
    relay_files.set(path, queue_relay_file(() => relay_room_bytes(path), urgent).then(blob => URL.createObjectURL(blob))
      .catch(error => { relay_files.delete(path); throw error; }));
  }
  return relay_files.get(path);
}

/** Read a relayed image or media file once it nears the screen. */
// The box around a relayed image is watched, not the image: an image waiting for its file is hidden (display: none,
// markdown.css) behind a spinner, and a hidden element never intersects, so watching it left the image unread forever
// (2026-11-16, iPhone: a message's own screenshots kept spinning).
const relay_media_boxes = new WeakMap();
const relay_media_box = (media) => media.closest(".attachment-image, .attachment-media") || media;
const relay_media_observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    relay_media_observer.unobserve(entry.target);
    for (const media of relay_media_boxes.get(entry.target) || []) load_relay_media(media);
    relay_media_boxes.delete(entry.target);
  }
}, { rootMargin: RELAY_MEDIA_MARGIN }) : null;

/** Watch the visible box of one relayed image or media element until it nears the screen. */
function watch_relay_media(media) {
  const box = relay_media_box(media);
  relay_media_boxes.set(box, [...(relay_media_boxes.get(box) || []), media]);
  relay_media_observer.observe(box);
}

/**
 * Resolve once the reader has stopped scrolling the transcript (it carries data-reader-scrolling meanwhile). An image
 * growing from its spinner box to its own height above the screen pushes what the reader sees down; landing after the
 * scroll, that growth is offset in the same frame (by the page on WebKit, by the browser elsewhere), where in the middle
 * of a touch scroll on an iPhone it could only jump (2026-11-17 recording: 320px).
 */
function transcript_settled(scroller) {
  if (!scroller?.hasAttribute("data-reader-scrolling")) return Promise.resolve();
  return new Promise(resolve => scroller.addEventListener("reader-settled", resolve, { once: true }));
}

/** Give one relayed image or media element its file; one that cannot be read keeps its name. */
function load_relay_media(media) {
  if (!media.isConnected || media.getAttribute("src")) return;
  const mark_failed = () => { if (!media.getAttribute("src")) media.dataset.relayFailed = "1"; };
  const deadline = setTimeout(mark_failed, RELAY_MEDIA_TIMEOUT_MS);
  relay_file_url(media.dataset.relaySrc).then(async url => {
    const scroller = media.closest(".channel-transcript");
    // Decoded first, the image has its size the moment it gets its file, so the growth and its offset share one frame.
    if (scroller && media.tagName === "IMG") await Promise.race([Object.assign(new Image(), { src: url }).decode().catch(() => null),
      new Promise(resolve => setTimeout(resolve, RELAY_MEDIA_DECODE_MS))]);
    await transcript_settled(scroller);
    if (!media.isConnected || media.getAttribute("src")) return;
    media.src = url;
    delete media.dataset.relayFailed;
  }).catch(mark_failed).finally(() => clearTimeout(deadline));
}

/** Show images of the computer's rooms as they appear; one that cannot be read keeps its name. */
// Only the added nodes are searched: a whole-document query on every change walks the entire transcript.
function show_relay_images(records) {
  const selector = ":is(img, video, audio)[data-relay-src]:not([src]):not([data-relay-failed])";
  for (const record of records) {
    // A node taken off the page before it neared the screen is no longer watched.
    if (relay_media_observer) for (const node of record.removedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      for (const image of node.matches("[data-relay-src]") ? [node] : node.querySelectorAll("[data-relay-src]")) {
        const box = relay_media_box(image);
        relay_media_observer.unobserve(box);
        relay_media_boxes.delete(box);
      }
    }
    for (const node of record.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE || !node.isConnected) continue;
      for (const image of node.matches(selector) ? [node] : node.querySelectorAll(selector)) {
        if (relay_media_observer) watch_relay_media(image);
        else load_relay_media(image);
      }
    }
  }
}

/**
 * A format the browser cannot decode (AVI, WMV, some MOV) hides its player and says so, leaving the download link;
 * media errors do not bubble, so this listens in the capture phase.
 */
function mark_failed_media(event) {
  if (!["VIDEO", "AUDIO"].includes(event.target?.tagName)) return;
  const box = event.target.closest(".attachment-media");
  if (box) box.dataset.failed = "1";
}

/** Download a file of the computer's rooms through the relay instead of from this website. */
function download_relay_file(event) {
  const link = event.target.closest?.("a[data-relay-href]");
  if (!link) return;
  event.preventDefault();
  event.stopPropagation();
  run_action(async () => {
    const anchor = document.createElement("a");
    anchor.href = await relay_file_url(link.dataset.relayHref);
    anchor.download = link.dataset.fileName || "";
    anchor.click();
  });
}

/** The website of the rooms shown: the computer's own local website while its rooms are shown, otherwise this one. */
function room_site() {
  return state.remote_rooms && state.remote_site ? state.remote_site : location.origin;
}

/** Learn the computer's local website, so room links and member instructions name it rather than this website. */
async function load_remote_site() {
  const answer = await relay_exchange("computer-site");
  state.remote_site = answer.body?.site || "";
}

/** Whether this website keeps no rooms of its own and lists only the paired computer's (the Cloudflare site). */
function computer_rooms_only() {
  return state.admin.computer_rooms === true;
}

/** Show the paired computer's rooms, or an empty directory while it cannot be reached; the list opens at its first room. */
async function show_computer_rooms(remote) {
  if (remote) {
    // The room list and the room likely to open are read beside the computer's address rather than after it.
    let guess = new URLSearchParams(location.search).get("room");
    try { guess ||= localStorage.getItem(LAST_ROOM_KEY); } catch { /* Storage may be unavailable. */ }
    const paths = ["/api/rooms", ...guess ? [`/api/rooms/${guess}`, history_batch_path(guess, "", 0)] : []];
    paths.forEach(path => prefetch(path, () => relay_room_request(path)));
    try { await load_remote_site(); }
    catch (error) { prefetched.clear(); throw error; }
  }
  state.remote_rooms = Boolean(remote);
  // The two lists share no rooms, so nothing read from one may be shown for the other.
  room_views.clear();
  message_histories.clear();
  history_cards.clear();
  reset_background_reads();
  state.remote_online = null;
  state.rooms = [];
  set_folder_directory({});
  live_updates.source?.close();
  live_updates.source = null;
  live_updates.connected = false;
  live_updates.revisions = "";
  start_live_updates({ refresh: false });
  // Opening no room reads the chosen directory and then opens its first room.
  try { await select_room(undefined); }
  finally { prefetched.clear(); }
}

let computer_retry = null, computer_attempt = 0;
/**
 * Once signed in, find the paired computer and show its rooms. This is the only way the computer's rooms appear; until
 * they do, it tries again by itself, backing off while the computer stays away. `reload: false` reuses settings just read.
 */
async function connect_computer_rooms({ reload = true } = {}) {
  if (!state.admin.logged_in || computer_connecting) return;
  computer_connecting = true;
  clearTimeout(computer_retry);
  computer_retry = null;
  try {
    if (reload) await load_launch_settings();
    if (relay_machine && !state.remote_rooms) await show_computer_rooms(true);
  } catch (error) { console.warn("Connecting to the computer failed:", error.message); }
  finally {
    computer_connecting = false;
    if (state.remote_rooms) computer_attempt = 0;
    else if (state.admin.logged_in && !document.hidden) {
      const delay = RECONNECT_DELAYS_MS[Math.min(computer_attempt, RECONNECT_DELAYS_MS.length - 1)];
      computer_attempt += 1;
      computer_retry = setTimeout(() => { computer_retry = null; connect_computer_rooms(); }, delay);
    }
  }
}

/** The relay's change notices for the computer's rooms, shaped like the website's update stream. */
function relay_event_source() {
  const target = new EventTarget();
  const emit = (type, data) => target.dispatchEvent(Object.assign(new Event(type), { data }));
  const path = `/api/machines/${encodeURIComponent(relay_machine.id)}/relay`;
  const url = `${location.origin.replace(/^http/, "ws")}${path}`;
  let ping, socket = null;
  target.readyState = 0;
  target.close = () => { clearInterval(ping); target.readyState = 2; socket?.close(); };
  // The device signs the socket as it signs requests; the credential travels as a subprotocol, never in the URL.
  device_credential("GET", path).then(credential => {
    if (target.readyState === 2) return;
    socket = new WebSocket(url, [RELAY_PROTOCOL, ...(credential ? [`d.${credential}`] : [])]);
    listen_relay_socket(socket, target, emit, value => { ping = value; });
  }).catch(() => { target.readyState = 2; emit("error"); });
  return target;
}

/** Turn the relay socket's frames into the update stream's events. */
function listen_relay_socket(socket, target, emit, set_ping) {
  let ping;
  socket.addEventListener("open", () => {
    target.readyState = 1;
    ping = setInterval(() => socket.readyState === WebSocket.OPEN && socket.send("ping"), RELAY_PING_MS);
    set_ping(ping);
    emit("open");
    emit("ready");
  });
  socket.addEventListener("message", event => {
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (frame.type === "change") emit("change", JSON.stringify({ rooms: frame.rooms }));
    if (frame.type === "presence") {
      // The computer coming back (after a restart, say) is read at once rather than at the next poll.
      const back = frame.online && state.remote_online === false;
      state.remote_online = Boolean(frame.online);
      publish_view();
      if (back) emit("ready");
    }
  });
  socket.addEventListener("close", () => {
    clearInterval(ping);
    target.readyState = 2;
    emit("error");
  });
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
      <p>${escape_html(item.error || t('启动结果尚未确认；原请求已保存在此浏览器中。'))}</p><div class="topic-actions">
      <button class="button primary" data-launch-retry="${escape_html(item.id)}">${escape_html(t("继续本次启动"))}</button>
      ${item.room_id ? `<button class="button secondary" data-launch-room="${escape_html(item.room_id)}">${escape_html(t("查看原房间"))}</button>` : ""}
      <button class="button secondary" data-launch-discard="${escape_html(item.id)}">${escape_html(t("移除待办"))}</button></div></section>`).join("")
      + `<p>${escape_html(t("移除待办不会删除房间或停止讨论。"))}</p>`;
  }
  publish_view();
}

/** Persist the complete submitted input before any request can create or start a room. */
async function submit_local_launch(input, title, direct = false, signature) {
  const id = input.room?.submission_id || `room-${input.room_id}`;
  const key = LAUNCH_PENDING_PREFIX + id;
  const previous = localStorage.getItem(key);
  const relay = !direct && !state.launch.available && !computer_rooms_only() ? state.launch.relay?.id : undefined;
  const record = previous ? JSON.parse(previous) : { id, title, input, room_id: input.room_id, direct, signature, ...(relay ? { machine_id: relay } : {}) };
  if (previous && JSON.stringify(record.input) !== JSON.stringify(input)) throw new Error(t('此房间有未完成的原启动请求，请先继续该请求，不要替换配置'));
  record.attempt_id = crypto.randomUUID();
  try { localStorage.setItem(key, JSON.stringify(record)); }
  catch { throw new Error(t('此浏览器无法保存启动请求，请启用本地存储后重试；尚未发送本次启动')); }
  refresh_launch_recoveries();
  try {
    const result = record.direct ? { room: await request_json("/api/rooms", record.input.room, record.input.token), status: "created" }
      : record.machine_id ? await relay_launch_request(record.input, record.machine_id) : await local_launch_request("launch", record.input);
    save_room_credentials(result.room, record.input.token, record.input.room?.members || []);
    localStorage.removeItem(key);
    refresh_launch_recoveries();
    const names = [...(record.input.room?.members || []).map(member => member.name), ...Object.keys(result.room?.experts || {})];
    await send_descriptions(result.room?.id, record.input.token, Object.fromEntries(names.map(name => [name, description_draft(name)])));
    await send_labels(result.room?.id, record.input.token, Object.fromEntries(names.map(name => [name, label_drafts[name]])));
    for (const name of names) { delete description_drafts[name]; delete label_drafts[name]; }
    await send_chain_rounds(result.room?.id, record.input.token, state.create_chain_rounds);
    return result;
  } catch (error) {
    const stage = error.launch?.stage || (record.direct && error.preflight ? "not_started" : undefined);
    const prefix = stage === "not_started" ? (previous ? t('本次请求未执行，原启动结果仍待确认：') : t('本次请求未执行：')) : stage === "created" ? t('房间已创建，启动结果待确认：')
      : stage === "started" ? t('自动推进已启用，接入结果待确认：') : t('启动结果尚未确认，请沿用原请求重试：');
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
  publish_view();
  try {
    const result = await submit_local_launch(record.input, record.title, record.direct, record.signature);
    if (state.pending_room?.id === id && state.pending_room.signature === JSON.stringify({
      payload: room_creation_payload(record.input.room?.folder_id ?? null), launch_draft: record.direct ? null : creation_launch_options() })) {
      element("room-form").reset();
      render_expert_inputs("new-expert-modes", default_experts());
      element("room-dialog").close();
    }
    if (!record.direct) clear_launch_overrides(record.input);
    notify("info", result.status === "running" ? t('已核对原启动，实际执行请查看进度回执') : t('已核对原房间状态；不会自动恢复已暂停或结束的讨论'));
    if (state.pending_room?.id === id) state.pending_room = null;
    await select_room(result.room.id);
  } catch (error) { notify("error", error.message); }
  finally { state.directory_pending.delete(`launch-${id}`); render_launch_settings(); publish_view(); }
}

/** Remove only a browser retry intent, leaving remote rooms and running work untouched. */
function discard_launch(id) {
  localStorage.removeItem(LAUNCH_PENDING_PREFIX + id);
  if (state.pending_room?.id === id) state.pending_room = null;
  refresh_launch_recoveries();
}

/**
 * Load reusable client settings once; this neither registers rooms nor starts AI. `relay_known` is called once the paired
 * computer is known (or settings end), so the computer's rooms can be read beside its settings instead of after them.
 */
async function load_launch_settings({ relay_known = () => {} } = {}) {
  const local = state.admin.local || ["127.0.0.1", "localhost"].includes(location.hostname);
  state.launch.room_models = null;
  state.launch.model_catalogs = {};
  state.launch.connect_command = local ? "codiscuss local open" : `codiscuss local connect "${location.origin}"`;
  try {
    local_connection = null;
    take_pairing_code();
    local_connection = restore_local_connection();
    state.launch.remote = Boolean(local_connection);
    if (local_connection) state.launch.connect_command = `codiscuss local connect "${location.origin}"`;
    if (!local && (!local_connection || computer_rooms_only())) {
      // Pair first, so the computer this page runs on can then be reached through the relay like any other device.
      state.launch.relay = await load_relay_machine();
      // An online computer that publishes a command key does everything the local service would; an older one only creates rooms.
      // The previous one stays in use until this answer arrives, so requests made meanwhile still reach the computer.
      // A website without rooms of its own asks the relay itself, which knows at once whether the computer is connected;
      // the website's own record of the computer's last heartbeat can lag behind when that heartbeat is slow to arrive.
      relay_machine = state.launch.relay?.public_key && (state.launch.relay.online || computer_rooms_only()) ? state.launch.relay : null;
      if (!relay_machine) return;
      state.launch.remote = true;
    }
    relay_known();
    const settings = await local_launch_request("settings");
    // Software this computer can run only without its sandbox starts every new card at the one level it offers.
    state.launch.full_access_only = settings.full_access_only || [];
    for (const profile of Object.values(settings.participants || {})) if (full_only_hint(profile.adapter)) profile.project_access = "full";
    // Keep the saved machine defaults so every new form can start from them again.
    state.launch.saved_profiles = JSON.parse(JSON.stringify(settings.participants || {}));
    state.launch.create_preferences = { ...settings.create_preferences, ...create_preferences_pending };
    Object.assign(state.launch, { available: true, profiles: settings.participants, projects: settings.projects || [], projects_restricted: settings.projects_restricted === true, user_home: settings.user_home || "", api_providers: settings.api_providers || {}, api_keys: settings.api_keys || {}, managed_api_keys: settings.managed_api_keys || [],
      presets: settings.presets || [], builtin_presets: settings.builtin_presets || [], hidden_builtins: settings.hidden_builtins || [], workflows: settings.workflows || [], card_platforms: settings.platforms || [], description_templates: settings.description_templates || {},
      scheduler_providers: settings.scheduler_providers || {}, invite_site: settings.invite_site || null, error: "",
      notice: relay_machine ? t('经电脑「{value1}」执行本机操作', { value1: relay_machine.name }) : local_connection ? t('已连接本机服务，讨论保存在当前网站') : "" });
    Object.values(state.launch.profiles).forEach(fill_api_key);
    move_browser_description_templates();
    apply_create_preferences();
    flush_create_preferences();
    load_room_models();
  } catch (error) {
    // An unpaired or expired device keeps its way to the computer: pairing and renewal go through it.
    // A website without rooms of its own reaches the computer only through the relay, so one failed request keeps it.
    relay_machine = computer_rooms_only() || error.need === "pairing" || error.need === "renew" ? relay_machine : null;
    // The relay answering that the computer is not connected is shown as the computer being offline.
    if (computer_rooms_only() && !state.remote_rooms) state.remote_online = error.offline ? false : null;
    state.launch.remote = Boolean(local_connection);
    Object.assign(state.launch, { available: false, room_models: null, error: error.message });
    // Without a reachable local service, launches can still go through the paired computer.
    state.launch.relay = await load_relay_machine();
    if (state.launch.relay) state.launch.error = "";
  }
  finally { refresh_launch_recoveries(); render_launch_settings(); publish_view(); relay_known(); }
}

/**
 * The computer bound to this site: the one this browser paired with, else the most recently seen. Its keys are public;
 * a paired browser checks them against the fingerprint it pinned when it paired.
 */
async function load_relay_machine() {
  if (state.admin.local) return null;
  if (!state.admin.devices && !state.admin.logged_in) return null;
  try {
    const machines = (await request_json("/api/machines")).machines;
    const record = paired_record();
    // A paired browser talks only to the computer it paired with: a website that no longer lists it must not swap in another.
    if (record?.machine_id && !machines.some(item => item.id === record.machine_id)) {
      notify("error", t('网站上找不到与这台设备配对的电脑，已停止连接；如果电脑确实换过绑定，请在电脑前重新扫码配对'));
      return null;
    }
    // Without a pairing a page defaults to an owner's computer, never a hosted account's (`parent`, #5494).
    const machine = machines.find(item => item.id === record?.machine_id) || machines.find(item => !item.parent) || null;
    if (machine && record?.machine_id === machine.id && record.fingerprint && record.fingerprint !== await machine_fingerprint(machine)) {
      notify("error", t('网站给出的电脑身份与配对时不符，已停止连接；请在电脑前重新扫码配对'));
      return null;
    }
    return machine;
  } catch {
    // A failed read says nothing about the pairing, so the computer known so far stays in use.
    return state.launch.relay ?? null;
  }
}

/** Hand a room creation to the paired computer through the website and wait for it to finish. */
async function relay_launch_request(input, machine_id) {
  const id = input.room.submission_id;
  let launch = await request_json("/api/remote-launches", { id, machine_id, request: input });
  for (let waited = 0; ["pending", "claimed"].includes(launch.status) && waited < RELAY_WAIT_MS; waited += RELAY_POLL_MS) {
    await new Promise(resolve => setTimeout(resolve, RELAY_POLL_MS));
    launch = await request_json(`/api/remote-launches/${encodeURIComponent(id)}`);
  }
  if (launch.status === "failed") throw Object.assign(new Error(launch.error), { launch: { stage: launch.result.stage, room_id: launch.result.room_id } });
  const name = state.launch.relay?.name || t('电脑');
  if (launch.status !== "done") throw Object.assign(new Error(t('{value1}{value2}，请保持它开机并运行 codiscuss，稍后在待办中继续', { value1: name, value2: launch.status === "pending" ? t('尚未接手') : t('仍在启动') })), { launch: { stage: "unconfirmed" } });
  return { room: await request_json(`/api/rooms/${launch.result.room_id}`, undefined, input.token), status: launch.result.status };
}

/** Re-check the local connection and explain when nothing has been connected yet. */
async function retry_launch_connection() {
  await load_launch_settings();
  if (state.launch.available || state.launch.error) return;
  state.launch.error = t('尚未检测到本机连接，请先在运行 AI 的电脑上执行上方命令并完成网页授权。');
  publish_view();
}

// The members the last room-models answer named, kept for the outside-directory warning.
let members_seen = null;

/** Read saved choices for the active room without using drafts or delaying discussion refreshes. */
/** The parts of the computer's room-models answer the page keeps. */
function room_models_fields(result) {
  return { participants: result.participants, registered: result.registered,
    scheduler: result.scheduler || null, project_directory: result.project_directory || "", extra_directories: result.extra_directories || [],
    workflow: result.workflow || null, host_workflows: Boolean(result.host_workflows), host_permissions: result.host_permissions || null, api_max_requests: result.api_max_requests,
    image_generation: Boolean(result.image_generation), image_configured: Boolean(result.image_configured) };
}

async function load_room_models() {
  const room = state.room;
  // The saved project directory also applies to rooms containing only manual members.
  const woken = (room?.members || []).filter(member => member.access === "runner").map(member => member.name);
  if (!state.launch.available || !room) return;
  // The woken names are part of the key; each new execution may run another model, which only its session log tells, so the latest executions are too.
  const executions = (room.free?.members || []).map(member => member.execution?.id || 0).join(",");
  const revision = `${woken.join(",")}:${executions}`;
  const previous = state.launch.room_models;
  if (previous?.room_id === room.id && previous.revision === revision
    && (previous.loading || previous.participants)) return;
  // The last answer stays on screen while the new one is read.
  const same_room = previous?.room_id === room.id;
  const current = { participants: null, project_directory: "", extra_directories: [], ...(same_room ? previous : {}), room_id: room.id, revision, loading: true, error: "" };
  const preloaded = preloaded_room_models.get(room.id);
  preloaded_room_models.delete(room.id);
  if (preloaded) Object.assign(current, room_models_fields(preloaded), { loading: false });
  state.launch.room_models = current;
  publish_view();
  const live = () => state.launch.room_models === current && state.room?.id === room.id;
  // agy is run to name its default model, which takes seconds; everything else is shown first and agy follows.
  try {
    const result = preloaded || await local_launch_request("room-models", { room_id: room.id, quick: true });
    if (live() && result.room_id === room.id) Object.assign(current, room_models_fields(result));
    if (live() && result.room_id === room.id) {
      // Compared with the last answer for this room, which a reload clears from the state but not from here.
      if (members_seen?.room_id === room.id) warn_outside_members(members_seen.participants, result.participants);
      members_seen = { room_id: room.id, participants: result.participants };
    }
  } catch (error) {
    // Unavailable or older bridges leave the model unknown; the failure is kept so the page can say so, and the next refresh retries.
    Object.assign(current, { participants: null, error: error.message || t('读取失败') });
  } finally {
    current.loading = false;
    if (live()) publish_view();
  }
  const pending = Object.entries(current.participants || {}).filter(([, profile]) => profile.defaults_pending).map(([name]) => name);
  if (!pending.length || !live()) return;
  try {
    const result = await local_launch_request("room-models", { room_id: room.id });
    if (live() && result.room_id === room.id) current.participants = result.participants;
  } catch {
    // A slow agy that fails to answer keeps its model unknown rather than guessed.
    for (const name of pending) current.participants[name] = { ...current.participants[name], defaults_pending: false, defaults_failed: true };
  } finally { if (live()) publish_view(); }
}

/** Read this computer's saved choices again, as after a failed read. */
function reload_room_models() {
  state.launch.room_models = null;
  return load_room_models();
}

/** Read a directory or file from the room's saved project through the authenticated local connection. */
function read_room_files(room_id, path = "", offset = 0, query = "", root = 0, folders = null) {
  return local_launch_request("room-files", { room_id, path, offset, ...(query ? { query } : { root }), ...(folders ? { folders } : {}), token: localStorage.getItem(`discuss-access:${room_id}`) });
}

/**
 * Change the room's project or draft folders from the file page: `payload.op` is one of the runner's file operations
 * (`roots`, `mkdir`, `rename`, `delete`, `paste`, `read`, `save`, `trash`, `restore`, `new-project`, `delete-root`), with
 * `root` (an index of the room's directories or an account folder's id) and a relative `path`.
 */
function manage_room_files(room_id, payload) {
  return local_launch_request("room-files", { room_id, ...payload, token: localStorage.getItem(`discuss-access:${room_id}`) });
}

// Upload parts: small enough for the relay's frame when the computer is reached through it, larger on the computer itself.
const PROJECT_UPLOAD_RELAY_PART_BYTES = 128 * 1024;
const PROJECT_UPLOAD_LOCAL_PART_BYTES = 3 * 1024 * 1024;
const PROJECT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const PROJECT_UPLOAD_RETRY_MS = [1000, 3000];

/**
 * Upload one file into a folder of the room's projects in parts, one at a time; `conflict` (`replace` / `keep_both`)
 * says what happens to a file of the same name. `on_progress(share)` follows the parts the computer took.
 */
async function upload_project_file(room_id, { root, path, file, conflict, on_progress = () => {} }) {
  if (file.size > PROJECT_UPLOAD_MAX_BYTES) throw new Error(t('单个文件不能超过 {value1} MB', { value1: PROJECT_UPLOAD_MAX_BYTES / 1024 / 1024 }));
  const relayed = Boolean(relay_machine && (!local_connection || computer_rooms_only()));
  const part_bytes = relayed ? PROJECT_UPLOAD_RELAY_PART_BYTES : PROJECT_UPLOAD_LOCAL_PART_BYTES;
  const total = Math.max(1, Math.ceil(file.size / part_bytes)), upload_id = crypto.randomUUID().replaceAll("-", "");
  let answer = null;
  for (let index = 0; index < total; index += 1) {
    const bytes = new Uint8Array(await file.slice(index * part_bytes, (index + 1) * part_bytes).arrayBuffer());
    const part = { op: "upload", root, path, name: file.name, upload_id, index, total, size: file.size, data: bytes_to_base64(bytes), ...(conflict ? { conflict } : {}) };
    // A part lost on the way (the relay reconnecting) is sent again; the computer answers a resent last part with the file it wrote.
    for (let attempt = 0; ; attempt += 1) {
      try { answer = await manage_room_files(room_id, part); break; }
      catch (error) {
        if (attempt >= PROJECT_UPLOAD_RETRY_MS.length) throw error;
        await new Promise((resolve) => setTimeout(resolve, PROJECT_UPLOAD_RETRY_MS[attempt]));
      }
    }
    on_progress((index + 1) / total);
  }
  return answer;
}

/** Save one file of the room's projects to this device: a download address on the computer, else the whole file through the relay. */
async function download_project_file(room_id, path, root = 0) {
  const media = await read_room_media(room_id, path, root, () => {}, true);
  const link = document.createElement("a");
  link.href = media.url;
  link.download = path.split("/").pop() || "file";
  document.body.append(link);
  link.click();
  link.remove();
  if (media.blob) setTimeout(() => URL.revokeObjectURL(media.url), 60000);
}

/** A room's name for messages that list rooms by id. */
function room_title(room_id) {
  return state.rooms.find((room) => room.id === room_id)?.title || room_id;
}

/** Read the selected member's local skill catalog through the same owner-authenticated connection. */
function read_member_skills(room_id, name) {
  return local_launch_request("room-skills", { room_id, name, token: localStorage.getItem(`discuss-access:${room_id}`) });
}

/**
 * Open one image, video or audio file of the room's project for the preview's viewer and players. The computer's own
 * page gets a short-lived address its website streams from disk (seeking reads only what is needed); another device
 * gets the whole file through the relay in parts, up to the computer's limit, as a Blob URL the caller revokes.
 * `{ url, content_type, size, blob }`; `on_progress(loaded, total)` follows a relayed read. With `download` any
 * regular file is read, and the computer's address saves it instead of showing it.
 */
async function read_room_media(room_id, path, root = 0, on_progress = () => {}, download = false) {
  const token = localStorage.getItem(`discuss-access:${room_id}`);
  const flag = download ? { download: true } : {};
  let answer = await local_launch_request("room-media", { room_id, path, root, offset: 0, token, ...flag });
  if (answer.url) return { url: `${local_connection?.endpoint || ""}${answer.url}`, content_type: answer.content_type, size: answer.size, blob: false };
  const parts = [], version = answer.version;
  let offset = 0;
  for (;;) {
    if (answer.version !== version) throw new Error(t('文件在读取时发生了变化，请重试'));
    const bytes = base64_to_bytes(answer.data || "");
    if (!bytes.length && offset < answer.total) throw new Error(t('文件读取失败'));
    parts.push(bytes);
    offset += bytes.length;
    on_progress(offset, answer.total);
    if (offset >= answer.total) break;
    answer = await local_launch_request("room-media", { room_id, path, root, offset, token, ...flag });
  }
  return { url: URL.createObjectURL(new Blob(parts, { type: answer.content_type })), content_type: answer.content_type, size: answer.total, blob: true };
}

/**
 * Read one HTML file of the room's project with the files it refers to inlined by the computer, in parts when it comes
 * through the relay; `{ text, missing, skipped, modified_at }`.
 */
async function read_room_page(room_id, path, root = 0) {
  const parts = [];
  let offset = 0, answer, version = "";
  do {
    answer = await local_launch_request("room-page", { room_id, path, root, offset, token: localStorage.getItem(`discuss-access:${room_id}`) });
    if (version && answer.version !== version) throw new Error(t('页面在读取时发生了变化，请重试'));
    version = answer.version;
    const bytes = base64_to_bytes(answer.data || "");
    if (!bytes.length && offset < answer.total) throw new Error(t('页面读取失败'));
    parts.push(bytes);
    offset += bytes.length;
  } while (offset < answer.total);
  const bytes = new Uint8Array(offset);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return { text: new TextDecoder().decode(bytes), missing: answer.missing || [], skipped: answer.skipped || [], modified_at: answer.modified_at };
}

/**
 * Read what a member did in one execution, or in one private chat turn (`{chat_id}`), from the computer's own log; the
 * details never pass through the website.
 */
function read_execution_details(room_id, execution_id, { chat_id } = {}) {
  return local_launch_request("execution-details", { room_id, ...(chat_id ? { chat_id } : { execution_id }), token: localStorage.getItem(`discuss-access:${room_id}`) });
}

/** The owner's private chat with one member, as the website keeps it (owner only). */
function read_member_chat(room_id, member_id) {
  return request_json(`/api/rooms/${room_id}/members/${member_id}/chat`);
}

/** Say one line to a member in private; a retry with the same submission_id is the same line. */
function send_member_chat(room_id, member_id, text, submission_id) {
  return request_json(`/api/rooms/${room_id}/members/${member_id}/chat`, { text, submission_id });
}

/** Stop a private chat line that is waiting or running. */
function stop_member_chat(room_id, chat_id) {
  return request_json(`/api/rooms/${room_id}/chats/${chat_id}`, { action: "stop" });
}

/**
 * Pause a member's running room execution from the private chat without ending it: the runner stops the software's
 * turn and resumes the same execution in the same session with the owner's next line.
 */
function pause_execution(room_id, execution_id) {
  return request_json(`/api/rooms/${room_id}/executions/${execution_id}`, { action: "pause" });
}

/**
 * Describe registered launch choices: the card's choice, else what the member's session last ran with, else what the software's settings select;
 * anything unknown is "默认".
 */
function participant_model(name, room, saved) {
  // Nothing to say beats a placeholder: a manual member's settings live in its own session and unread ones are not guessed.
  const member = (room?.members || []).find(item => item.name === name);
  if (member?.access !== "runner") return "";
  const profile = saved?.room_id === room.id ? saved.participants?.[name] : null;
  if (!profile) return "";
  // Only an agy member without a chosen model depends on the default that is read later.
  if (!profile.model && !profile.actual_model && profile.defaults_pending) return t('读取中…');
  // App members choose in their own chat, so only their session log knows.
  const app = ["codex", "antigravity"].includes(profile.adapter);
  // What the session last actually ran with comes first, so a member that says or is set to another model cannot mislead;
  // a different setting (it applies from the next run, or the software ignored it) is named beside it.
  const model = (app ? profile.actual_model : profile.actual_model || profile.model || profile.default_model) || t('默认');
  // agy's default effort belongs to its default model, so any other model keeps its own default instead.
  const default_effort = profile.adapter === "antigravity_cli" && model !== profile.default_model ? "" : profile.default_effort;
  const effort = (app ? profile.actual_effort : profile.actual_effort || profile.effort || default_effort) || t('默认');
  const shown = model === t('默认') && effort === t('默认') ? t('默认') : `${model} · ${effort}`;
  if (app || !profile.actual_model) return shown;
  if (profile.model) return profile.model !== profile.actual_model ? t('{shown}（设置为 {model}）', { shown, model: profile.model }) : shown;
  // Left to the software's default: only a default read as a model ID (by asking the software) can be told from what last ran.
  const follows = window.discuss_backup?.adapter_profile(profile.adapter)?.defaults_by_query && profile.default_model;
  return follows && profile.default_model !== profile.actual_model
    ? t('{shown}（设置为 {model}）', { shown, model: t('软件默认 · {value1}', { value1: profile.default_model }) }) : shown;
}

/** A woken member's project files as 只读 / 可写; empty when the site does not decide them (App, its own agy project, a taken-over manual member, unread settings). */
function participant_files(name, room, saved) {
  const member = (room?.members || []).find(item => item.name === name);
  if (member?.access !== "runner") return "";
  const profile = saved?.room_id === room.id ? saved.participants?.[name] : null;
  if (!profile) return "";
  if (!ACCESS_CLIENTS.includes(profile.adapter) || profile.own_project || profile.project_access === "own") return "";
  return ACCESS_LABELS[profile.project_access] || t('只读');
}

/**
 * What a borrowed session means for its original window, shown when hovering "借用会话". The Apps take each task in
 * their own chat, and a taken-over Claude member gets it in its open window; a background resume works in a copy where
 * the adapter makes one (`copy_bound`), so the original never shows the room's turns.
 */
function participant_session_hint(name, room, saved) {
  const member = (room?.members || []).find(item => item.name === name);
  if (member?.access !== "runner" || member.session_mode !== "borrowed") return undefined;
  if (["codex", "antigravity"].includes(member.adapter)) return t('续接你已有的 App 会话：任务直接送进 App 里的这个会话，可在其中查看');
  const profile = saved?.room_id === room.id ? saved.participants?.[name] : null;
  if (member.adapter === "claude" && profile?.project_access === "own") {
    return t('续接你自己的会话：原窗口开着时任务直接送进该窗口；窗口关闭时改在后台续接，期间不要重新打开该会话');
  }
  if (window.discuss_backup.adapter_profile(member.adapter)?.copy_bound && profile?.project_access !== "own") {
    return t('从你已有的会话分叉而来；原会话里看不到房间里的后续记录');
  }
  return t('续接你已有的会话；它工作时请不要在原窗口继续操作');
}

/** Label how a member answers: the registered adapter says API / App; other locally woken members are CLI. */
function participant_access(name, room) {
  const member = (room?.members || []).find(item => item.name === name);
  if (member?.access === "external" || /^Custom-ext[0-9]*$/.test(name)) return "";
  const adapter = member?.adapter;
  if (member?.access === "manual") return t('手动启动');
  if (adapter === "api") return "API";
  if (["codex", "antigravity"].includes(adapter)) return "App";
  return "CLI";
}

// App and web clients keep model selection in the original conversation.
const MODEL_CLIENTS = ["codex_cli", "claude", "antigravity_cli"];
// Mirrors the adapters with access_levels in runner/adapters/profiles.mjs; this classic script cannot import it.
const ACCESS_CLIENTS = [...MODEL_CLIENTS, "api"];
const MODEL_SOURCE_LABELS = { "codex-app-server": t('来自 Codex CLI 模型列表'), "claude-cli": t('来自 Claude CLI 模型列表'), "antigravity-cli": t('来自 Antigravity CLI 模型列表') };

// The last list each software gave, kept in this browser per computer: a list shows at once and is replaced when the
// computer answers (through the relay that takes seconds). Only what a software reports about itself, never API settings.
const MODEL_CATALOG_STORE = "codiscuss.model_catalogs";
const MODEL_CATALOG_STORE_LIMIT = 12;

/** Where this browser keeps one software's list: the computer it was read from, then the software. */
const stored_catalog_key = (key) => `${state.launch.relay?.id || "local"}|${key}`;

/** Every list kept in this browser; empty when storage is blocked or holds something unreadable. */
function stored_catalogs() {
  try { return JSON.parse(localStorage.getItem(MODEL_CATALOG_STORE)) || {}; } catch { return {}; }
}

/** Keep a software's fresh list for the next visit, dropping the lists unused the longest. */
function store_catalog(key, { models, source, efforts, defaults }) {
  const kept = { ...stored_catalogs(), [stored_catalog_key(key)]: { at: Date.now(), models, source, efforts, defaults } };
  const newest = Object.entries(kept).sort(([, first], [, second]) => second.at - first.at).slice(0, MODEL_CATALOG_STORE_LIMIT);
  try { localStorage.setItem(MODEL_CATALOG_STORE, JSON.stringify(Object.fromEntries(newest))); } catch { /* The list is read again next time. */ }
}

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
function launch_model_state(name, launch = state.launch, profile = launch.profiles[name] || {}) {
  if (profile.adapter === "api") {
    const catalog = launch.model_catalogs?.[model_catalog_key(profile)];
    const preset = launch.api_providers?.[platform_of(name)];
    // Without the local service there are no presets, and two missing addresses are not an official match.
    const official = Boolean(preset) && profile.base_url?.replace(/\/$/, "") === preset.base_url;
    const models = catalog?.models || (official ? preset.models.map(id => ({ id, label: id })) : []);
    return { supported: true, items: models.map(model => ({ label: model.id, value: model.id })),
      loading: Boolean(catalog?.loading), error: catalog?.error || "", source: catalog ? t('来自 API 模型列表') : t('官方推荐，可输入其他模型 ID') };
  }
  const catalog = launch.model_catalogs?.[model_catalog_key(profile)];
  const models = catalog?.models || [];
  const selected = models.find(model => model.id === profile.model);
  const defaults = catalog?.defaults || {};
  // The list shows model IDs as they are; a list kept from last time needs no "reading" note while it is refreshed.
  const items = [{ label: defaults.model ? t('软件默认 · {value1}', { value1: defaults.model }) : t('软件默认模型'), value: "__default__" }, ...models.map(model => ({ label: model.id, value: model.id }))];
  if (profile.model && !selected) items.push({ label: profile.model, value: profile.model, disabled: true });
  const loading = Boolean(catalog?.loading && !models.length);
  // "Software default" offers the levels of the model the software's own settings name, when the list has it.
  const effective = selected || (!profile.model && models.find(model => model.id === defaults.model));
  return { supported: MODEL_CLIENTS.includes(profile.adapter), items, defaults, loading, refreshing: Boolean(catalog?.loading),
    efforts: effective?.efforts, source: MODEL_SOURCE_LABELS[catalog?.source] || catalog?.source || "",
    effort_note: !effective
      ? t('选择模型后显示可用思考强度；默认值由软件决定。') : t('所选模型不提供单独思考强度。'),
    error: catalog?.error || (!launch.available ? t('连接本机服务后读取模型列表') : !catalog ? t('尚未读取此软件的模型列表') : "") };
}

/** Read model metadata only; never launch an AI task or persist discovered choices as defaults. */
async function load_launch_models(name, force = false, profile = state.launch.profiles[name] || {}) {
  if (!state.launch.available || (!MODEL_CLIENTS.includes(profile.adapter) && profile.adapter !== "api")) return;
  if (profile.adapter === "api" && (!force || !profile.api_key_ref)) return;
  const catalogs = state.launch.model_catalogs ||= {}, key = model_catalog_key(profile);
  if (catalogs[key]?.loading || (!force && catalogs[key])) return;
  const fallback = profile.adapter === "antigravity_cli" ? catalogs[model_catalog_key({ ...profile, model: "" })] : null;
  const stored = profile.adapter === "api" ? null : stored_catalogs()[stored_catalog_key(key)];
  // What is on screen stays while the computer answers, so a refresh never empties the list.
  const previous = catalogs[key];
  const shown = [previous, fallback, stored].find(item => item?.models?.length);
  const current = { ...stored, ...previous, models: shown?.models || [], loading: true, error: "", source: previous?.source || stored?.source || "" };
  let failure = "";
  const input = profile.adapter === "api" ? { adapter: "api", base_url: profile.base_url, api_protocol: profile.api_protocol, model: profile.model || "discovery", api_key_ref: profile.api_key_ref }
    : { adapter: profile.adapter, ...(profile.executable ? { executable: profile.executable } : {}),
      ...(profile.adapter === "antigravity_cli" && profile.model ? { model: profile.model } : {}), ...(force ? { refresh: true } : {}) };
  catalogs[key] = current;
  publish_view();
  try {
    const result = await local_launch_request("models", input);
    if (result.adapter !== input.adapter) throw new Error(t('模型列表与所选软件不一致'));
    failure = result.error || (!result.models?.length ? t('软件未返回可用模型，可使用默认模型') : "");
    // A failed refresh leaves the list kept from last time in place.
    if (result.models?.length || !current.models.length) {
      current.models = result.models || [];
      current.source = result.source || "";
      current.efforts = result.efforts ?? current.efforts;
      current.defaults = result.defaults || current.defaults || {};
      current.effort_error = result.effort_error || "";
      current.error = result.error || (!current.models.length ? t('软件未返回可用模型，可使用默认模型') : "");
    }
    if (result.models?.length && profile.adapter !== "api" && !result.error) store_catalog(key, current);
  } catch (error) { failure = error.message; if (!current.models.length) current.error = failure; }
  finally {
    current.loading = false;
    // Asked for by the refresh button: say how it went; without a list the reason already shows under the picker.
    if (force && profile.adapter !== "api") {
      if (!failure) notify("info", t('模型列表已更新'));
      else if (current.models.length) notify("warning", t('刷新失败，继续使用当前列表：{value1}', { value1: failure }));
    }
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

/** A card woken by the local service on a platform without local software starts on its API, unless it already names an entry. */
function default_launch_entry(name) {
  const profile = state.launch.profiles[name];
  if (profile?.adapter === "api" || local_entry_ready(profile)) return;
  const local_software = LAUNCH_CLIENTS[name]?.some(item => item.value !== "api");
  if (provider_api_key(name) || (!local_software && !profile?.adapter)) write_launch_field(name, "adapter", "api");
}

/** Whether a profile names local software this computer can start. */
function local_entry_ready(profile) {
  return Boolean(profile?.adapter && profile.adapter !== "api" && (profile.adapter === "antigravity" ? profile.ipc_directory : profile.executable));
}

/** The key saved for a platform's official API address, or an empty string. */
function provider_api_key(name) {
  const base_url = state.launch.api_providers?.[platform_of(name)]?.base_url;
  if (!base_url) return "";
  try { return state.launch.api_keys?.[new URL(base_url).href.replace(/\/+$/, "")] || ""; } catch { return ""; }
}

/**
 * Whether a platform can join a room: its local software is set up or its API has a key. While this page cannot read the
 * computer's settings nothing can be known, and members can still be started by hand, so every platform stays available.
 */
function platform_configured(name) {
  const platform = platform_of(name);
  if (!state.launch.available) return true;
  const profile = state.launch.profiles[platform];
  return local_entry_ready(profile) || Boolean(profile?.adapter === "api" && profile.base_url && profile.api_key_ref) || Boolean(provider_api_key(platform));
}

/** A platform card's model and effort are usage preferences: remember them as that software's default, like other form
 * choices. Instances from presets and a card switched to another entry than the saved one keep theirs to this room. */
function remember_participant_choice(name, field, value) {
  const saved = state.launch.saved_profiles?.[name];
  if (!state.launch.available || platform_of(name) !== name || !saved || saved.adapter !== state.launch.profiles[name].adapter) return;
  if ((saved[field] || "") === value) return;
  if (value) saved[field] = value; else delete saved[field];
  participant_choices_pending = { ...participant_choices_pending, [name]: { ...participant_choices_pending[name], [field]: value } };
  flush_participant_choices();
}

/** Serialize choice saves so a slower earlier save cannot overwrite the latest pick. */
function flush_participant_choices() {
  if (participant_choices_saving || !Object.keys(participant_choices_pending).length) return;
  const patch = participant_choices_pending;
  participant_choices_pending = {};
  participant_choices_saving = local_launch_request("settings", { participant_choices: patch })
    .catch(error => notify("error", t('模型与强度偏好未保存：{value1}', { value1: error.message })))
    .finally(() => { participant_choices_saving = null; flush_participant_choices(); });
}

/** Keep software drafts separate from shared room records and from discussion advancement mode. */
function write_launch_field(name, field, value) {
  if (name === "workspace") state.launch.workspace[field] = value;
  else {
    state.launch.profiles[name] ||= {};
    if (field === "allowed_tools") value = value.split("\n").map(item => item.trim()).filter(Boolean);
    if (["model", "effort"].includes(field)) value = value.trim();
    // Null removes the field, so an expert prompt follows its software's preset again.
    if (value === null) delete state.launch.profiles[name][field];
    else state.launch.profiles[name][field] = value;
    if (field === "adapter" && value === "api") {
      const profile = state.launch.profiles[name], preset = state.launch.api_providers?.[platform_of(name)];
      if (preset && !profile.base_url) Object.assign(profile, { base_url: preset.base_url, api_protocol: preset.api_protocol, model: preset.models[0] || "" });
      for (const key of ["effort", "session_id", "project_access", "project_id", "executable", "source_thread_id", "ipc_directory", "allowed_tools"]) delete profile[key];
    }
    if (field === "base_url") delete state.launch.profiles[name].api_key_ref;
    fill_api_key(state.launch.profiles[name]);
    if (["model", "effort"].includes(field)) remember_participant_choice(name, field, value);
  }
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
  const { local_project, extra_directories, ...workspace } = state.launch.workspace;
  // Extra project directories go with a main one only, and rows left blank are dropped.
  const extras = workspace.cwd ? (extra_directories || []).map(path => path.trim()).filter(Boolean) : [];
  // The paired computer resolves a project id to its own folder; a browser with the local service sends the folder itself.
  return JSON.parse(JSON.stringify({ participants: state.launch.profiles, ...workspace, ...(extras.length ? { extra_directories: extras } : {}),
    ...(!state.launch.available && local_project ? { local_project } : {}), entry: "web" }));
}

/** A new room also carries the optional smart scheduling choice; only a complete, enabled choice is sent. */
function creation_launch_options() {
  const { enabled, provider, model, api_key_ref } = state.launch.scheduler;
  return { ...launch_options(), ...(enabled && provider && model && api_key_ref ? { scheduler: { provider, model, api_key_ref } } : {}),
    ...(state.create_host_workflows ? { host_workflows: true, ...(state.create_host_permissions ? { host_permissions: state.create_host_permissions } : {}) } : {}),
    ...(state.create_api_max_requests !== DEFAULT_API_MAX_REQUESTS ? { api_max_requests: state.create_api_max_requests } : {}),
    ...(state.create_image_generation ? { image_generation: true } : {}) };
}

/** Whether the new room lets its members draw with this computer's image service. */
function write_create_image_generation(value) {
  state.create_image_generation = Boolean(value);
  publish_view();
}

/** How many messages the hosts of two linked rooms may pass each other before the owner speaks again (0 = no limit). */
function write_create_relay_rounds(value) {
  state.create_relay_rounds = value;
  write_create_preferences({ relay_rounds: value });
  publish_view();
}

/** How many model requests one execution of the new room's API members may make (0 = no limit). */
function write_create_api_max_requests(value) {
  state.create_api_max_requests = value;
  write_create_preferences({ api_max_requests: value });
  publish_view();
}

/**
 * Warn once when a member starts working outside every project directory of the room (it joined from another folder):
 * it only reads the room's directories, and its own changes are not compared with the others'. Only a change seen while
 * the room is open warns; the member card names the folder all along.
 */
function warn_outside_members(before, after) {
  for (const [name, profile] of Object.entries(after || {})) {
    if (!profile.outside_directory || before?.[name]?.outside_directory === profile.outside_directory) continue;
    const limit = profile.outside_enforced ? t('它对房间目录只读') : t('已要求它对房间目录只读，但它的软件或权限档位不受程序限制，仍可能修改');
    notify("warning", t('{value1} 在 {value2} 工作，不在本房间的项目目录内：{value3}；它自己目录里的改动不参与冲突提示。', { value1: display_name(name), value2: profile.outside_directory, value3: limit }));
  }
}

/** Give a room created without a project its main directory; it can be set only once. */
async function set_room_project_directory(cwd) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  try { await local_launch_request("room-settings", { room_id, token, cwd }); }
  catch (error) { notify("error", error.message); throw error; }
  await reload_room_models();
}

/** Replace this room's extra project directories (the main one never changes); applies from each member's next execution. */
async function set_room_extra_directories(directories) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  try { await local_launch_request("room-settings", { room_id, token, extra_directories: directories }); }
  catch (error) { notify("error", error.message); throw error; }
  await reload_room_models();
}

/** Change how many model requests one execution of this room's API members may make; applies from the next one. */
async function set_room_api_max_requests(value) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  try { await local_launch_request("room-settings", { room_id, token, api_max_requests: value }); }
  catch (error) { notify("error", error.message); throw error; }
  await reload_room_models();
}

/** Let this room's members draw with this computer's image service, or stop them; applies from each member's next execution. */
async function set_room_image_generation(enabled) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  let result;
  try { result = await local_launch_request("room-settings", { room_id, token, image_generation: Boolean(enabled) }); }
  catch (error) { notify("error", error.message); throw error; }
  update_room_models(room_id, { image_generation: Boolean(result.image_generation) });
}

/**
 * Turn this room's smart scheduling on with `{provider, model, api_key_ref}`, change it, or turn it off with null;
 * the running service picks it up at its next check. Throws the local service's reason.
 */
async function set_room_scheduler(scheduler) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  const value = scheduler && { provider: scheduler.provider, model: scheduler.model, api_key_ref: scheduler.api_key_ref };
  const result = await local_launch_request("room-settings", { room_id, token, scheduler: value });
  update_room_models(room_id, { scheduler: result.scheduler || null });
}

/** Change the saved room choices in place, so open settings stay open instead of the whole section being read again. */
function update_room_models(room_id, fields) {
  if (state.launch.room_models?.room_id !== room_id) return;
  Object.assign(state.launch.room_models, fields);
  publish_view();
}

/** What the new room's host may do by itself: the ticked items as `{ items, room_limit }`, or true / false for all the single switch covered. */
function write_create_host_workflows(value) {
  const permissions = value && typeof value === "object" ? value : null;
  state.create_host_permissions = permissions;
  state.create_host_workflows = permissions ? permissions.items.length > 0 : Boolean(value);
  write_create_preferences({ host_workflows: state.create_host_workflows, ...(permissions ? { host_permissions: permissions } : {}) });
  publish_view();
}

/** Save what this room's host may do by itself: the ticked items as `{ items, room_limit }`, or true / false for the single switch. */
async function set_room_host_workflows(allowed) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  await local_launch_request("room-workflow", { room_id, token, action: "host", ...(allowed && typeof allowed === "object" ? { permissions: allowed } : { allowed: Boolean(allowed) }) });
  await reload_room_models();
}

// Workflows: a host's SKILL.md plus agent cards, kept on this computer and enabled per room.

/** Read the workflow library again after it changed. */
async function reload_workflows() {
  const result = await local_launch_request("workflows", { action: "list" });
  state.launch.workflows = result.workflows || [];
  // The platforms cards may name on that computer; a card naming another cannot join until its platform changes.
  state.launch.card_platforms = result.platforms || [];
  publish_view();
  return state.launch.workflows;
}

/** A workflow card as an expert preset: the card ID is only the workflow's own handle. */
function workflow_preset({ card, requested_access, needs_platform, ...preset }) {
  return preset;
}

/** Bind a workflow to this room after its cards were invited (or brought back); the host reads it from the next task. */
async function enable_room_workflow({ id, members }) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  await local_launch_request("room-workflow", { room_id, token, action: "enable", workflow: { id, members } });
  notify("info", t('工作流已启用，主持人下一次任务起按它组织工作'));
  await reload_room_models();
}

/**
 * Send away (`away`) or bring back (`back`) the members the room's workflow brought; the host and the workflow stay,
 * and each member keeps its session for when it comes back.
 */
async function move_workflow_members(action) {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  await local_launch_request("room-workflow", { room_id, token, action });
  notify("info", action === "away" ? t('工作流已结束，它带来的成员已离开；打 / 选它可请回原成员') : t('工作流成员已请回，接着原来的会话工作'));
  await refresh_room();
  await reload_room_models();
}

/**
 * Reload the room's workflow after it was edited in the library: cards added since it was enabled join as members,
 * ones that left come back, and members of dropped cards stay as ordinary members.
 */
async function sync_room_workflow() {
  const room_id = state.room.id;
  const token = localStorage.getItem(`discuss-access:${room_id}`) || "";
  await local_launch_request("room-workflow", { room_id, token, action: "sync" });
  notify("info", t('工作流已刷新，成员按最新卡片补齐'));
  await refresh_room();
  await reload_room_models();
}

/** Choose whether the new discussion's host writes named follow-ups for each expert between rounds. */
function write_named_followup(value) {
  state.named_followup = Boolean(value);
  write_create_preferences({ named_followup: state.named_followup });
  publish_view();
}

// The server's default round limit; a new room sends its own only when the form changed it.
const DEFAULT_CHAIN_ROUNDS = 10;
state.create_chain_rounds = DEFAULT_CHAIN_ROUNDS;

/** Change the new room's round limit; it is saved right after the room is created. */
function write_create_chain_rounds(value) {
  state.create_chain_rounds = value;
  write_create_preferences({ chain_rounds: value });
  publish_view();
}

/** Choose whether a new room opens a discussion right away; the room itself is always the same collaboration room. */
function write_create_discussion(value) {
  state.create_discussion = Boolean(value);
  if (state.create_discussion) state.create_goal = null;
  write_create_preferences({ drive: state.create_discussion ? "discussion" : state.create_goal ? "goal" : "free" });
  publish_view();
}

/** Turn the new room's goal on (with a patch of its fields) or off; a goal and a discussion exclude each other. */
function write_create_goal(patch) {
  const preferences = state.launch.create_preferences || {};
  state.create_goal = patch === null ? null : { objective: "", max_continues: preferences.goal_max_continues ?? 0,
    max_minutes: preferences.goal_max_minutes ?? 0, idle_seconds: preferences.goal_idle_seconds ?? GOAL_IDLE_SECONDS, ...(state.create_goal || {}), ...patch };
  if (state.create_goal) state.create_discussion = false;
  write_create_preferences({ drive: state.create_goal ? "goal" : state.create_discussion ? "discussion" : "free",
    ...(state.create_goal ? { goal_max_continues: state.create_goal.max_continues, goal_max_minutes: state.create_goal.max_minutes,
      goal_idle_seconds: state.create_goal.idle_seconds } : {}) });
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
  const { enabled = false, provider = "", model = "" } = scheduler;
  write_create_preferences({ scheduler: { enabled, provider, model } });
  publish_view();
}

/** Ask the local service to send the decision model one tiny question; throws its reason on failure. */
async function check_scheduler(scheduler = state.launch.scheduler) {
  const { provider, model, api_key_ref } = scheduler;
  await local_launch_request("scheduler-check", { provider, model, api_key_ref });
}

/** Save a scheduling provider's key (the draft's by default) to the local private store, under its official root; returns its reference. */
async function save_scheduler_api_key(api_key, provider = state.launch.scheduler.provider) {
  const scheduler = state.launch.scheduler;
  const base_url = state.launch.scheduler_providers?.[provider]?.base_url;
  if (!base_url) throw new Error(t('请先选择智能调度供应商'));
  const result = await local_launch_request("api-key", { base_url, api_key });
  state.launch.api_keys = { ...state.launch.api_keys, [base_url]: result.api_key_ref };
  if (state.launch.scheduler === scheduler && state.launch.scheduler_providers[scheduler.provider]?.base_url === base_url) scheduler.api_key_ref = result.api_key_ref;
  publish_view();
  return result.api_key_ref;
}

/** Save the DeepSeek API key API members search with; every room on this computer shares it. */
async function save_search_api_key(api_key) {
  const base_url = "https://api.deepseek.com/v1";
  const result = await local_launch_request("api-key", { base_url, api_key });
  state.launch.api_keys = { ...state.launch.api_keys, [base_url]: result.api_key_ref };
  publish_view();
}

/** Describe effective placement and binding from the same explicit draft sent to the launcher. */
function launch_summary(name) {
  const profile = state.launch.profiles[name] || {};
  if (profile.adapter === "api") {
    const directory = profile.cwd || state.launch.workspace.cwd;
    return { client: `API · ${profile.model || t('待选择模型')}`, session: t('按房间记录接续'), cwd: display_path(directory) || t('未指定，只读写房间消息'),
      project: t('房间上下文'), access: directory ? t('项目{value1}（文件工具，无命令行）', { value1: ACCESS_LABELS[launch_access(name)] || t('只读') }) : t('无项目目录') };
  }
  if (!profile.adapter) return { client: t('尚未选择客户端'), session: t('尚未配置'),
    cwd: t('选择客户端后确定'), project: t('选择客户端后确定') };
  const cli_directory = ["codex_cli", "claude", "antigravity_cli"].includes(profile.adapter);
  const project_name = profile.project_name || state.launch.workspace.discussion_project;
  const project_id = profile.project_id;
  const metadata_only = ["codex_cli", "claude"].includes(profile.adapter);
  const fixed_project = profile.session_id && !metadata_only;
  const project = fixed_project ? t('沿用指定会话的项目') : metadata_only
    ? (project_name ? t('{value1}（任务说明，不切换软件项目）', { value1: project_name }) : t('不指定项目，按工作目录执行'))
    : profile.adapter === "codex" ? [project_name, project_id ? `ID: ${project_id}` : ""].filter(Boolean).join(" · ") || t('无项目聊天')
      : project_id || project_name || t('软件默认项目');
  const directory = profile.cwd || state.launch.workspace.cwd;
  const access = !cli_directory ? t('按 App 权限') : !directory ? t('无项目目录')
    : t('项目{value1}', { value1: ACCESS_LABELS[launch_access(name)] || t('只读') });
  const label = LAUNCH_CLIENTS[name]?.find(item => item.value === profile.adapter)?.label || t('尚未选择客户端');
  const choice = [profile.model, profile.effort && t('{value1} 档', { value1: profile.effort })].filter(Boolean).join(" · ");
  return { client: cli_directory && choice ? `${label} · ${choice}` : label,
    session: profile.session_id ? t('复用指定会话') : t('新建会话'),
    cwd: !cli_directory && profile.session_id ? t('沿用指定会话的目录')
      : display_path(directory) || (cli_directory ? t('本次讨论的私有目录') : t('由 App 项目确定')), project, access };
}


/** Only native CLI adapters and API members expose a project read/write choice in this page. */
function launch_can_set_access(name, launch = state.launch) {
  return ACCESS_CLIENTS.includes(launch.profiles[name]?.adapter);
}

function launch_access(name) {
  return state.launch.profiles[name]?.project_access || state.launch.workspace.project_access || "read";
}

/** Why only 全放开 can be chosen for this software here, or '' when every level it supports is open. */
function full_only_hint(adapter) {
  return state.launch.full_access_only?.includes(adapter) ? t('托管账号的后台环境无法启用这个软件的沙箱，只能使用全放开') : "";
}

/** Classic select options; an empty value inherits the launch-wide setting. */
const ACCESS_LABELS = { read: t('只读'), write: t('可写'), auto: t('自动'), full: t('完全放开') };

// Mirrors access_options in runner/expert_prompts.mjs; agy shows 自动 disabled (no headless auto), API shows 自动 and 全放开
// disabled (no commands), and the shared setting stays 只读 / 可写.
function access_options(value = "", inherit = "", adapter = "") {
  const levels = !inherit ? [["read", t('只读')], ["write", t('可写')]] : [["read", t('只读')], ["write", t('可写')], ["auto", t('自动')], ["full", t('全放开')]];
  const options = [...(inherit ? [["", inherit]] : []), ...levels];
  const disabled = key => (key === "auto" && adapter === "antigravity_cli") || (["auto", "full"].includes(key) && adapter === "api");
  return options.map(([key, label]) => `<option value="${key}" ${(value || (inherit ? "" : "read")) === key ? "selected" : ""}${disabled(key) ? " disabled" : ""}>${label}</option>`).join("");
}

/** Refresh classic readbacks without replacing the input currently being edited. */
function render_launch_summaries() {
  document.querySelectorAll("[data-launch-summary]").forEach(node => {
    const name = node.dataset.launchSummary;
    if (!LAUNCH_CLIENTS[name]) return;
    const summary = launch_summary(name);
    node.textContent = t('{value1} · 工作目录：{value2}（{value3}） · 项目：{value4}', { value1: summary.session, value2: summary.cwd, value3: summary.access, value4: summary.project });
  });
}

/** Consume only the successful launch's transient fields, preserving edits made while waiting. */
function clear_launch_overrides(draft) {
  for (const [name, profile] of Object.entries(draft.participants)) {
    for (const field of ["session_id", "project_access"]) {
      if (state.launch.profiles[name]?.[field] === profile[field]) delete state.launch.profiles[name]?.[field];
    }
  }
  for (const field of ["cwd", "local_project", "discussion_project", "project_access"]) {
    if (state.launch.workspace[field] === draft[field]) delete state.launch.workspace[field];
  }
  if (JSON.stringify(state.launch.workspace.extra_directories) === JSON.stringify(draft.extra_directories)) delete state.launch.workspace.extra_directories;
  render_launch_settings();
  publish_view();
}

/** Browse for a folder on the computer running the local service; resolves to "" when cancelled. */
async function browse_local_directory() {
  return (await local_launch_request("pick-directory", {})).path || "";
}

/** List one page of folders another device may choose on the paired computer: the saved projects, or folders inside them. */
async function list_remote_directories(path = "", offset = 0) {
  return local_launch_request("browse-directory", { path, offset });
}

/** Let the user browse for the project folder on the computer running the local service. */
async function pick_launch_directory() {
  try {
    const path = await browse_local_directory();
    if (path) write_launch_field("workspace", "cwd", path);
  } catch (error) { notify("error", error.message); }
  publish_view();
}

/** Replace the named project directories kept on the computer running the local service. */
async function save_launch_projects(projects) {
  const result = await local_launch_request("projects", { projects });
  state.launch.projects = result.projects;
  publish_view();
}

/** Create a project folder for an account whose projects all sit in its own folder; returns the new project. */
/** A path on the computer as pages show it: the user's own folder is written `~`, so the account name stays off the page. */
function display_path(path) {
  const text = String(path || ""), home = String(state.launch.user_home || "").replace(/[\\/]+$/, "");
  const rest = text.slice(home.length);
  return home && text.toLowerCase().startsWith(home.toLowerCase()) && (!rest || /^[\\/]/.test(rest)) ? `~${rest}` : text;
}

async function create_launch_project(name) {
  const result = await local_launch_request("projects", { create: name });
  state.launch.projects = result.projects;
  publish_view();
  return result.created;
}

/** Take projects off an ordinary account's list; their folders and files stay on the computer. */
async function remove_launch_projects(ids) {
  const result = await local_launch_request("projects", { remove: ids });
  state.launch.projects = result.projects;
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
    notify("info", t('已保存本机软件配置，后续讨论可复用'));
  } catch (error) { notify("error", error.message); }
  render_launch_settings();
  publish_view();
}

/** Load the selected paused room's original connection paths after proving browser ownership. */
async function load_room_configuration() {
  const room_id = state.room.id;
  try {
    const token = localStorage.getItem(`discuss-access:${room_id}`);
    if (!token) throw new Error(t('此浏览器缺少房间凭据，请使用原浏览器或原接入配置'));
    const result = await local_launch_request('room-config', { room_id, token });
    if (state.room?.id === room_id) state.launch.repair = result;
  } catch (error) { if (state.room?.id === room_id) notify("error", error.message); }
  publish_view();
}

/** Edit only the connection field displayed for this room, separately from machine defaults. */
function write_room_connection(name, value) {
  const repair = state.launch.repair;
  if (repair?.room_id !== state.room?.id || !repair.participants[name]) return;
  const profile = repair.participants[name];
  profile[profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable'] = value;
  publish_view();
}

/** Change Codex's entrypoint in this room's draft, retaining its private session binding. */
function write_room_adapter(name, value) {
  const repair = state.launch.repair;
  const profile = repair?.participants[name];
  if (repair?.room_id !== state.room?.id || !['codex', 'codex_cli'].includes(profile?.adapter)
    || !['codex', 'codex_cli'].includes(value)) return;
  profile.adapter = value;
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
  try {
    const token = localStorage.getItem(`discuss-access:${repair.room_id}`);
    if (!token) throw new Error(t('此浏览器缺少房间凭据，请重新核对'));
    const result = await local_launch_request('room-config', { room_id: repair.room_id, token,
      version: repair.version, runtime_revision: repair.runtime_revision, participants });
    if (state.room?.id === repair.room_id) {
      state.launch.repair = result;
      notify('info', result.applied ? t('本场接入设置已保存，服务已采用；可在进度看板重启并核对实际发言。')
        : t('本场接入设置已保存；服务尚未确认采用，请先核对本机服务再重启。'));
      await refresh_room();
    }
  } catch (error) { if (state.room?.id === repair.room_id) notify("error", error.message); }
  publish_view();
}

/** Render the same local setup controls in the classic theme. */
/** Keep the classic form on the same read-only catalog contract as the role cards. */
function render_launch_model_fields(name) {
  const catalog = launch_model_state(name), profile = state.launch.profiles[name] || {};
  if (!catalog.supported) return "";
  const models = catalog.items.map(item => `<option value="${escape_html(item.value)}" ${item.value === (profile.model || "__default__") ? "selected" : ""} ${item.disabled ? "disabled" : ""}>${escape_html(item.label)}</option>`).join("");
  const efforts = [{ label: t('默认强度'), value: "" }, ...(catalog.efforts || []).map(value => ({ label: value, value }))];
  const strength = catalog.efforts?.length ? `<label>${escape_html(t("思考强度"))}<select data-launch-name="${name}" data-launch-field="effort">${efforts.map(item => `<option value="${item.value}" ${item.value === (profile.effort || "") ? "selected" : ""}>${item.label}</option>`).join("")}</select></label>` : "";
  return `<label>${escape_html(t("模型"))}<select data-launch-name="${name}" data-launch-field="model">${models}</select></label><p class="local-note">${escape_html(catalog.loading ? t('正在读取软件模型列表…') : catalog.error || catalog.source)}</p>${strength}`;
}

function render_launch_settings() {
  for (const id of ["local-launch-settings", "new-local-launch-settings"]) {
    const container = element(id);
    if (!container) continue;
    container.hidden = !state.launch.available;
    container.parentElement.hidden = false;
    container.innerHTML = Object.entries(LAUNCH_CLIENTS).map(([name, clients]) => {
      const profile = state.launch.profiles[name] || {};
      const fields = profile.adapter === "antigravity" ? [["ipc_directory", t('Sidecar IPC 目录')]]
        : [["executable", t('原生可执行文件路径')]];
      if (profile.adapter === "codex") fields.push(["source_thread_id", t('来源聊天 ID（新建会话时使用）')]);
      if (profile.adapter === "claude") fields.push(["allowed_tools", t('允许的工具（每行一项，可选）')]);
      fields.push(["session_id", t('复用会话 ID（仅本次，可选）')], ["cwd", t('此 AI 的工作目录（可选）')], ["project_name", t('此 AI 的项目（可选）')]);
      if (["codex", "antigravity", "antigravity_cli"].includes(profile.adapter)) fields.push(["project_id", t('软件中的项目 ID（可选）')]);
      const summary = launch_summary(name);
      const permission = launch_can_set_access(name) ? `<label>${escape_html(t("此 AI 的项目文件"))}<select data-launch-name="${name}" data-launch-field="project_access">${access_options(profile.project_access, t('沿用本次设置'), profile.adapter)}</select></label>` : "";
      return `<fieldset><legend>${name}</legend><p class="local-note" data-launch-summary="${name}">${escape_html(t("{session} · 工作目录：{cwd}（{access}） · 项目：{project}", { session: summary.session, cwd: summary.cwd, access: summary.access, project: summary.project }))}</p><label>${escape_html(t("执行客户端"))}<select data-launch-name="${name}" data-launch-field="adapter"><option value="">${escape_html(t("选择 CLI / App"))}</option>${clients.map(client => `<option value="${client.value}" ${profile.adapter === client.value ? "selected" : ""}>${client.label}</option>`).join("")}</select></label>${render_launch_model_fields(name)}${fields.map(([field, label]) => `<label>${label}<textarea rows="${field === "allowed_tools" ? 2 : 1}" data-launch-name="${name}" data-launch-field="${field}">${escape_html(Array.isArray(profile[field]) ? profile[field].join("\n") : profile[field] || "")}</textarea></label>`).join("")}${permission}</fieldset>`;
    }).join("") + (Object.keys(state.launch.profiles).some(name => launch_can_set_access(name)) ? `<label>${escape_html(t("本次 CLI 项目文件"))}<select data-launch-name="workspace" data-launch-field="project_access">${access_options(state.launch.workspace.project_access)}</select></label>` : "")
      + `<label>${escape_html(t("本次工作目录（可选）"))}<input data-launch-name="workspace" data-launch-field="cwd" value="${escape_html(state.launch.workspace.cwd || "")}"></label><label>${escape_html(t("本次 AI 项目（可选）"))}<input data-launch-name="workspace" data-launch-field="discussion_project" value="${escape_html(state.launch.workspace.discussion_project || "")}"></label>`;
  }
  for (const id of ["local-launch-notice", "new-local-launch-notice"]) {
    if (element(id)) element(id).textContent = [state.launch.error,
      !state.launch.available && state.launch.connect_command ? t('在这台电脑运行 {value1}，使用命令打开的网页完成连接。', { value1: state.launch.connect_command }) : ""].filter(Boolean).join(" ");
  }
  for (const id of ["local-launch-save", "new-local-launch-save"]) if (element(id)) element(id).disabled = !state.launch.available;
}

/** Persist a manually edited summary with the snapshot it was based on. */
async function save_context(event) {
  event.preventDefault();
  await request_json(`/api/rooms/${state.room.id}/state`, { actor: "用户", text: element("state-input").value, brief: element("brief-input").value, until: state.snapshot_id });
  state.context_dirty = false;
  await refresh_room();
  show_toast(t('讨论状态已保存，原始记录保持不变'));
}

/** Copy a participation entrypoint without bundling any discussion context. */
async function copy_context() {
  const members = access_snapshot().members;
  if (members.length === 1) return copy_member_join(members[0].name);
  select_tab("overview");
  show_toast(t('请在接入页选择具体成员的「参与说明」'));
}

/** Copy a bounded background startup contract without starting any external task. */
async function copy_background() {
  return copy_context();
}

/** Read the session revision and bind the write to that session and room. */
async function discussion_control(room_id, action, expected_session_id = null, payload = {}) {
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  const path = `/api/rooms/${room_id}/discussion`;
  const current = await request_json(path);
  if (expected_session_id !== null && current.session?.id !== expected_session_id) {
    throw new Error(t('讨论会话已变化，请刷新后重试'));
  }
  return request_json(path, { ...payload, action, revision: current.revision });
}

/** Pause the current discussion session. */
async function pause_discussion() {
  const room_id = state.room.id, session_id = state.room.session?.id;
  if (!session_id || state.room.session.status !== "active") throw new Error(t('当前没有可暂停的讨论'));
  await discussion_control(room_id, "pause", session_id);
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('讨论已暂停'));
}

/** Resume the paused session after reading its current revision. */
async function restart_discussion() {
  const room_id = state.room.id, session_id = state.room.session?.id;
  if (!session_id || state.room.session.status !== "paused") throw new Error(t('讨论会话已变化，请刷新后重试'));
  await discussion_control(room_id, "resume", session_id);
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('讨论已继续，由主持人检查队列并推进'));
}

/** Skip the selected assignment: the user posts a "skipped" answer for the expert, so the plan moves on to the next one like after any answer. */
async function skip_turn() {
  const room = state.room;
  const turn = room.current_turn;
  const room_id = room.id, session_id = room.session?.id;
  if (!session_id || !turn?.id || !["open", "pending"].includes(turn.status)) throw new Error(t('当前没有可跳过的发言安排，请刷新后核对'));
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  await request_json(`/api/rooms/${room_id}/turns/${turn.id}`, { actor: "用户", status: "cancelled" });
  if (state.room?.id !== room_id || state.room.session?.id !== session_id) return;
  await refresh_room();
  show_toast(t('已跳过本次发言'));
}

/** Turn this free room into a discussion within the given limits and start the run; the local service takes it over at its next check. */
async function start_room_discussion({ goal, max_rounds, max_minutes, named_followup = false }) {
  const room_id = state.room.id, path = `/api/rooms/${room_id}`;
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  const current = await request_json(`${path}/discussion`);
  if (state.room?.id !== room_id) return;
  await request_json(`${path}/discussion`, { action: "start", revision: current.revision,
    ...(goal ? { goal } : {}), limits: { max_rounds, max_minutes }, named_followup });
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('讨论已开启，由主持人推进；需本机接入程序保持运行'));
}

/** Open a goal from the page with the revision just read; the host is woken right away to start on it. */
async function start_room_goal({ objective, max_continues = 0, max_minutes = 0, idle_seconds = GOAL_IDLE_SECONDS }) {
  const room_id = state.room.id, path = `/api/rooms/${room_id}/goal`;
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  const current = await request_json(path);
  if (state.room?.id !== room_id) return;
  await request_json(path, { action: "start", revision: current.revision, objective, max_continues, max_minutes, idle_seconds });
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('Goal 已开启，主持人会持续推进；需本机接入程序保持运行'));
}

/** Change the open goal's objective or budgets. */
async function update_room_goal({ objective, max_continues = 0, max_minutes = 0, idle_seconds = GOAL_IDLE_SECONDS }) {
  const room_id = state.room.id;
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  await request_json(`/api/rooms/${room_id}/goal`, { action: "update", objective, max_continues, max_minutes, idle_seconds });
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('Goal 已更新'));
}

/** Pause, resume or end the open goal; only the owner controls it. */
async function goal_control(action) {
  const room_id = state.room.id;
  if (!has_room_control(room_id)) throw new Error(MANAGEMENT_LOGIN_HINT);
  await request_json(`/api/rooms/${room_id}/goal`, { action });
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast({ pause: t('Goal 已暂停，房间空闲时不再唤醒主持人'), resume: t('Goal 已继续'), clear: t('Goal 已结束，记录保留') }[action]);
}

/** Conclude the discussion and go on as a free room; every message and the conclusion stay. */
async function end_room_discussion() {
  const room_id = state.room.id, session_id = state.room.session?.id;
  if (!session_id) throw new Error(t('当前没有进行中的讨论'));
  await discussion_control(room_id, "end", session_id);
  if (state.room?.id !== room_id) return;
  await refresh_room();
  show_toast(t('讨论已结束，历史记录保留'));
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
  if (!access.can_manage || !member?.available) throw new Error(t('当前浏览器没有此成员可下载的私有配置'));
  download_private_json({ site: room_site(), room: room.id, member: name, token: member_credentials(room.id)[name].token }, `member-${room.id}-${name}.json`);
  notify("info", t('已下载 {value1} 的私有配置', { value1: name }));
}

/** Copy the same room-scoped credential as one line of text for an agent that cannot take a file. */
async function copy_member_access_text(name) {
  const room = state.room, access = access_snapshot();
  const member = access.members.find(item => item.name === name);
  if (!access.can_manage || !member?.available) throw new Error(t('当前浏览器没有此成员可复制的凭证'));
  await copy_text(JSON.stringify({ site: room_site(), room: room.id, member: name, token: member_credentials(room.id)[name].token }));
  notify("info", t('已复制 {value1} 的凭证文本（含 token）', { value1: name }));
}

/** Copy a member-specific entry instruction; only the launch variant carries the credential, never conversation context. */
async function copy_member_join(name, with_credential = false) {
  const room = state.room, access = access_snapshot();
  const member = access.members.find(item => item.name === name);
  if (!access.can_manage || !member) throw new Error(t("请使用房主浏览器选择本房间成员"));
  if (with_credential && (member.access !== "manual" || !member.available)) throw new Error(t("当前浏览器没有此成员可复制的凭证"));
  const params = new URLSearchParams({ participant: name, mode: "cli" });
  const address = `${room_site()}/r/${room.id}?${params}`;
  const skills = `请调用 discuss-participant${room.host === name ? " 和 discuss-host" : ""}。`;
  let instruction;
  if (member.access === "runner") instruction = `${skills}等待本机程序交付有效任务，按 task 中的 access_file 和 execution 凭据操作；房间请求的回答必须绑定本次有效 execution_id。不要另建定时任务；只处理本次有效执行，失效或撤销后停止提交。下载的持久成员私有文件不能替代自动执行凭据。`;
  else if (with_credential) instruction = `${skills}凭证文本在下方：每条 codiscuss 命令都在同一命令内把它原样设为环境变量 DISCUSS_ACCESS（不回显；首条 room view 也要带，否则无法识别你），命令省略 --access-file；先执行 codiscuss room view ${room.id} --site ${room_site()} --as ${name}，随后立即执行 codiscuss member register ${room.id} --site ${room_site()} --as ${name} 完成注册（只需一次，会话 ID 由程序自动附带，不要自己填写），之后命令保持本站点、房间和身份。模型与思考强度在原软件中设置。${MANUAL_TRIGGER_INSTRUCTION}`;
  else instruction = `${skills}使用属于你的私有文件 member-${room.id}-${name}.json，由用户提供它在本机的实际完整路径；先执行 codiscuss room view ${room.id} --site ${room_site()} --as ${name} --access-file "实际完整路径"；随后立即执行 codiscuss member register ${room.id} --site ${room_site()} --as ${name} --access-file "实际完整路径" 完成注册（只需一次，会话 ID 由程序自动附带，不要自己填写），之后命令保持本站点、房间和身份。不要读取或公开文件中的 token；若用户给的是凭证文本而非文件，把它设为环境变量 DISCUSS_ACCESS（不要回显）并省略 --access-file。模型与思考强度在原软件中设置。${MANUAL_TRIGGER_INSTRUCTION}`;
  const credential = with_credential ? `
凭证文本（含 token，仅限你使用）：${JSON.stringify({ site: room_site(), room: room.id, member: name, token: member_credentials(room.id)[name].token })}` : "";
  await copy_text(`请以 ${name} 身份参与房间。
${instruction}
房间入口：${address}
先核对最新阶段、任务和原文编号，再按房间协议参与。${credential}`);
  if (state.room?.id === room.id) notify("info", with_credential ? t("已复制 {name} 的启动指令（含 token）", { name }) : t("已复制 {name} 的参与说明", { name }));
}


/** Supply participation defaults for a new topic. */
function default_experts() { return {}; }

/** Preserve dynamic instance names in the hidden select that backs the visible host controls. */
function render_host_options(id, names, selected) {
  const control = element(id);
  control.innerHTML = ["用户", ...names].map(name => `<option value="${escape_html(name)}">${escape_html(display_name(name))}</option>`).join("");
  control.value = selected;
}

/** Owner stop for a free room: void the member's live execution and queued requests. */
async function interrupt_member(member_id) {
  const room_id = state.room.id;
  const live = live_executions_of(member_id);
  await request_json(`/api/rooms/${room_id}/members/${member_id}/interrupt`, {});
  warn_unstoppable(live);
  if (state.room?.id === room_id) await refresh_room();
}

/** The member's running executions, read before a stop voids them. */
function live_executions_of(member_id) {
  const member = (state.room?.free?.members || []).find(item => item.id === member_id);
  return (state.room?.free?.executions || []).filter(item => item.member === member?.name && ["dispatched", "started"].includes(item.status));
}

/** A stop the runner cannot carry out (a window or App) says at once where to stop it by hand. */
function warn_unstoppable(live) {
  if (live.some(item => item.capabilities?.stoppable === false)) notify("warning", stop_summary(live));
}

/**
 * How a voided execution's stop really went, from what the runner's adapter reported for it (`capabilities`): stopped
 * once the runner ended its software, stopping until it says so, and only voided where it cannot stop the software (a
 * window or App) or never reported (an older runner). See `.dev/docs/Design_适配能力.md`.
 */
function stop_label(execution) {
  if (execution.stop_result === "stopped") return t('已停止');
  if (execution.stop_result === "unconfirmed") return t('停止未确认');
  if (execution.stop_result === "unstoppable") return t('已作废');
  if (!execution.capabilities?.stoppable) return t('已作废');
  return t('正在停止');
}

/** What stopping some executions really did: who is stopping, who may keep generating, and whose software never said. */
function stop_summary(executions) {
  const names = items => [...new Set(items.map(item => display_name(item.member)))].join("、");
  const stopping = executions.filter(item => item.capabilities?.stoppable === true);
  const unstoppable = executions.filter(item => item.capabilities?.stoppable === false);
  const unknown = executions.filter(item => !item.capabilities);
  return [stopping.length ? t('正在停止 {value1}', { value1: names(stopping) }) : "",
    unstoppable.length ? t('{value1} 在自己的窗口或 App 里，本机停不了，仍会继续生成；要立即中断，请到它的窗口或 App 里手动停止', { value1: names(unstoppable) }) : "",
    unknown.length ? t('{value1} 的本次工作已作废', { value1: names(unknown) }) : ""].filter(Boolean).join("；");
}

/** Stop the whole free room: running work and everything still owed end; a new message starts again. */
/** The owner turns off the host's timed check-in shown on the free board. */
async function stop_host_checkin() {
  const room_id = state.room.id;
  await request_json(`/api/rooms/${room_id}/host-checkin`, { off: true });
  if (state.room?.id === room_id) await refresh_room();
}

async function stop_room() {
  const room_id = state.room.id;
  const live = (state.room.free?.executions || []).filter(item => ["dispatched", "started"].includes(item.status));
  await request_json(`/api/rooms/${room_id}/stop`, {});
  // Quiet when everything is stopping; a window or App that keeps generating is said at once.
  if (live.some(item => !item.capabilities?.stoppable)) notify("warning", stop_summary(live));
  if (state.room?.id === room_id) await refresh_room();
}

/**
 * Add the owner's interjection to one running execution; the runner passes it to the member's software at its next
 * check. A retry with the same submission_id is the same interjection.
 */
async function interject_execution(execution_id, text, submission_id) {
  const room_id = state.room.id;
  const result = await request_json(`/api/rooms/${room_id}/executions/${execution_id}`, { action: "interject", text, submission_id });
  if (state.room?.id === room_id) await refresh_room();
  return result.interjection;
}

/** Answer a manual member's waiting retry: deliver now, or stop so the runner fails the execution. */
async function retry_delivery({ execution_id, action }) {
  const room_id = state.room.id;
  await request_json(`/api/rooms/${room_id}/executions/${execution_id}`, { action });
  if (state.room?.id === room_id) await refresh_room();
}

/** Take back the user's message, its text returning to an empty input for editing; once members started on it, see `stop_and_rewind`. */
async function retract_message(message_id) {
  const room_id = state.room.id;
  const message = state.messages.find(item => item.id === message_id);
  let result;
  try { result = await request_json(`/api/rooms/${room_id}/messages/${message_id}/retract`, {}); }
  catch (error) {
    if (error.status !== 409) throw error;
    result = await stop_and_rewind(room_id, message_id, error);
  }
  if (state.room?.id !== room_id) return;
  await refresh_room();
  if (state.room?.id !== room_id || element("message-input").value.trim() || state.attachment_drafts.length) return;
  await restore_taken_back(room_id, message, result.text);
}

/**
 * A sent message's files and reply as composer drafts, for sending it again. The site keeps the files with the old
 * message, so they are read from it and become new drafts that upload again; each keeps the placeholder `text` has for it.
 */
async function message_draft_parts(room_id, message, text) {
  const files = await Promise.all((message?.attachments || []).map(async (file) => {
    const bytes = await read_room_file(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(file.id)}/content`);
    return { number: file.number, file: new File([bytes], file.file_name, { type: file.content_type || "" }) };
  }));
  const drafts = files.map(({ number, file }) => {
    const draft = { id: new_submission_id(), file, preview_url: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : "", uploaded: null, actor: null };
    draft.placeholder = [`[图片 #${number}]`, `[文件 #${number}]`].find(placeholder => text.includes(placeholder));
    return draft;
  });
  let reply = null;
  if (message?.reply_to) {
    const quoted = state.messages.find(item => item.id === message.reply_to)
      || await request_json(`/api/rooms/${room_id}/messages/${message.reply_to}`).catch((error) => { release_files(drafts); throw error; });
    reply = { id: quoted.id, label: t('正在回复 #{value1} · {value2}', { value1: quoted.id, value2: display_name(quoted.author) }) };
  }
  return { drafts, reply };
}

/** Fill the composer with drafts from `message_draft_parts`; the files then take the room's current numbers. */
function fill_composer_parts(text, { drafts, reply }) {
  fill_composer(text, drafts, reply);
  renumber_placeholders(null);
  preupload_drafts(drafts);
  publish_view();
}

/** Put a taken-back message in the empty composer as it was sent: its text, its files and the message it replied to. */
async function restore_taken_back(room_id, message, text) {
  let parts = { drafts: [], reply: null };
  try { parts = await message_draft_parts(room_id, message, text); }
  catch (error) { notify("warning", t('撤回的消息里有附件或引用未能放回输入框：{value1}', { value1: error.message })); }
  if (state.room?.id !== room_id || element("message-input").value.trim() || state.attachment_drafts.length) { release_files(parts.drafts); return; }
  // A reply the owner already picked meanwhile stays.
  if (state.reply_to) parts.reply = { id: state.reply_to, label: element("reply-label").textContent };
  fill_composer_parts(text, parts);
}

/**
 * Take back the latest message members already started on, like interrupting a turn: stop that work and rewind to just
 * before the message, cutting their sessions. Reads the rewind plan itself and sends its revision; anything wider (a later
 * message, or running work on other messages) is refused with the site's reason, which points to editing.
 */
async function stop_and_rewind(room_id, message_id, refusal) {
  const [plan, room] = await Promise.all([rewind_plan(message_id), request_json(`/api/rooms/${room_id}`)]);
  const own = new Set(room.free.requests.filter(item => item.message_id === message_id && item.execution_id).map(item => item.execution_id));
  const touched = plan.members.filter(member => member.executions.length);
  if (plan.messages !== 1 || touched.some(member => member.executions.some(id => !own.has(id)))) throw refusal;
  const taken = new Set(touched.flatMap(member => member.executions));
  const live = room.free.executions.filter(item => taken.has(item.id) && ["dispatched", "started"].includes(item.status));
  const text = state.messages.find(message => message.id === message_id)?.text ?? "";
  await request_json(`/api/rooms/${room_id}/rewind`, { message_id, revision: plan.revision });
  const kept = touched.filter(member => member.session === "kept").map(member => display_name(member.name));
  if (live.length) notify("info", t('已撤回；{value1}', { value1: stop_summary(live) })
    + t('{value1}；文件改动不会恢复', { value1: kept.length ? t('；{value1} 的会话未回退，仍记得这条消息', { value1: kept.join("、") }) : "" }));
  return { text };
}

/** Take back the owner's latest message, after a send still in flight is saved; the site refuses once a member started on it. */
async function retract_latest() {
  const room_id = state.room?.id;
  const last = send_queue.findLast(job => job.room_id === room_id);
  if (last) {
    try { await last.done; } catch { return; }
    if (state.room?.id !== room_id) return;
  }
  const message = state.messages.findLast(item => item.author === "用户" && !item.withdrawn);
  if (message) await retract_message(message.id);
}

/** What editing a message would take back, with the revision the rewind must carry. */
function rewind_plan(message_id) {
  return request_json(`/api/rooms/${state.room.id}/rewind?message_id=${message_id}`);
}

/** Return the room to just before a message, then send its edited text in its place through the normal composer. */
async function rewind_and_send({ message_id, revision, text }) {
  if (element("message-input").value.trim() || state.attachment_drafts.length) throw new Error(t('输入框里还有草稿，请先发送或清空后再编辑这条消息'));
  const room_id = state.room.id;
  // The edit keeps the message's files and reply; they are read first, so a failed read leaves the room as it was.
  const parts = await message_draft_parts(room_id, state.messages.find(item => item.id === message_id), text);
  try { await request_json(`/api/rooms/${room_id}/rewind`, { message_id, revision }); }
  catch (error) { release_files(parts.drafts); throw error; }
  if (state.room?.id !== room_id) { release_files(parts.drafts); return; }
  fill_composer_parts(text, parts);
  await send_message({ preventDefault() {} });
}

/**
 * Cut a room backup down to a fork at one message: history up to it (without retracted or rewound messages), the records
 * on that history, and a new room identity. Also returns, per member name, the executions the fork leaves out: any that
 * touched a later or withdrawn message, or was still running, so each local session branches before them.
 */
function fork_snapshot(snapshot, message_id, room_id, now = new Date().toISOString()) {
  const tables = snapshot.tables;
  const cutoff_message = tables.messages.find(row => row.id === message_id);
  const cutoff_time = cutoff_message ? Date.parse(cutoff_message.created_at) : Infinity;
  const withdrawn = new Set((tables.message_withdrawals || []).map(row => row.message_id));
  const kept = new Set(tables.messages.filter(row => row.id <= message_id && !withdrawn.has(row.id)).map(row => row.id));
  const on_kept = rows => (rows || []).filter(row => kept.has(row.message_id));
  const names = new Map((tables.room_members || []).map(member => [member.id, member.name]));
  const executions = {};
  for (const request of tables.member_requests || []) {
    const left_out = !kept.has(request.message_id) || (request.answer_id && !kept.has(request.answer_id)) || request.status === "delivering";
    if (request.execution_id && left_out) (executions[names.get(request.member_id)] ||= []).push(request.execution_id);
  }
  const [room] = tables.rooms;
  const covered = until => (until || 0) <= message_id;
  const before_cutoff = timestamp => !timestamp || Number.isNaN(Date.parse(timestamp)) || Date.parse(timestamp) <= cutoff_time;
  const sessions = (tables.discussion_sessions || []).filter(row => (row.started_message_id || 0) <= message_id);
  const session_ids = new Set(sessions.map(row => row.id));
  const source_by_plan = new Map((tables.task_message_sources || []).map(row => [row.session_request_id, row]));
  const candidate_requests = (tables.session_requests || []).filter(row => {
    if (!session_ids.has(row.session_id)) return false;
    const source = source_by_plan.get(row.id);
    if (source) return kept.has(source.message_id);
    return Date.parse(row.created_at) <= cutoff_time;
  });
  const candidate_request_ids = new Set(candidate_requests.map(row => row.id));
  const candidate_sources = (tables.task_message_sources || []).filter(row => session_ids.has(row.session_id)
    && candidate_request_ids.has(row.session_request_id));
  const retained_source_messages = new Set(candidate_sources.map(row => row.message_id));
  for (const source of tables.task_message_sources || []) {
    if (kept.has(source.message_id) && !retained_source_messages.has(source.message_id)) kept.delete(source.message_id);
  }
  const original_member_requests = new Map((tables.member_requests || []).map(row => [row.id, row]));
  const stopped_session_requests = new Set(candidate_requests.filter(row => ["open", "queued"].includes(row.status))
    .map(row => row.member_request_id).filter(Boolean));
  const member_requests = on_kept(tables.member_requests).map(row => row.answer_id && !kept.has(row.answer_id)
    ? { ...row, status: "cancelled", answer_id: null }
    : stopped_session_requests.has(row.id) ? { ...row, status: "cancelled" } : row);
  const kept_member_requests = new Set(member_requests.map(row => row.id));
  const session_requests = candidate_requests.map(row => {
    const original_request = original_member_requests.get(row.member_request_id);
    const answer_after_cutoff = original_request?.answer_id && !kept.has(original_request.answer_id);
    return { ...row, member_request_id: kept_member_requests.has(row.member_request_id) ? row.member_request_id : null,
      status: ["open", "queued"].includes(row.status) || answer_after_cutoff ? "cancelled" : row.status };
  });
  const session_request_ids = new Set(session_requests.map(row => row.id));
  const task_message_sources = candidate_sources.filter(row => kept.has(row.message_id)
    && session_request_ids.has(row.session_request_id)).map(row => ({ ...row,
    cause_message_id: kept.has(row.cause_message_id) ? row.cause_message_id : null,
    cause_request_id: kept_member_requests.has(row.cause_request_id) ? row.cause_request_id : null }));
  const session_tables = Object.fromEntries(["session_state", "session_limits", "session_round_budgets", "session_options", "session_pauses"]
    .map(name => [name, (tables[name] || []).filter(row => session_ids.has(row.session_id))]));
  session_tables.session_state = session_tables.session_state.map(row => ({ ...row,
    read_until: Math.min(row.read_until || 0, message_id), held_since: 0 }));
  session_tables.session_pauses = session_tables.session_pauses.map(row => ({ ...row, paused_at: 0 }));
  const conclusions = (tables.discussion_conclusions || []).filter(row => session_ids.has(row.session_id)
    && before_cutoff(row.concluded_at)).map(row => covered(row.state_until)
    ? row : { ...row, state: "", state_until: 0, brief: "" });
  const truncated_sessions = sessions.map(row => {
    const ended_after_cutoff = !row.ended_message_id || row.ended_message_id > message_id;
    return { ...row, status: "concluded", ended_message_id: ended_after_cutoff ? message_id : row.ended_message_id };
  });
  for (const session of truncated_sessions) {
    if (conclusions.some(row => row.session_id === session.id)) continue;
    const original_session = sessions.find(row => row.id === session.id);
    if (!original_session || !(["active", "paused"].includes(original_session.status) || !original_session.ended_message_id
      || original_session.ended_message_id > message_id)) continue;
    const limit = session_tables.session_limits.find(row => row.session_id === session.id) || {};
    const session_end = session.ended_message_id || message_id;
    const state_until = covered(room.state_until) && room.state_until > session.started_message_id
      && room.state_until <= session_end ? room.state_until : 0;
    const brief = (tables.room_briefs || []).find(row => covered(row.until) && before_cutoff(row.updated_at)
      && row.until > session.started_message_id && row.until <= session_end);
    conclusions.push({ session_id: session.id, room_id: room_id, stop_reason: "forked", max_rounds: limit.max_rounds || 0,
      max_minutes: limit.max_minutes || 0, brief: brief?.text || "", state: state_until ? room.state_text : "",
      state_until, concluded_at: now });
  }
  return { executions, body: { format: snapshot.format, version: snapshot.version, tables: { ...tables,
    rooms: [{ ...room, id: room_id, title: `${room.title}（分支）`, created_at: now,
      ...(covered(room.state_until) ? {} : { state_text: "", state_until: 0 }) }],
    room_directory: (tables.room_directory || []).map(row => ({ ...row, archived: 0 })),
    room_creations: [], room_folder_assignments: [], topic_folders: [], message_withdrawals: [],
    messages: tables.messages.filter(row => kept.has(row.id)),
    message_details: on_kept(tables.message_details), message_summaries: on_kept(tables.message_summaries),
    message_timings: on_kept(tables.message_timings), attachments: on_kept(tables.attachments),
    member_suggestions: on_kept(tables.member_suggestions), member_recommendations: on_kept(tables.member_recommendations),
    // A request answered after the fork point is unanswered in the fork.
    member_requests,
    discussion_sessions: truncated_sessions,
    discussion_conclusions: conclusions,
    session_requests,
    task_message_sources,
    ...session_tables,
    scheduler_decisions: (tables.scheduler_decisions || []).filter(row => !row.after_message_id || kept.has(row.after_message_id)),
    room_briefs: (tables.room_briefs || []).filter(row => covered(row.until) && before_cutoff(row.updated_at)),
    room_members: (tables.room_members || []).map(row => ({ ...row, read_until: Math.min(row.read_until || 0, message_id) })) } } };
}

/** Copy the fork's attachment files from the source room to their new IDs; returns how many could not be copied. */
async function copy_fork_files(source_id, room_id, token, mapping) {
  let missing = 0;
  for (const [old_id, new_id] of Object.entries(mapping)) {
    try {
      const original = await read_room_file(`/api/rooms/${encodeURIComponent(source_id)}/attachments/${encodeURIComponent(old_id)}/content`);
      await post_room_file(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(new_id)}/import`, original, token);
    } catch { missing++; }
  }
  return missing;
}

/**
 * Branch the room into a new one at a message, as Codex branches a chat: the new room keeps the history up to it, each
 * local member continues its own session from there, and the members come back with new credentials. The source room
 * and its sessions do not change; files are shared, since both rooms work in the same project directories.
 */
async function fork_room(message_id) {
  const source = state.room;
  if (!has_room_control(source.id)) throw new Error(t('此浏览器缺少房间控制凭据，请使用创建房间的浏览器或登录管理员'));
  // Without the room credential the local service or the relay acts with this browser's administrator authority.
  const source_token = localStorage.getItem(`discuss-access:${source.id}`) || "";
  const snapshot = await request_json(`/api/rooms/${encodeURIComponent(source.id)}/backup`);
  const room_id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const { body, executions } = fork_snapshot(snapshot, message_id, room_id);
  const token = crypto.randomUUID() + crypto.randomUUID();
  const result = await request_json("/api/rooms/import", body, token);
  save_room_credentials({ id: result.id }, token);
  const problems = [];
  const missing = await copy_fork_files(source.id, result.id, token, result.attachments);
  if (missing) problems.push(t('{value1} 个附件未能复制', { value1: missing }));
  if (source.folder_id) await request_json(`/api/rooms/${result.id}/folder`, { actor: "用户", folder_id: source.folder_id })
    .catch(error => problems.push(t('未放入原文件夹：{value1}', { value1: error.message })));
  const local = state.launch.available
    ? await local_launch_request("room-fork", { room_id: result.id, token, source_room_id: source.id, source_token, executions })
      .catch(error => { problems.push(t('成员会话未分叉：{value1}', { value1: error.message })); return null; })
    : (problems.push(t('未连接本机服务，本机成员会话未分叉')), null);
  // The directory learns of the new room before it can be opened.
  await refresh_room();
  await select_room(result.id);
  const registered = new Set((local?.members || []).filter(member => member.status !== "failed").map(member => member.name));
  for (const member of (state.room.free?.members || []).filter(item => item.status === "away")) {
    if (member.access === "runner" && !registered.has(member.name)) continue;
    // The fork's own notice below sums up who continues and who starts anew, so automatic members rejoin silently;
    // a manual member still says it must register again with its new start command.
    try { await change_member({ member_id: member.id, name: member.name, action: "rejoin", quiet: member.access === "runner" }); }
    catch (error) { problems.push(t('{value1} 未能请回：{value2}', { value1: member.name, value2: error.message })); }
  }
  const fresh = (local?.members || []).filter(member => member.status === "fresh").map(member => member.name);
  const failed = (local?.members || []).filter(member => member.status === "failed").map(member => `${member.name}（${member.error}）`);
  if (failed.length) problems.push(t('未分叉、保持离开：{value1}', { value1: failed.join("、") }));
  const done = t('已从 #{value1} 分支出新房间，原房间不变', { value1: message_id });
  // A partial fork says both the result and the problems in one warning instead of a separate notice.
  if (problems.length) notify("warning", t('{value1}，但{value2}', { value1: done, value2: problems.join("；") }));
  else notify("info", `${done}${fresh.length ? t('；{value1} 将以新会话开始', { value1: fresh.join("、") }) : ""}。`);
  publish_view();
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

/** Read what the decision model was given for one decision (state and questions), for the card's input view. */
async function load_decision_input(decision_id) {
  return request_json(`/api/rooms/${state.room.id}/scheduler-decisions/${decision_id}`);
}

/** Render independently configurable expert modes without changing identity names. */
function render_expert_inputs(container_id, experts) {
  element(container_id).innerHTML = [...new Set([...Object.keys(default_experts()), ...Object.keys(experts).filter(platform_of)])].map((name) =>
    `<label>${name}<select data-expert="${name}" aria-label="${escape_html(t("{name} 参与方式", { name: name }))}"><option value="">${escape_html(t("不参与"))}</option><option value="cli">${escape_html(t("本机唤醒"))}</option><option value="manual">${escape_html(t("手动接入"))}</option></select></label>`).join("");
  element(container_id).querySelectorAll("[data-expert]").forEach((control) => { control.value = experts[control.dataset.expert] || ""; });
}

/** Read only selected experts and their declared participation modes. */
function read_expert_inputs(container_id) {
  return Object.fromEntries(Array.from(element(container_id).querySelectorAll("[data-expert]"))
    .filter((control) => control.value).map((control) => [control.dataset.expert, control.value]));
}

/** Fill the topic edit draft from the room, preserving an unsaved draft. */
function render_topic() {
  const room = state.room;
  if (state.topic_dirty) return;
  for (const field of ["title", "goal", "focus", "user_request", "background", "boundaries"]) element(`topic-${field}-input`).value = room[field] || "";
  for (const key of ["max_rounds", "max_minutes"]) {
    const input = element(`topic-limit-${key}-input`);
    input.value = room.limits?.[key] || "";
    input.disabled = ["active", "paused"].includes(room.session?.status);
  }
}

/** Describe a pending turn by how its expert takes part. */
function turn_label(turn, room) {
  if (!turn) return t('尚未安排');
  if (turn.status === "pending") return room.experts[turn.expert] === "cli" ? t('待处理（本地 CLI）') : t('待处理');
  return TURN_LABELS[turn.status];
}

/** Explain only the action supported by the current phase and participation mode. */
function turn_guidance(turn, room) {
  if (["paused", "concluded"].includes(room.phase)) return t('话题已暂停或收束，原安排保留。恢复阶段后再通知或录入回答。');
  if (room.experts[turn?.expert] === "cli") return t('已接入的本地专家可自行检查安排，无需逐轮通知；尚未接入时先完成启动。此状态不表示后台任务已运行，只有实际联系后才确认已通知。');
  return t('手动专家需在其原会话中触发。复制通知不表示送达，实际联系后再确认已通知。');
}

/** Save owner-edited topic data; the host and members change only through member management. */
async function save_topic(event) {
  event.preventDefault();
  const room = state.room;
  const payload = { actor: "用户" };
  if (!["active", "paused"].includes(room.session?.status)) payload.limits = read_limits("topic");
  for (const field of ["title", "goal", "focus", "user_request", "background", "boundaries"]) payload[field] = element(`topic-${field}-input`).value;
  await request_json(`/api/rooms/${room.id}/topic`, payload);
  if (state.room?.id === room.id) { state.topic_dirty = false; await refresh_room(); }
  show_toast(t('话题资料已保存'));
}

/** Bind the topic workflow separately from existing chat controls. */
function bind_host_controls() {
  element("edit-host-brief").addEventListener("click", () => select_tab("discussion"));
  element("new-local-launch-save").addEventListener("click", () => run_action(save_launch_defaults));
  element("topic-form").addEventListener("submit", (event) => run_action(() => save_topic(event)));
  element("topic-form").addEventListener("input", () => { state.topic_dirty = true; });
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
    if (button.dataset.copyMessage) run_action(() => copy_text(`${room_site()}/r/${state.room.id}/messages/${button.dataset.copyMessage}`));
    if (button.dataset.reply) {
      state.reply_to = Number(button.dataset.reply);
      element("reply-label").textContent = t('正在回复 #{value1} · {value2}', { value1: state.reply_to, value2: display_name(button.dataset.author) });
      element("reply-preview").hidden = false;
      element("message-input").focus();
    }
  });
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => select_tab(tab.dataset.tab)));
  // Rendered Markdown code blocks anywhere on the page (cards, previews, workflow skills) copy their own text.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-code]");
    if (button) copy_text(button.parentElement.querySelector("pre")?.textContent || "").catch((error) => show_toast(error.message, true));
  });
}

/** Show a targeted confirmation without changing the current channel or draft. */
async function open_room_management(id, action) {
  if (action === "backup") return backup_room(id);
  if (["up", "down"].includes(action)) return move_channel({ id, direction: action === "up" ? -1 : 1 });
  const room = state.rooms.find((item) => item.id === id);
  if (!room) return;
  state.management = { id, action };
  element("manage-title").textContent = { rename: t('重命名频道'), archive: t('存档频道'), restore: t('恢复频道'), delete: t('删除频道') }[action];
  element("manage-description").textContent = action === "delete" ? t('永久删除「{value1}」及其 {value2} 条消息、共识和发言安排。无法撤销。', { value1: room.title, value2: room.message_count }) :
    action === "archive" ? t('存档「{value1}」后移入已存档列表，保留记录并暂停未收束的讨论。', { value1: room.title }) : action === "restore" ? t('恢复「{value1}」到讨论列表；讨论阶段仍保持暂停或收束。', { value1: room.title }) : t('修改名称不会影响记录和阅读地址。');
  element("manage-input-label").hidden = action !== "rename";
  element("manage-input").value = action === "rename" ? room.title : "";
  element("manage-input").required = action === "rename";
  element("manage-submit").textContent = action === "delete" ? t('永久删除') : t('确认');
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
  event.stopPropagation();
  if (event.pointerType === "touch") return hold_directory_drag(event, handle, row);
  event.preventDefault();
  begin_directory_drag(event, handle, row);
}

/** Start a touch drag only after a still hold, so swiping over a grip or folder heading scrolls. */
function hold_directory_drag(event, handle, row) {
  const same = (other) => other.pointerId === event.pointerId;
  const release = () => {
    window.clearTimeout(timer);
    document.removeEventListener("pointermove", watch);
    document.removeEventListener("pointerup", stop);
    document.removeEventListener("pointercancel", stop);
  };
  const watch = (move) => { if (same(move) && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) > DIRECTORY_TOUCH_SLOP) release(); };
  const stop = (end) => { if (same(end)) release(); };
  const timer = window.setTimeout(() => {
    release();
    if (state.dragged_room || handle.disabled || !handle.isConnected) return;
    begin_directory_drag(event, handle, row);
    handle.dataset.suppressDragClick = "true";
    render_directory_drag_preview(state.dragged_room, event);
  }, DIRECTORY_TOUCH_HOLD_MS);
  document.addEventListener("pointermove", watch);
  document.addEventListener("pointerup", stop);
  document.addEventListener("pointercancel", stop);
}

/** Keep an active touch drag from scrolling the page or opening the long-press menu. */
function block_directory_gesture(event) {
  event.preventDefault();
  if (event.type === "contextmenu") event.stopPropagation();
}

/** Capture the pointer and track the drag until it is dropped or cancelled. */
function begin_directory_drag(event, handle, row) {
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
  document.addEventListener("touchmove", block_directory_gesture, { capture: true, passive: false });
  document.addEventListener("contextmenu", block_directory_gesture, true);
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
  document.removeEventListener("touchmove", block_directory_gesture, true);
  document.removeEventListener("contextmenu", block_directory_gesture, true);
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
    "refresh": refresh_room, "cancel-reply": cancel_reply, "go-context": () => select_tab("discussion"),
    "copy-reading": () => copy_text(`${room_site()}/r/${state.room.id}`),
    "backup-room": () => backup_room(),
    "copy-reading-secondary": () => copy_text(`${room_site()}/r/${state.room.id}`),
    "copy-cli": () => copy_context(), "copy-background": copy_background };
  Object.entries(actions).forEach(([id, action]) => element(id).addEventListener("click", () => run_action(action)));
  const forms = { "message-form": send_from_composer, "room-form": submit_room, "state-form": save_context };
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
    element("mention-filter").textContent = `@ ${element("author-select").value === "用户" ? t('提到我') : element("author-select").value}`;
    if (state.mention_only) { state.page = 1; run_action(refresh_room); }
  });
  element("state-input").addEventListener("input", () => { state.context_dirty = true; });
  element("brief-input").addEventListener("input", () => { state.context_dirty = true; });
  element("message-input").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); element("message-form").requestSubmit(); }
  });
}

/** Coalesce bursts and retain changes that arrive during a previous refresh. */
function queue_live_refresh(full = true) {
  live_updates.dirty = true;
  live_updates.full ||= full;
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
  const full = live_updates.full;
  live_updates.full = false;
  live_updates.running = true;
  try {
    // A refresh started meanwhile would discard the opening read, flashing an empty room before reading it all again.
    while (state.opening) await state.opening.catch(() => {});
    await refresh_room({ room: full });
    if (full && state.observed_until !== null) { state.observed_until = null; publish_view(); }
    if (full) end_resuming();
  } catch (error) {
    end_resuming();
    console.warn("refresh failed", error);
    if (state.reconnecting) show_toast(t('仍未连接：{value1}', { value1: error.message }), true);
    set_connection(false);
  }
  finally {
    live_updates.running = false;
    if (live_updates.dirty) queue_live_refresh(false);
  }
}

/** Keep a low-frequency safety read, or retain the original polling when push is unavailable. */
function arm_update_poll() {
  clearTimeout(live_updates.poll_timer);
  if (!live_updates.enabled || document.hidden) return;
  live_updates.poll_timer = setTimeout(() => {
    poll_live_updates();
    arm_update_poll();
  }, live_updates.connected && state.connected ? REFRESH_INTERVAL_MS : FALLBACK_REFRESH_INTERVAL_MS);
}

/**
 * Polls check revisions before loading history; unchanged working rooms read only live progress.
 * A change elsewhere refreshes just the room list. The safety interval still catches missed invalidations.
 * A site without revisions is read in full as before.
 */
async function poll_live_updates() {
  if (computer_rooms_only() && !state.remote_rooms) return connect_computer_rooms();
  if (!live_updates.source && typeof EventSource !== "undefined") start_live_updates({ refresh: false });
  const room_id = state.room?.id || "";
  const working = (state.room?.free?.members || []).some((member) => WORKING_STATUSES.includes(member.execution?.status));
  if (!state.connected || Date.now() - live_updates.refreshed_at >= SAFETY_REFRESH_MS) return queue_live_refresh();
  let revisions;
  try { revisions = await request_json(`/api/revisions?rooms=${encodeURIComponent(room_id)}`); }
  catch { return queue_live_refresh(); }
  const [site, room] = live_updates.revisions.split(":");
  const next_room = `${room_id}=${revisions.rooms?.[room_id] ?? ""}`;
  if (`${revisions.site}` === site && next_room === room) {
    if (working) await refresh_live_progress(room_id, revisions.rooms[room_id]);
    return;
  }
  live_updates.revisions = `${revisions.site}:${next_room}`;
  queue_live_refresh(next_room !== room);
}

/** Merge progress only into matching executions; a concurrent state change or navigation requires a fresh snapshot. */
async function refresh_live_progress(room_id, revision) {
  const version = state.refresh_version;
  let progress;
  try { progress = await request_json(`/api/rooms/${room_id}/progress`); }
  catch { return queue_live_refresh(); }
  if (state.room?.id !== room_id || state.refresh_version !== version) return;
  if (progress.revision !== revision) return queue_live_refresh();
  const members = state.room.free.members;
  const live = members.map(member => member.execution).filter(execution => WORKING_STATUSES.includes(execution?.status));
  if (live.length !== progress.executions.length || live.some(execution =>
    !progress.executions.some(next => next.id === execution.id && next.status === execution.status))) return queue_live_refresh();
  const updates = new Map(progress.executions.map(execution => [execution.id, execution]));
  const merge = execution => updates.has(execution?.id) ? { ...execution, ...updates.get(execution.id) } : execution;
  state.room = { ...state.room, free: { ...state.room.free,
    members: members.map(member => ({ ...member, execution: merge(member.execution) })),
    executions: (state.room.free.executions || []).map(merge) } };
  cache_room_entry(room_views, room_id, state.room);
  publish_view();
}

/** Subscribe once per visible page; every connection fetches changes missed while disconnected. */
function start_live_updates({ refresh = true } = {}) {
  // A share page has nothing live behind it.
  if (SHARE || document.hidden) return;
  live_updates.enabled = true;
  if (!live_updates.source && typeof EventSource !== "undefined" && (state.remote_rooms || !computer_rooms_only())) {
    const source = state.remote_rooms ? relay_event_source() : new EventSource("/api/updates");
    live_updates.source = source;
    source.addEventListener("open", () => {
      if (live_updates.source !== source) return;
      live_updates.connected = true;
      arm_update_poll();
    });
    source.addEventListener("ready", () => {
      if (live_updates.source === source) queue_live_refresh();
    });
    source.addEventListener("change", event => {
      if (live_updates.source !== source) return;
      let rooms;
      try { rooms = JSON.parse(event?.data || "{}").rooms; } catch { /* Old or global notifications invalidate everything. */ }
      queue_live_refresh(!Array.isArray(rooms) || !rooms.length || rooms.includes(state.room?.id));
    });
    source.addEventListener("error", () => {
      if (live_updates.source !== source) return;
      const was_connected = live_updates.connected;
      live_updates.connected = false;
      // A closed stream is never retried by the browser; the next poll opens a new one.
      if (source.readyState === EventSource.CLOSED) live_updates.source = null;
      if (was_connected) arm_update_poll();
    });
  }
  arm_update_poll();
  if (refresh) queue_live_refresh();
}

/** Reopen the update stream and read the site now; used by the footer retry and, quietly, by automatic reconnects. */
async function reconnect_live_updates({ automatic = false } = {}) {
  // A share page has nothing live behind it.
  if (SHARE || document.hidden) return;
  state.reconnecting = !automatic;
  publish_view();
  live_updates.source?.close();
  live_updates.source = null;
  live_updates.connected = false;
  start_live_updates();
}

/** Release streams and scheduled reads while hidden or leaving the page. */
function stop_live_updates() {
  state.observed_until ??= Date.now();
  live_updates.enabled = false;
  live_updates.source?.close();
  live_updates.source = null;
  live_updates.connected = false;
  clearTimeout(live_updates.timer);
  clearTimeout(live_updates.poll_timer);
  live_updates.timer = null;
  live_updates.poll_timer = null;
}

let resuming_timer = null;
/** After a long stay in the background, show the opening load instead of old cards until the room is read again. */
let resuming_show_timer = null, resuming_awaited = false;
function begin_resuming() {
  if (!state.room || state.observed_until === null || Date.now() - state.observed_until < RESUME_LOADING_AFTER_MS) return;
  resuming_awaited = true;
  clearTimeout(resuming_show_timer);
  clearTimeout(resuming_timer);
  // Shown only if the read is still out after RESUME_LOADING_SHOW_MS: a fast read swaps the cards with no load in between.
  resuming_show_timer = setTimeout(() => {
    if (!resuming_awaited) return;
    state.resuming = true;
    resuming_timer = setTimeout(end_resuming, RESUME_LOADING_MAX_MS);
    publish_view();
  }, RESUME_LOADING_SHOW_MS);
}

/** Show the cards again: the room has been read, the read failed, or it took too long. */
function end_resuming() {
  resuming_awaited = false;
  clearTimeout(resuming_show_timer);
  clearTimeout(resuming_timer);
  if (!state.resuming) return;
  state.resuming = false;
  publish_view();
}

/** Initialize forms and the shared discussion controller. */
async function initialize() {
  if (SHARE) return initialize_share();
  render_identities();
  bind_delegated_actions();
  bind_directory_controls();
  bind_controls();
  bind_attachment_controls();
  bind_host_controls();
  document.addEventListener("focusin", event => {
    if (event.target.dataset?.launchField === "model") load_launch_models(event.target.dataset.launchName);
  });
  document.addEventListener("input", event => {
    const { launchName: name, launchField: field } = event.target.dataset || {};
    if (name && field === "model") write_launch_model(name, event.target.value);
    else if (name) write_launch_field(name, field, event.target.type === "checkbox" ? event.target.checked : event.target.value);
  });
  // Whether this website keeps rooms of its own decides how settings and rooms are read, so it is asked until it answers.
  // A paired device will look up its computer next, so that read goes out beside the administrator state.
  if (paired_record()) prefetch("/api/machines", () => request_json("/api/machines"));
  for (let attempt = 0; await load_admin_state(), !state.admin.loaded; attempt++) {
    // The early read went out while the website could not be reached, so a fresh one is made later.
    prefetched.delete("/api/machines");
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]));
  }
  const relay_ready = new Promise(resolve => load_launch_settings({ relay_known: resolve }));
  watch_room_files();
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
  if (computer_rooms_only()) {
    // The settings read through the computer goes on meanwhile; the rooms need only the computer found.
    await relay_ready;
    // The computer's rooms appear only through connecting, which keeps trying by itself, so nothing here can hide them.
    await connect_computer_rooms({ reload: false });
  }
  try {
    // Connecting has already opened the computer's rooms when it reached them.
    if (!computer_rooms_only() || !state.remote_rooms) {
      const result = computer_rooms_only() ? { rooms: [] } : await request_json("/api/rooms");
      state.rooms = result.rooms;
      state.last_room = result.last_room || "";
      set_folder_directory(result);
      await select_room(opening_room());
    }
    set_connection(true);
  } catch (error) { set_connection(false); show_toast(error.message, true); }
  state.rooms_loading = false;
  prefetched.clear();
  publish_view();
  start_live_updates();
  migrate_local_share_links();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop_live_updates();
    else { begin_resuming(); start_live_updates(); load_admin_state(); }
  });
  window.addEventListener("pagehide", stop_live_updates);
  // The network coming back (a phone leaving a lift, a laptop waking) reconnects at once.
  window.addEventListener("online", () => { if (!state.connected) reconnect_live_updates({ automatic: true }); });
  window.addEventListener("pageshow", start_live_updates);
}

/** Publish a presentation snapshot shared by the legacy and Vue renderers. */
function publish_view() {
  document.dispatchEvent(new CustomEvent("discuss:view"));
}

/** Read current form drafts without transferring ownership to either renderer. */
function view_snapshot() {
  // Searched inside their containers: a whole-document selector walks every transcript node on each publish.
  const containers = [element("controller-fields"), ...Array.from(document.body.children).filter((node) => node.localName === "dialog")];
  const fields = Object.fromEntries(containers.flatMap((container) => container ? Array.from(container.querySelectorAll("input[id], textarea[id], select[id]")) : [])
    .map((control) => [control.id, control.value]));
  const experts = Object.fromEntries(["new-expert-modes"].map((id) =>
    [id, element(id) ? read_expert_inputs(id) : {}]));
  const sending_previews = room_sending_previews();
  return { room_source: { computer: computer_rooms_only(), signed_in: state.admin.logged_in, remote: state.remote_rooms, online: state.remote_online },
    room_site: room_site(), rooms: ordered_rooms(), folders: state.folders, folder_groups: ordered_folders(), room: shown_room(), archive_view: state.archive_view, directory_sort: state.directory_sort, messages: state.messages, history_cards: state.history_cards, total: state.message_total,
    archive_pending: [...state.archive_changes.keys()], import_progress: structuredClone(state.import_progress),
    directory_pending: [...state.directory_pending.keys()], folder_pending: [...state.folder_moves.keys()], creating_room: state.creating_room,
    connected: state.connected, reconnecting: state.reconnecting, rooms_loading: state.rooms_loading, observed_until: state.observed_until, resuming: state.resuming, backup_pending: Boolean(state.backup_pending), page: state.page, pages: state.pages, query: state.query,
    attachment_drafts: state.attachment_drafts.map(item => ({ id: item.id, file_name: item.file.name, size: item.file.size, preview_url: item.preview_url, placeholder: item.placeholder || "" })),
    upload_status: state.upload_status, sending_message: send_queue.some(job => job.room_id === state.room?.id), sending_previews, sending_preview: sending_previews[0] || null, queueing_previews: room_queueing_previews(), queue_reading: state.queue_reading, queue_taking: [...state.queue_taking],
    failed_sends: state.failed_sends.filter(job => job.room_id === state.room?.id).map((failed) => ({ id: failed.id, ...failed.preview })),
    mention_only: state.mention_only, host_only: state.host_only, authors: state.authors, card_kinds: state.card_kinds,
    source_filter: state.mention_only || state.host_only || state.authors.length > 0 || state.card_kinds.length > 0, messages_loading: Boolean(state.messages_loading), messages_failure: state.messages_failure || "", reply_to: state.reply_to, queued_taken: state.queued_taken,
    access: access_snapshot(), admin: admin_snapshot(), entry_account: state.entry_account || "",
    device: { id: state.device.id, needs: state.device.needs, pairing_code: state.device.pairing_code,
      prompt: state.device.prompt ? { title: state.device.prompt.title, description: state.device.prompt.description, confirm_label: state.device.prompt.confirm_label } : null },
    share: SHARE ? { exported_at: SHARE.exported_at, home: SHARE_HOME } : null,
    share_draft: share_draft ? { room_id: share_draft.room_id, title: share_draft.title, phase: share_draft.phase || "ready",
      spots: [...share_draft.spots || [], ...share_draft.include_files ? share_draft.file_spots || [] : []],
      files: { count: share_draft.files?.length || 0, bytes: (share_draft.files || []).reduce((total, file) => total + file.size, 0), included: Boolean(share_draft.include_files) },
      linked: Boolean(share_link(share_draft.room_id)), link: share_draft.link || null } : null,
    share_links: SHARE ? {} : share_links(), share_days: SHARE_DAYS,
    tab: state.tab, snapshot_id: state.snapshot_id, context_dirty: state.context_dirty,
    theme: document.documentElement.dataset.theme, fields, experts, launch: structuredClone(state.launch), named_followup: state.named_followup, create_discussion: state.create_discussion, create_goal: state.create_goal, create_chain_rounds: state.create_chain_rounds, create_host_workflows: state.create_host_workflows, create_host_permissions: state.create_host_permissions, create_api_max_requests: state.create_api_max_requests, create_relay_rounds: state.create_relay_rounds ?? 0, create_image_generation: state.create_image_generation };
}

/** Update a shared draft using the same input events as the original controls; `publish: false` leaves the views to keep their own copy. */
function write_view_field(id, value, { publish = true } = {}) {
  const control = element(id);
  if (!control || !control.matches("input, textarea, select")) return;
  state.navigation_version++;
  if (id === "new-room-host" && platform_of(value)
      && !Array.from(control.options).some(option => option.value === value)) {
    control.insertAdjacentHTML("beforeend", `<option value="${escape_html(value)}">${escape_html(value)}</option>`);
  }
  control.value = value ?? "";
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  if (["new-room-limit-max_rounds", "new-room-limit-max_minutes"].includes(id)) {
    write_create_preferences({ [id.slice("new-room-limit-".length)]: Number(control.value) });
  }
  if (publish) publish_view();
}

/** A participation select for one AI name; instances beyond the platforms get their own control. */
function expert_control(container_id, name) {
  const container = element(container_id);
  let control = container?.querySelector(`[data-expert="${CSS.escape(name)}"]`);
  if (!control && container && platform_of(name)) {
    container.insertAdjacentHTML("beforeend", `<label>${escape_html(name)}<select data-expert="${escape_html(name)}" aria-label="${escape_html(t("{name} 参与方式", { name: name }))}"><option value="">${escape_html(t("不参与"))}</option><option value="cli">${escape_html(t("本地 CLI · 读写"))}</option><option value="manual">${escape_html(t("手动接入"))}</option></select></label>`);
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
  element("reply-label").textContent = t('正在回复 #{value1} · {value2}', { value1: message.id, value2: display_name(message.author) });
  element("reply-preview").hidden = false;
}

/** Apply filters to the continuous transcript through the existing controller. */
async function filter_view({ query = state.query, mention = state.mention_only, host = state.host_only, authors = state.authors, kinds = state.card_kinds, page = 1 }) {
  const same_query = query.trim() === state.query && page === state.page;
  state.query = query.trim();
  state.mention_only = mention;
  state.host_only = host;
  state.authors = [...authors];
  state.card_kinds = [...kinds];
  // Speaker and card filters apply to the loaded transcript in the page; only a new search reads the site.
  if (same_query) {
    element("mention-filter").setAttribute("aria-pressed", String(mention));
    publish_view();
    return;
  }
  state.page = page;
  state.messages_loading = true;
  state.messages_failure = "";
  element("search-input").value = state.query;
  element("mention-filter").setAttribute("aria-pressed", String(mention));
  // The filter control changes at once; the filtered transcript follows when the site answers.
  publish_view();
  const reading = refresh_room(), version = state.refresh_version;
  try { await reading; }
  catch (error) {
    if (version === state.refresh_version) {
      state.messages_loading = false;
      state.messages_failure = error.message;
      publish_view();
    }
    throw error;
  }
}

/** Open the attachment a clicked image, file card or `[图片 #n]` tag names. */
function preview_clicked_attachment(event) {
  const preview = event.target.closest("[data-preview-attachment]");
  if (preview) run_action(() => preview_attachment({ ...preview.dataset, room_id: preview.dataset.attachmentRoom, id: preview.dataset.previewAttachment }));
}

/** Show and download room files read as bytes (the computer's rooms, a share page), and mark media the browser cannot play. */
function watch_room_files() {
  document.addEventListener("click", download_relay_file, true);
  document.addEventListener("error", mark_failed_media, true);
  new MutationObserver((records) => { if (files_by_blob()) show_relay_images(records); }).observe(document.body, { childList: true, subtree: true });
}

/** Open the one room a share page carries, with no administrator, launcher, relay or live updates behind it. */
async function initialize_share() {
  render_identities();
  bind_delegated_actions();
  watch_room_files();
  document.addEventListener("click", preview_clicked_attachment);
  Object.assign(state.admin, { loaded: true, local: false, devices: false, logged_in: false, registered: true });
  try {
    const directory = await request_json("/api/rooms");
    state.rooms = directory.rooms;
    set_folder_directory(directory);
    await select_room(SHARE.room_id);
  } catch (error) { notify("error", error.message); }
  set_connection(true);
  state.rooms_loading = false;
  publish_view();
}

/** Every message a share page carries, in order, gathered from its recorded history batches. */
function share_messages() {
  if (!share_messages.all) {
    share_messages.all = Object.entries(SHARE.responses).filter(([path]) => /\/messages\?/.test(path))
      .flatMap(([, body]) => body.messages || []).sort((a, b) => a.id - b.id);
  }
  return share_messages.all;
}

/** Answer a shared room page's reads from what it carries; it has nothing to write to. */
function share_answer(path, payload, localize) {
  if (payload !== undefined) return Promise.reject(Object.assign(new Error(t('这是只读的分享页面，不能修改房间')), { preflight: true, status: 403 }));
  let body = SHARE.responses[path];
  const base = `/api/rooms/${SHARE.room_id}`;
  // The timeline's later reads ask only for what changed since; a share page has the whole timeline as it was.
  if (body === undefined && path.startsWith(`${base}/timeline?`)) body = SHARE.responses[`${base}/timeline`];
  // A later history read, or a search, is answered from the messages already carried.
  if (body === undefined && path.startsWith(`${base}/messages?`)) {
    const params = new URLSearchParams(path.split("?")[1]);
    const after = Number(params.get("after") || 0), query = (params.get("q") || "").toLowerCase();
    const messages = share_messages().filter(message => message.id > after && (!query || `${message.text}\n${message.summary || ""}`.toLowerCase().includes(query)));
    body = { messages, total: messages.length, page: 1, pages: 1, remaining: 0, has_more: false, next_after: messages.at(-1)?.id || after };
  }
  const single = path.match(/\/messages\/(\d+)$/);
  if (body === undefined && single && path.startsWith(`${base}/`)) body = share_messages().find(message => message.id === Number(single[1]));
  if (body === undefined) return Promise.reject(Object.assign(new Error(t('分享页面不包含这部分内容')), { preflight: true, status: 404 }));
  return Promise.resolve(localize(structuredClone(body)));
}

// Fields a share page never carries: where things ran on this computer, sessions, credentials, the owner's own notes
// on the room and its members, the decision model's choices, messages still queued, attachments and refused commands.
const SHARE_DROPPED_FIELDS = new Set(["cwd", "session_id", "reported_session", "reported_client", "client_id", "submission_id",
  "lease_until", "adopt_error", "token", "access_token", "descriptions", "extra_directories", "project_directory", "resets"]);
const SHARE_ZEROED_FIELDS = ["quota_until", "held_until"];
const SHARE_EMPTIED_FIELDS = new Set(["scheduler_decisions", "scheduler_routing", "recommendations", "denials", "queued_messages",
  "ended_externals", "attachments"]);
// Template parameters a notice fills with the software's own words, and what a share page says instead.
const SHARE_TEMPLATE_PARAMS = { reason: () => t('执行失败'), resets: () => t('未公开') };
// The room's own background and boundaries are text; executions use "background" as a flag, which stays.
const SHARE_DROPPED_TEXT = new Set(["background", "boundaries"]);
// Text that looks like a key, a token, a person's folder on a computer or contact details: flagged for the owner, never rewritten.
const SHARE_SENSITIVE_PATTERNS = [/\bsk[-_](?:live_)?[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g, /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, /\b(?:hf|npm)_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/g, /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@/g, /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"]+/g, /\/(?:home|Users)\/[^/\s"]+/g,
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, /(?<!\d)1[3-9]\d{9}(?!\d)/g, /\bresets?\s+(?:in\s+)?\d[^\n]{0,40}/gi, /\(\s*[A-Z][a-z]+\/[A-Za-z_]+\s*\)/g];
// "<" and the two line separators JSON allows but a script must not carry raw.
const SHARE_SCRIPT_UNSAFE = new RegExp(`[<${String.fromCharCode(0x2028, 0x2029)}]`, "g");
// A person's home folder on any computer, in Windows, Git Bash, WSL or Unix spelling; a share page writes it as "~".
const SHARE_HOME_FOLDERS = [/(?<![\w./-])[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|*?]+/gi, /(?<![\w./-])\/(?:mnt\/)?[a-z]\/Users\/[^/\s"'`]+/gi,
  /(?<![\w./-])\/(?:home|Users)\/[^/\s"'`]+/g];
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\/)/;
// A folder named by fewer parts ("C:", "/home") is too broad to rewrite in text.
const SHARE_FOLDER_MIN_PARTS = 2;
// Attachments whose text is scanned for keys and folders before sharing: plain text up to this size, not packed office files.
const SHARE_SCAN_BYTES = 2 * 1024 * 1024;
const SHARE_PACKED_TEXT = /\.(docx|xlsx|xls|ods|pptx|prproj)$/i;
const SHARE_SNIPPET_CHARS = 20;

/** A changed file's path as a share page shows it: inside the run's own folder, or the last two parts of the path. */
function share_path(path, folder) {
  if (typeof path !== "string") return path;
  const normal = path.replaceAll("\\", "/");
  if (!ABSOLUTE_PATH.test(normal)) return path;
  const base = String(folder || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  if (base && normal.toLowerCase().startsWith(`${base}/`)) return normal.slice(base.length + 1);
  return `…/${normal.split("/").filter(Boolean).slice(-2).join("/")}`;
}

/** Copy an answer for a share page, leaving out what only this computer and its owner should see; attachments only when `keep_files`. */
function share_clean(value, keep_files = false) {
  if (Array.isArray(value)) return value.map(item => share_clean(item, keep_files));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SHARE_DROPPED_FIELDS.has(key) || SHARE_DROPPED_TEXT.has(key) && typeof item === "string") continue;
    result[key] = SHARE_EMPTIED_FIELDS.has(key) && !(keep_files && key === "attachments") ? (Array.isArray(item) ? [] : null) : share_clean(item, keep_files);
  }
  // When a member's quota comes back is the same fact as a quota notice's reset time, as a timestamp.
  for (const field of SHARE_ZEROED_FIELDS) if (field in result) result[field] = 0;
  // Another person's computer: only that the member is external stays.
  if (value.external && typeof value.external === "object") result.external = true;
  // A failure's own text comes from the software and can name the account, its plan or its time zone.
  if (value.status === "failed" || value.failure_class) {
    if (typeof result.result === "string" && result.result) result.result = t('执行失败');
    if (typeof result.reason === "string" && result.reason) result.reason = t('执行失败');
  }
  if (result.retry?.reason) result.retry = { ...result.retry, reason: "" };
  // A system notice about a failed run quotes the same text, or its quota's reset time, through its template: the notice
  // keeps its wording, not the quote. Read from the original, since "resets" itself is a dropped field.
  for (const [field, metadata] of Object.entries(value.texts || {})) {
    const params = metadata?.params || {};
    const replaced = Object.fromEntries(Object.keys(SHARE_TEMPLATE_PARAMS).filter(key => params[key]).map(key => [key, SHARE_TEMPLATE_PARAMS[key]()]));
    if (!Object.keys(replaced).length) continue;
    result.texts = { ...result.texts, [field]: { ...metadata, params: { ...result.texts?.[field]?.params, ...replaced } } };
    if (typeof result[field] === "string") result[field] = server_text(result.texts[field], result[field]);
  }
  for (const field of ["changes", "edited"]) if (Array.isArray(result[field])) result[field] = result[field].map(item => share_path(item, value.cwd));
  if (Array.isArray(result.diff_stats)) result.diff_stats = result.diff_stats.map(item => item?.path ? { ...item, path: share_path(item.path, value.cwd) } : item);
  return result;
}

/** A history batch without the messages the owner took back: retracted or rewound. */
function share_batch(body) {
  return { ...body, messages: (body.messages || []).filter(message => !message.withdrawn) };
}

/**
 * Read everything a share page shows for one room, as the site answers now, keyed by the routes the page will ask for.
 * Only these reads go into the page: anything else read meanwhile (another room in the background) stays out.
 */
async function record_share_reads(room_id) {
  const base = `/api/rooms/${room_id}`;
  const kept = new Map();
  const keep = async (path) => {
    const recorder = new Map();
    share_recording = recorder;
    let answer;
    try { answer = await request_json(path); }
    finally { if (share_recording === recorder) share_recording = null; }
    if (!recorder.has(path)) throw new Error(t('分享页面不包含这部分内容'));
    kept.set(path, recorder.get(path));
    return answer;
  };
  await keep("/api/rooms");
  await keep(base);
  const noted = new Set(), runs = new Set();
  for (let after = 0, more = true; more;) {
    const batch = await keep(history_batch_path(room_id, "", after));
    for (const execution of batch.cards?.executions || []) {
      runs.add(execution.id);
      if (execution.notes > 0) noted.add(execution.id);
    }
    more = Boolean(batch.has_more) && batch.messages.length > 0;
    after = batch.messages.at(-1)?.id || after;
  }
  const timeline = await keep(`${base}/timeline`);
  for (const execution of timeline.executions || []) {
    if (execution.source === "external") continue;
    runs.add(execution.id);
    if (execution.notes?.length || execution.last_note) noted.add(execution.id);
  }
  // Notes are read only for runs that have some; one that cannot be read stops the page rather than leaving it short.
  for (const id of noted) await keep(`${base}/executions/${id}/notes`);
  return { responses: Object.fromEntries(kept), runs: runs.size };
}

/** A file's bytes as a data URL, so the share page needs nothing but itself. */
function data_url(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** This page's own HTML with its scripts, styles and member icons carried inside, and the room set before the scripts. */
async function share_page_html(share) {
  const read = async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(t('读取网页文件 {path} 失败', { path }));
    return response.text();
  };
  const page = await read("/");
  const icon_paths = new Set();
  const sources = {};
  for (const name of ["i18n.js", "markdown.js", "backup.js", "app.js", "modern.js", "modern.css", "markdown.css", "katex/katex.min.css"]) {
    sources[name] = await read(`/${name}`);
    for (const match of sources[name].matchAll(/\/icons\/[\w.-]+\.svg/g)) icon_paths.add(match[0]);
  }
  for (const path of icon_paths) {
    const response = await fetch(path).catch(() => null);
    if (!response?.ok) continue;
    const icon = await data_url(new Blob([await response.arrayBuffer()], { type: "image/svg+xml" }));
    for (const name of Object.keys(sources)) sources[name] = sources[name].replaceAll(path, icon);
  }
  // Scripts and styles go in as data URLs, so nothing in them can end the tag that carries them.
  const script = async (name, module = false) => `<script${module ? ' type="module" id="modern-script"' : ""} src="${await data_url(new Blob([sources[name]], { type: "text/javascript" }))}"></script>`;
  const style = async (name) => `<link rel="stylesheet" href="${await data_url(new Blob([sources[name]], { type: "text/css" }))}">`;
  // JSON as script text: "<" cannot close the tag, and the two line separators JSON allows are escaped too.
  const room_json = JSON.stringify(share).replace(SHARE_SCRIPT_UNSAFE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const head = [
    `<meta name="robots" content="noindex, noarchive">`, `<meta name="referrer" content="no-referrer">`,
    // Pictures from other sites stay links: loading them would tell those sites who reads the page and when.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; media-src data: blob:; font-src data:; connect-src data: blob:; base-uri 'none'; form-action 'none'">`,
    `<meta property="og:title" content="${escape_html(share.title)} · AI CoDiscuss">`,
    `<meta property="og:description" content="${escape_html(share.description)}">`,
    await style("modern.css"), await style("markdown.css"), await style("katex/katex.min.css"),
    `<script>window.CODISCUSS_SHARE = ${room_json};</script>`,
    await script("i18n.js"), await script("markdown.js"), await script("backup.js"), await script("app.js"), await script("modern.js", true),
  ].join("\n  ");
  // Replacements are functions: as plain strings, "$&", "$`" and "$'" in the room's own text would be read as patterns.
  return page.replace(/<link[^>]*href="\/(?:modern\.css|modern\.js|markdown\.css|katex\/katex\.min\.css)[^"]*"[^>]*>\s*/g, () => "")
    .replace(/<script src="\/(?:i18n|markdown|backup|app)\.js[^"]*"><\/script>\s*/g, () => "")
    .replace(/<title>[^<]*<\/title>/, () => `<title>${escape_html(share.title)} · AI CoDiscuss</title>`)
    .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${escape_html(share.description)}">`)
    .replace("</head>", () => `  ${head}\n</head>`);
}

/** Every string inside an answer, so a scan reads text as written rather than JSON with its escapes. */
function share_strings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) share_strings(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) share_strings(item, out);
  return out;
}

/**
 * Where the share page has text that looks like a key, a token, a personal folder or contact details, one entry per place
 * (a message, a run's notes, the room's details) with how many it has and the first of them in its context. `extra` adds
 * texts read elsewhere, as [{ texts, where }] (an attachment's own text).
 */
function share_sensitive_spots(responses, extra = []) {
  const places = new Map();
  const scan = (texts, where) => {
    for (const text of texts) {
      for (const pattern of SHARE_SENSITIVE_PATTERNS) {
        for (const match of text.matchAll(pattern)) {
          const place = places.get(where) || places.set(where, { where, count: 0, text: "" }).get(where);
          place.count++;
          if (!place.text) {
            const from = Math.max(0, match.index - SHARE_SNIPPET_CHARS);
            place.text = `${from ? "…" : ""}${text.slice(from, match.index + match[0].length + SHARE_SNIPPET_CHARS).replace(/\s+/g, " ")}…`;
          }
        }
      }
    }
  };
  for (const [path, body] of Object.entries(responses)) {
    if (/\/messages\?/.test(path)) for (const message of body.messages || []) scan([message.text || "", message.summary || ""], `#${message.id}`);
    else if (/\/notes$/.test(path)) scan(share_strings(body), t('执行 #{id} 的过程说明', { id: path.match(/executions\/(\d+)/)[1] }));
    else scan(share_strings(body), t('房间与执行信息'));
  }
  for (const { texts, where } of extra) scan(texts, where);
  return [...places.values()];
}

/** The attachments a share page could carry: those of the messages it shows, each once, by the route that reads it. */
function share_files(responses) {
  const files = new Map();
  for (const [path, body] of Object.entries(responses)) {
    if (!/\/messages\?/.test(path)) continue;
    for (const message of body.messages || []) for (const file of message.attachments || []) {
      const route = `/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content`;
      // A data URL names the plain type; parameters such as a charset would not survive the share site's check.
      files.set(route, { route, file_name: file.file_name, size: Number(file.size) || 0, message_id: message.id,
        content_type: String(file.content_type || "").split(";")[0].trim() || "application/octet-stream" });
    }
  }
  return [...files.values()];
}

/** What looks sensitive inside the attachments whose text can be read; images and other files are left to the owner. */
async function share_file_spots(files) {
  const extra = [];
  for (const file of files) {
    if (!is_text_attachment(file) || SHARE_PACKED_TEXT.test(file.file_name) || file.size > SHARE_SCAN_BYTES) continue;
    const text = new TextDecoder().decode(await read_room_file(file.route));
    extra.push({ texts: [text], where: t('#{id} 的附件 {name}', { id: file.message_id, name: file.file_name }) });
  }
  return share_sensitive_spots({}, extra);
}

/** A file a share page carries, as a Blob; one it does not carry was left out when the page was made. */
function share_file_blob(path) {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(SHARE.attachments?.[path] || "");
  if (!match) throw Object.assign(new Error(t('分享页面不包含这个附件')), { status: 404 });
  return new Blob([base64_to_bytes(match[2])], { type: match[1] });
}

/** What a confirmed share page carries: the room's answers, and every attachment's bytes when the owner chose to include them. */
async function share_contents(draft) {
  const share = { room_id: draft.room_id, title: draft.title, description: draft.description, exported_at: draft.exported_at,
    responses: draft.include_files ? draft.responses_with_files : draft.responses };
  if (!draft.include_files || !draft.files.length) return share;
  share.attachments = {};
  for (const file of draft.files) share.attachments[file.route] = await data_url(new Blob([await read_room_file(file.route)], { type: file.content_type }));
  return share;
}

/** Include or leave out the attachments of the page being prepared. */
function share_include_files(include) {
  if (!share_draft || share_draft.phase !== "ready") return;
  share_draft.include_files = Boolean(include);
  publish_view();
}

/** A folder of this computer as a pattern for any spelling of it in text: either slash, any letter case, with the separator after it. */
function share_folder_pattern(folder) {
  const parts = String(folder).split(/[\\/]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (parts.length < SHARE_FOLDER_MIN_PARTS) return null;
  // A drive is also written /d or /mnt/d (Git Bash, WSL).
  const drive = parts[0].match(/^([A-Za-z]):$/);
  const first = drive ? `(?:${drive[1]}:|/${drive[1]}|/mnt/${drive[1]})` : `${String(folder).startsWith("/") ? "/" : ""}${parts[0]}`;
  // Whole path parts only: D:\Work\X is not the start of D:\Work\X-wt, nor of a path inside an address.
  return new RegExp(`(?<![\\w./-])${[first, ...parts.slice(1)].join("[\\\\/]+")}(?![\\w-])([\\\\/]+)?`, "gi");
}

/**
 * What a share page carries, from the answers its reads got: only this room in the directory, no messages the owner took
 * back, none of the fields only this computer and its owner should see, and the room's project folders written as paths
 * inside the project. `folders` adds folders the page knows beyond those its runs worked in.
 */
function share_payload(raw, room_id, folders = [], { attachments = false } = {}) {
  const known = new Set(folders.filter(Boolean));
  JSON.stringify(raw, (key, item) => { if (key === "cwd" && typeof item === "string" && item) known.add(item); return item; });
  // Longer folders first, so a project inside another one keeps its own relative paths.
  const patterns = [...known].sort((a, b) => b.length - a.length).map(share_folder_pattern).filter(Boolean);
  const strip = (value) => {
    if (typeof value === "string") return SHARE_HOME_FOLDERS.reduce((text, pattern) => text.replace(pattern, () => "~"),
      patterns.reduce((text, pattern) => text.replace(pattern, (match, separator) => separator ? "" : t('项目目录')), value));
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
  };
  // Messages the owner took back, and the runs that asked or answered them: their text also sits in the timeline and notes.
  const withdrawn = new Set(Object.entries(raw).filter(([path]) => /\/messages\?/.test(path))
    .flatMap(([, body]) => (body.messages || []).filter(message => message.withdrawn).map(message => message.id)));
  const on_withdrawn = (run) => [run.task_id, run.request_message_id, run.answer_id].some(id => withdrawn.has(id));
  const dropped_runs = new Set();
  JSON.stringify(raw, (key, item) => { if (key === "executions" && Array.isArray(item)) for (const run of item) if (run && on_withdrawn(run)) dropped_runs.add(run.id); return item; });
  const without_runs = (value) => {
    if (Array.isArray(value)) return value.map(without_runs);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "executions" && Array.isArray(item) ? item.filter(run => !dropped_runs.has(run?.id)).map(without_runs) : without_runs(item)]));
  };
  const responses = {};
  for (const [path, body] of Object.entries(raw)) {
    const run = path.match(/\/executions\/(\d+)\/notes$/);
    if (run && dropped_runs.has(Number(run[1]))) continue;
    let kept = body;
    if (path === "/api/rooms") kept = { rooms: (body.rooms || []).filter(room => room.id === room_id).map(room => ({ ...room, folder_id: "", archived: false })),
      folders: [], uncategorized_position: 0, participants: [], last_room: room_id };
    else if (/\/messages\?/.test(path)) kept = share_batch(body);
    responses[path] = strip(share_clean(without_runs(kept), attachments));
  }
  return responses;
}

// The share dialog's page: its stage ("preparing", "ready", "downloading", "publishing", "published"), what was found in
// it once read, and the published link once there is one.
let share_draft = null;

/** Read and clean one room for a share page, then let the owner see what looks sensitive before the file is made. */
async function share_prepare(room_id = state.room?.id) {
  if (!room_id || state.backup_pending) return;
  // The dialog opens at once and says it is reading; the room's answers fill it when they arrive.
  const draft = share_draft = { room_id, title: state.rooms.find(room => room.id === room_id)?.title || state.room?.title || "", phase: "preparing" };
  state.backup_pending = true;
  publish_view();
  try {
    const exported_at = new Date().toISOString();
    const recorded = await record_share_reads(room_id);
    const models = state.launch.room_models?.room_id === room_id ? state.launch.room_models : null;
    const folders = [models?.project_directory, ...(models?.extra_directories || [])];
    const responses = share_payload(recorded.responses, room_id, folders);
    // The same page with its messages' attachments listed, used when the owner chooses to include them.
    const responses_with_files = share_payload(recorded.responses, room_id, folders, { attachments: true });
    const files = share_files(responses_with_files);
    const file_spots = await share_file_spots(files);
    const room = responses[`/api/rooms/${room_id}`];
    const members = (room.members || []).filter(member => member.status !== "removed").map(member => member.label || display_name(member.name));
    const description = t('{members} 在同一个房间协作 · {messages} 条消息 · {runs} 次执行', { members: members.join("、"), messages: room.message_count, runs: recorded.runs });
    // Closed while reading: the owner no longer wants it.
    if (share_draft === draft) Object.assign(draft, { title: room.title, description, responses, responses_with_files, files, file_spots, include_files: false,
      exported_at, runs: recorded.runs, spots: share_sensitive_spots(responses), phase: "ready" });
  } catch (error) {
    if (share_draft === draft) share_draft = null;
    notify("error", t('生成分享网页失败：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Markdown reduced to plain words for a one-glance excerpt. */
function share_plain(text) {
  return String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_>#|~-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** What the share card shows of a prepared page: members, the first question, the latest outcome and the counts. */
function share_card(draft, link) {
  const room = draft.responses[`/api/rooms/${draft.room_id}`] || {};
  const members = (room.members || []).filter(member => member.status !== "removed").map(member => member.label || display_name(member.name));
  const messages = Object.entries(draft.responses).filter(([path]) => /\/messages\?/.test(path)).flatMap(([, body]) => body.messages || [])
    .filter(message => message.kind !== "system" && message.text).sort((a, b) => a.id - b.id);
  // The latest question and what came of it, so the two belong together even in a room used for months.
  const question = messages.findLast(message => message.author === "用户");
  const answers = messages.filter(message => message.author !== "用户" && message.id > (question?.id ?? 0));
  const outcome = answers.findLast(message => message.summary) || answers.at(-1);
  // Text the owner was asked to check stays off the card, which cannot be taken back once posted; it can be typed in.
  const flagged = new Set((draft.spots || []).map(spot => spot.where));
  const text = (message, value) => message && !flagged.has(`#${message.id}`) ? share_plain(value) : "";
  return { title: draft.title, members, question: text(question, question?.text), outcome: text(outcome, outcome?.summary || outcome?.text),
    stats: t('{members} 位 AI · {messages} 条消息 · {runs} 次执行', { members: members.length, messages: room.message_count ?? messages.length, runs: draft.runs ?? 0 }),
    url: link.url, expires: t('{time} 前有效', { time: new Date(link.expires_at).toLocaleString(undefined, { hour12: false }) }) };
}

/** Drop the share page the owner decided not to make. */
function share_cancel() {
  share_draft = null;
  publish_view();
}

/** Make the confirmed share page: one read-only file anyone can open, without this computer's details. */
async function share_room() {
  const draft = share_draft;
  if (!draft || draft.phase !== "ready" || state.backup_pending) return;
  draft.phase = "downloading";
  state.backup_pending = true;
  publish_view();
  try {
    const page = await share_page_html(await share_contents(draft));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([page], { type: "text/html" }));
    link.download = `${draft.title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || draft.room_id}.html`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    if (share_draft === draft) share_draft = null;
    notify("info", t('已生成分享网页，请查看浏览器下载；发出前请打开核对一遍内容。'));
  } catch (error) {
    draft.phase = "ready";
    notify("error", t('生成分享网页失败：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** A room's live share link as the directory lists it ({ url, expires_at }, no manage token), or null. */
function share_link(room_id) {
  const link = state.rooms.find(room => room.id === room_id)?.share_link;
  return link && Date.parse(link.expires_at) > Date.now() ? link : null;
}

/** The live share links of the rooms in the directory, by room. */
function share_links() {
  return Object.fromEntries(state.rooms.map(room => [room.id, share_link(room.id)]).filter(([, link]) => link));
}

/** Show a room's link as changed at once, before the next directory read carries it. */
function show_share_link(room_id, link) {
  state.rooms = state.rooms.map(room => room.id === room_id ? { ...room, share_link: link ? { url: link.url, expires_at: link.expires_at } : null } : room);
}

/**
 * A room's share link with its manage token, kept with the room on the computer so any of the owner's devices can renew
 * or revoke it. A link an earlier version kept only in this browser moves there the first time it is asked for.
 */
async function share_link_record(room_id) {
  const { link } = await request_json(`/api/rooms/${encodeURIComponent(room_id)}/share-link`);
  if (link) return link;
  let local = null;
  try { local = JSON.parse(localStorage.getItem(`${SHARE_LINK_PREFIX}${room_id}`) || "null"); } catch { /* Nothing kept here. */ }
  if (!local?.id || !local.manage_token || Date.parse(local.expires_at) <= Date.now()) return null;
  const saved = await save_share_link(room_id, { share_id: local.id, url: local.url, manage_token: local.manage_token, expires_at: local.expires_at });
  try { localStorage.removeItem(`${SHARE_LINK_PREFIX}${room_id}`); } catch { /* It now lives with the room. */ }
  return saved;
}

/** Move every live link an earlier version kept in this browser to its room, so the "shared" list shows them all. */
async function migrate_local_share_links() {
  let keys = [];
  try { keys = Object.keys(localStorage).filter(key => key.startsWith(SHARE_LINK_PREFIX)); } catch { return; }
  for (const key of keys) {
    const room_id = key.slice(SHARE_LINK_PREFIX.length);
    if (!state.rooms.some(room => room.id === room_id)) continue;
    await share_link_record(room_id).catch(() => {});
  }
  if (keys.length) publish_view();
}

/** Keep (or with null, forget) a room's share link with the room, and show it in the directory at once. */
async function save_share_link(room_id, link) {
  const result = await request_json(`/api/rooms/${encodeURIComponent(room_id)}/share-link`, { link });
  show_share_link(room_id, result.link);
  return result.link;
}

/** Send one request to the share site; its error text, or the status, explains a refusal. */
async function share_site_request(method, path, body, token) {
  const headers = { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(`${SHARE_SITE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store", referrerPolicy: "no-referrer" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || t('分享站拒绝了这次请求（{status}）', { status: response.status })), { status: response.status });
  return result;
}

/** Publish the confirmed share page on the share site, or replace the one this room already has there; the link is copied. */
async function share_publish(ttl_days = SHARE_DEFAULT_DAYS) {
  const draft = share_draft;
  if (!draft || (draft.phase && draft.phase !== "ready") || state.backup_pending) return;
  const days = SHARE_DAYS.includes(Number(ttl_days)) ? Number(ttl_days) : SHARE_DEFAULT_DAYS;
  // The button turns to uploading at once; reading the attachments, when included, happens behind it.
  draft.phase = "publishing";
  state.backup_pending = true;
  publish_view();
  try {
    const body = { format: SHARE_FORMAT, ...await share_contents(draft), ttl_days: days };
    const bytes = new Blob([JSON.stringify(body)]).size;
    if (bytes > SHARE_MAX_BYTES) {
      draft.phase = "ready";
      notify("error", draft.include_files && draft.files.length
        ? t('这个房间连同附件整理后有 {size}，超过分享链接 5 MB 的上限；请取消“包含附件”，或改用“下载网页文件”。', { size: attachment_size(bytes) })
        : t('这个房间整理后有 {size}，超过分享链接 5 MB 的上限；请改用“下载网页文件”。', { size: attachment_size(bytes) }));
      return;
    }
    const existing = await share_link_record(draft.room_id);
    let link;
    try {
      const result = existing
        ? await share_site_request("PUT", `/api/shares/${encodeURIComponent(existing.share_id)}`, body, existing.manage_token)
        : await share_site_request("POST", "/api/shares", body);
      link = { share_id: result.id || existing.share_id, url: result.url || existing.url, manage_token: result.manage_token || existing.manage_token, expires_at: result.expires_at };
    } catch (error) {
      // The old link is gone from the site (expired, taken down or revoked elsewhere): publish anew.
      if (!existing || ![404, 410].includes(error.status)) throw error;
      const result = await share_site_request("POST", "/api/shares", body);
      link = { share_id: result.id, url: result.url, manage_token: result.manage_token, expires_at: result.expires_at };
    }
    // The link is out; keeping it with the room is what lets the owner renew or revoke it later, so a failure here is said.
    await save_share_link(draft.room_id, link).catch(error => notify("warning", t('链接已发布，但没能保存到房间，之后无法在这里续期或撤销：{value1}', { value1: error.message })));
    const copied = await navigator.clipboard?.writeText(link.url).then(() => true, () => false);
    // The dialog turns into the published link itself, to copy or open; the room's own data is no longer needed.
    Object.assign(draft, { phase: "published", link: { url: link.url, expires_at: link.expires_at, copied: Boolean(copied), updated: Boolean(existing), card: share_card(draft, link) }, responses: null, responses_with_files: null });
  } catch (error) {
    draft.phase = "ready";
    notify("error", t('发布分享链接失败：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Give a room's published link a new lifetime from now, its content unchanged. */
async function share_renew({ room_id, days = SHARE_DEFAULT_DAYS }) {
  if (state.backup_pending) return;
  state.backup_pending = true;
  publish_view();
  try {
    const link = await share_link_record(room_id);
    if (!link) throw new Error(t('这个房间没有可续期的分享链接'));
    const result = await share_site_request("POST", `/api/shares/${encodeURIComponent(link.share_id)}/renew`, { ttl_days: SHARE_DAYS.includes(Number(days)) ? Number(days) : SHARE_DEFAULT_DAYS }, link.manage_token);
    await save_share_link(room_id, { ...link, expires_at: result.expires_at });
    notify("info", t('已续期，{time} 前有效。', { time: new Date(result.expires_at).toLocaleString(undefined, { hour12: false }) }));
  } catch (error) {
    // Gone from the site already: nothing to renew, so it leaves the list.
    if ([404, 410].includes(error.status)) await save_share_link(room_id, null).catch(() => {});
    notify("error", t('续期失败：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Take a room's published link down now; the share site deletes its copy. */
async function share_revoke(room_id) {
  if (state.backup_pending) return;
  state.backup_pending = true;
  publish_view();
  try {
    const link = await share_link_record(room_id);
    if (link) {
      try { await share_site_request("DELETE", `/api/shares/${encodeURIComponent(link.share_id)}`, null, link.manage_token); }
      catch (error) { if (![404, 410].includes(error.status)) throw error; }
    }
    await save_share_link(room_id, null);
    notify("info", t('分享链接已撤销，打开它的人会看到“分享不存在”。'));
  } catch (error) {
    notify("error", t('撤销分享链接失败：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Copy a room's published link again. */
async function share_copy(room_id) {
  const link = share_link(room_id);
  if (link) await copy_text(link.url);
}

/** Download one complete room snapshot independently of visible filters or later navigation. */
async function backup_room(room_id = state.room?.id) {
  if (!room_id || state.backup_pending) return;
  state.backup_pending = true;
  element("backup-room").disabled = true;
  element("backup-room").textContent = t('正在备份…');
  publish_view();
  try {
    const snapshot = await request_json(`/api/rooms/${encodeURIComponent(room_id)}/backup`);
    snapshot.source_url = `${room_site()}/r/${encodeURIComponent(room_id)}`;
    await attach_local_members(snapshot, room_id);
    await window.discuss_backup.download_room_backup(snapshot, read_room_file);
    const task_messages = new Set((snapshot.tables.task_message_sources || []).map(row => row.message_id));
    const message_count = snapshot.tables.messages.filter(message => !task_messages.has(message.id)).length;
    show_toast(t('已生成备份（{value1} 条消息），请查看浏览器下载。', { value1: message_count }));
  } finally {
    state.backup_pending = false;
    element("backup-room").disabled = !state.room;
    element("backup-room").textContent = t('备份当前讨论');
    publish_view();
  }
}

/** Download several rooms, such as a folder or the whole directory, as one importable archive. */
async function backup_rooms({ ids, name }) {
  if (!ids.length || state.backup_pending) return;
  state.backup_pending = true;
  publish_view();
  try {
    const snapshots = [];
    for (const id of ids) {
      const snapshot = await request_json(`/api/rooms/${encodeURIComponent(id)}/backup`);
      await attach_local_members(snapshot, id);
      snapshots.push({ ...snapshot, source_url: `${room_site()}/r/${encodeURIComponent(id)}` });
    }
    await window.discuss_backup.download_rooms_backup(snapshots, name, read_room_file);
    notify("info", t('已生成 {value1} 个频道的备份，请查看浏览器下载。', { value1: snapshots.length }));
  } catch (error) {
    notify("error", t('导出失败，未生成备份：{value1}', { value1: error.message }));
  } finally {
    state.backup_pending = false;
    publish_view();
  }
}

/** Add this machine's member software and sessions to an owned room's backup, so importing it here resumes the same sessions. */
async function attach_local_members(snapshot, room_id) {
  const token = localStorage.getItem(`discuss-access:${room_id}`);
  if (!token || !state.launch.available) return;
  try {
    const result = await local_launch_request("room-profiles", { room_id, token });
    if (result.local_members) snapshot.local_members = result.local_members;
  } catch (error) { throw new Error(t('读取本机成员会话失败，未生成备份：{value1}', { value1: error.message })); }
}

/** The website copy of a backup: keep local data private and apply each adapter's restore policy. */
function import_body(snapshot) {
  const { local_members, ...body } = snapshot;
  if (!local_members) return body;
  const manual = new Set(Object.entries(local_members.participants || {}).filter(([, profile]) => window.discuss_backup.adapter_profile(profile.adapter)?.restore_manual).map(([name]) => name));
  const room_members = (body.tables?.room_members || []).map(row => manual.has(row.name) && row.status !== "removed"
    ? { ...row, access: "manual", adapter: "", session_mode: "new" } : row);
  return { ...body, tables: { ...body.tables, room_members } };
}

/** Register an imported room's exported members on this machine; returns one short line per member and any room-wide problem. */
async function restore_local_members(room, token, local_members) {
  if (!state.launch.available) return { members: [], problem: t('未连接本机服务，成员会话未恢复') };
  try {
    const result = await local_launch_request("room-restore", { room_id: room.id, token, local_members });
    return { members: result.members.map(member => ({ name: member.name, failed: member.status === "failed",
      text: member.status === "failed" ? t('未恢复：{value1}', { value1: member.error }) : member.status === "resumed" ? t('请回后接续原会话') : t('已改为手动接入，请回后在原窗口重新注册'),
      resume: member.resume || null })) };
  } catch (error) { return { members: [], problem: t('成员会话未恢复：{value1}', { value1: error.message }) }; }
}

/** Upload one imported room's original files to the new attachment IDs; returns how many were missing. */
async function upload_imported_files(room_id, token, mapping, files) {
  let missing = 0;
  for (const [old_id, new_id] of Object.entries(mapping)) {
    const data = files.get(old_id);
    try {
      if (!data) throw new Error(t('备份中没有该文件'));
      await post_room_file(`/api/rooms/${encodeURIComponent(room_id)}/attachments/${encodeURIComponent(new_id)}/import`, data, token);
    } catch { missing++; }
  }
  return missing;
}

/** Import every room in the chosen backup files into one folder (unfiled when null); each imported room is owned by this browser, existing rooms are skipped. */
async function import_rooms({ files, folder_id = null }) {
  if (!files?.length || state.backup_pending) return;
  state.backup_pending = true;
  const progress = state.import_progress = { done: false, rooms: [], errors: [] };
  publish_view();
  try {
    for (const file of files) {
      let rooms;
      try { rooms = await window.discuss_backup.read_room_archives(file); }
      catch (error) { progress.errors.push(error.message.includes(file.name) ? error.message : `${file.name}：${error.message}`); publish_view(); continue; }
      for (const { snapshot, files: originals } of rooms) {
        const item = { title: snapshot.tables?.rooms?.[0]?.title || file.name, status: "importing", members: [], problems: [] };
        progress.rooms.push(item);
        publish_view();
        const token = crypto.randomUUID() + crypto.randomUUID();
        try {
          const result = await request_json("/api/rooms/import", import_body(snapshot), token);
          item.title = result.title;
          if (result.skipped) { item.status = "skipped"; continue; }
          save_room_credentials({ id: result.id }, token);
          const missing = await upload_imported_files(result.id, token, result.attachments, originals);
          if (missing) item.problems.push(t('{value1} 个附件原文件缺失，消息中的这些附件无法打开', { value1: missing }));
          if (folder_id) await request_json(`/api/rooms/${result.id}/folder`, { actor: "用户", folder_id })
            .catch(error => item.problems.push(t('未放入文件夹：{value1}', { value1: error.message })));
          if (snapshot.local_members) {
            const { members, problem } = await restore_local_members(result, token, snapshot.local_members);
            item.members = members;
            if (problem) item.problems.push(problem);
          }
          item.status = "imported";
        } catch (error) { Object.assign(item, { status: "failed", error: error.message }); }
        finally { publish_view(); }
      }
    }
    await refresh_room();
  } finally {
    progress.done = true;
    state.backup_pending = false;
    publish_view();
  }
}

/** Execute a named view command, retaining existing retry and provenance rules. */
async function execute_view_action(name, value) {
  if (!["refresh", "create"].includes(name)) state.navigation_version++;
  const event = { preventDefault() {} };
  const actions = { refresh: refresh_room, room: select_room, tab: select_tab,
    archives: toggle_archives, backup: backup_room, backup_rooms, share_prepare, share_room, share_cancel, share_publish, share_include_files, share_revoke, share_renew, share_copy, import_rooms, manage_channel, move_channel, create_folder, move_folder, rename_folder, delete_folder, sort_directory,
    send: () => send_from_composer(event), discard_sending, retry_sending, choose_attachments, remove_attachment, preview_attachment,
    create: ({ folder_id, accepted, rejected }) => submit_room(event, folder_id, { accepted, rejected }), quick_create: quick_create_room, welcome: open_welcome,
    save_context: () => save_context(event), save_topic: () => save_topic(event),
    filter: filter_view, reply: set_view_reply, cancel_reply, skip_turn,
    copy_cli: () => copy_context(), copy_background,
    download_member_access, copy_member_access_text, copy_member_join, copy_member_launch: name => copy_member_join(name, true), pause_discussion, restart_discussion, start_room_discussion, end_room_discussion, start_room_goal, update_room_goal, goal_control,
    save_launch_defaults, resume_launch, discard_launch, retry_launch_connection, check_launch_connection: load_launch_settings,
    load_room_configuration, save_room_configuration, interrupt_member, retry_delivery, retract_message, retract_latest, stop_room, stop_host_checkin, rewind_and_send, fork_room, change_member, reorder_speakers, invite_member,
    enable_room_workflow, move_workflow_members, sync_room_workflow, set_room_host_workflows,
    adopt_recommendation, rate_decision,
    queue_send: send_queued, queue_delete: delete_queued, question_answer: question_request,
    queue_reorder: ids => queue_request({ action: "reorder", ids }), queue_resume: () => queue_request({ action: "resume" }),
    queue_toggle: enabled => queue_request({ action: "queueing", enabled }), queue_edit: edit_queued,
    busy: () => { throw new Error(t('上一个操作仍在处理中，请稍候；长时间无响应请刷新页面')); },
    copy_reading: () => copy_text(`${room_site()}/r/${state.room.id}`), copy: copy_text };
  try {
    await actions[name](value);
    return true;
  } catch (error) {
    if (!error.notified) notify("error", error.message);
    return false;
  } finally { publish_view(); }
}

/** Change channel colors while retaining the shared room, filters, and form drafts. */
function change_view_theme(theme) {
  apply_theme(theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, document.documentElement.dataset.theme); } catch { /* Keep the session preference. */ }
}

window.discuss_view = { snapshot: view_snapshot, write_field: write_view_field, write_create_preferences, notify, load_decision_input, upload_progress,
  write_launch: write_launch_field, default_launch_entry, platform_configured, description_template, save_description_template, description_draft, write_description_draft, clear_card_drafts, preset_origin, describe_member, set_chain_rounds, continue_chain, expert_presets, apply_expert_preset, unique_instance, member_label, default_name, label_draft, write_label_draft, preset_identity, save_expert_preset, delete_expert_preset, write_room_connection, write_room_adapter, launch_clients: LAUNCH_CLIENTS,
  launch_model_state, load_launch_models, write_launch_model, save_launch_api_key, create_launch_project, remove_launch_projects, display_path, write_scheduler, save_scheduler_api_key, save_search_api_key, check_scheduler, write_named_followup, write_create_discussion, write_create_goal, write_create_chain_rounds, write_create_relay_rounds, check_launch_api, launch_summary, launch_can_set_access, full_only_hint, pick_launch_directory, browse_local_directory, list_remote_directories, save_launch_projects, restore_launch_profile, reset_create_form, empty_discussion_message,
  start_drag: start_directory_drag, reconnect: reconnect_live_updates, stop_label, local_request: local_launch_request,
  attachment_markup, attachment_download_link, attachment_size, attachment_file_icon, add_attachments, drop_attachments, paste_attachments, drop_unreferenced_attachments, set_text_preview: (open) => { state.text_preview = open; }, set_image_viewer: (open) => { state.image_viewer = open; }, attachment_url,
  write_expert: write_view_expert, add_instance: add_view_instance, add_preset: add_preset_instance, platform_of, execute: execute_view_action, theme: change_view_theme,
  reload_workflows, workflow_preset, write_create_host_workflows, write_create_api_max_requests, write_create_image_generation, set_room_api_max_requests, set_room_image_generation, set_room_scheduler, set_room_extra_directories, set_room_project_directory,
  admin: { register: register_admin, login: login_admin, logout: logout_admin,
    update_profile: update_admin_profile, avatar_from_file: admin_avatar_from_file, validate: validate_admin_form,
    sessions: admin_sessions, revoke: revoke_admin_sessions, change_password: change_admin_password },
  device: { request: device_request, pair: pair_this_device, take_scanned: take_scanned_pairing, invite: invite_device, renew: renew_this_device, forget: forget_pairing,
    label: device_label, prompt_confirm: () => state.device.prompt?.run(), prompt_cancel: () => state.device.prompt?.cancel() },
  request: request_json, rewind_plan, identities: IDENTITIES, platform_identity: name => PLATFORM_IDENTITIES[name], display_name, mention_handles, mentioned_members, render_room_markdown, sources: SOURCE_LABELS,
  set_member_access, set_member_model, allow_denials, set_member_adapter, reload_room_models, read_member_skills, read_room_files, manage_room_files, upload_project_file, download_project_file, room_title, read_room_page, read_room_media, read_execution_details, interject_execution, read_member_chat, send_member_chat, stop_member_chat, pause_execution, limits_label, stop_reason_label, participant_model, participant_files, participant_session_hint, participant_access,
  turn_label, turn_guidance, round_groups, limit_rounds, progress_speaker, brief_meta, max_message_length: MAX_MESSAGE_LENGTH, provenance: message_provenance, format_time };

restore_theme();
restore_directory_sort();
document.addEventListener("DOMContentLoaded", initialize);
