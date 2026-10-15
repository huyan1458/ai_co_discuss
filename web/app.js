"use strict";

const PAGE_SIZE = 20;
const REFRESH_INTERVAL_MS = 12000;
const TOAST_DURATION_MS = 3500;
const SCROLL_BOTTOM_THRESHOLD = 70;
const SUBMISSION_ID_BYTES = 16;
const THEME_STORAGE_KEY = "ai-codiscuss-theme";
const THEMES = ["retro", "modern", "millennium", "channel"];
const VUE_THEMES = ["modern", "channel"];
const SOURCE_LABELS = { demo: "示例", user: "本人发言", proxy: "用户代发", cli: "CLI 发言", url: "历史 URL 发言", host_proxy: "主持人代发" };
const PHASE_LABELS = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", reviewing: "结论复核", paused: "已暂停", concluded: "已收束" };
const TURN_LABELS = { pending: "待通知", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消" };
const IDENTITIES = {
  "用户": { initials: "我", style: "user", description: "发起与协助" },
  Codex: { initials: "CX", style: "codex", description: "AI 身份" },
  Claude: { initials: "CL", style: "claude", description: "AI 身份" },
  Gemini: { initials: "GM", style: "gemini", description: "AI 身份" },
  DeepSeek: { initials: "DS", style: "deepseek", description: "AI 身份" },
  Qwen: { initials: "QW", style: "qwen", description: "AI 身份" },
};
const state = { rooms: [], room: null, page: 1, pages: 1, query: "", mention_only: false,
  reply_to: null, turn_reply_to: null, tab: "topic", refresh_version: 0, context_dirty: false, topic_dirty: false,
  snapshot_id: 0, pending_submission: null, pending_turn: null, toast_timer: null };
state.messages = [];
state.connected = false;

/** Return a DOM element by its stable ID. */
function element(id) { return document.getElementById(id); }

/** Apply a visual theme without replacing content or changing discussion state. */
function apply_theme(theme) {
  const selected = THEMES.includes(theme) ? theme : "modern";
  const uses_vue = VUE_THEMES.includes(selected);
  document.documentElement.dataset.theme = selected;
  document.documentElement.classList.toggle("dark", uses_vue);
  const legacy_style = document.getElementById("legacy-style");
  const modern_style = document.getElementById("modern-style");
  if (legacy_style) legacy_style.disabled = uses_vue;
  if (modern_style) modern_style.disabled = !uses_vue;
  if (uses_vue && !document.getElementById("modern-script")) {
    const script = document.createElement("script");
    script.id = "modern-script";
    script.type = "module";
    script.src = "/modern.js";
    document.head.append(script);
  }
  arrange_theme_layout(selected);
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === selected));
  });
  publish_view();
}

/** Move the existing room directory between layouts without recreating controls. */
function arrange_theme_layout(theme) {
  const directory = document.querySelector(".directory-card");
  const navigation = document.querySelector(".room-navigation");
  const aside = document.querySelector(".room-aside");
  if (!directory || !navigation || !aside) return;
  const destination = theme === "modern" ? navigation : aside;
  if (directory.parentElement !== destination) destination.prepend(directory);
}

/** Restore the local preference before the stylesheet and page content load. */
function restore_theme() {
  let theme = "modern";
  try { theme = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  apply_theme(theme);
}

/** Bind the theme picker and remember choices when browser storage is available. */
function bind_theme_controls() {
  apply_theme(document.documentElement.dataset.theme);
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.addEventListener("click", () => {
      change_view_theme(button.dataset.themeOption);
    });
  });
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

/** Display a brief operation result without losing the current draft. */
function show_toast(message, is_error = false) {
  document.dispatchEvent(new CustomEvent("discuss:toast", { detail: { message, is_error } }));
  clearTimeout(state.toast_timer);
  element("toast").textContent = message;
  element("toast").classList.toggle("error", is_error);
  element("toast").hidden = false;
  state.toast_timer = setTimeout(() => { element("toast").hidden = true; }, TOAST_DURATION_MS);
}

/** Request JSON from the local or remotely hosted discussion service. */
async function request_json(path, payload) {
  const options = { cache: "no-store" };
  if (payload !== undefined) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "请求失败，请重试");
  return result;
}

/** Show connection state without claiming that any AI is online. */
function set_connection(connected) {
  state.connected = connected;
  element("connection-dot").className = `status-dot ${connected ? "connected" : "failed"}`;
  element("connection-status").textContent = connected ? "讨论服务已连接" : "连接中断，可手动刷新";
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

/** Render identity controls and distinguish selectable identities from connections. */
function render_identities() {
  const options = Object.keys(IDENTITIES).map((name) => `<option>${name}</option>`).join("");
  element("author-select").innerHTML = options;
  element("topic-host-select").innerHTML = options;
  element("new-room-host").innerHTML = options;
  render_expert_inputs("new-expert-modes", default_experts());
  element("participants").innerHTML = Object.entries(IDENTITIES).map(([name, identity]) =>
    `<div class="participant ${identity.style}"><span class="avatar">${identity.initials}</span><span class="participant-name">${name}</span><span class="participant-role">${identity.description}</span></div>`).join("");
}

/** Render rooms while retaining the selected room. */
function render_rooms() {
  element("room-count").textContent = state.rooms.length;
  element("room-list").innerHTML = state.rooms.map((room) =>
    `<button class="room-item ${room.id === state.room?.id ? "active" : ""}" data-room="${room.id}" title="${escape_html(room.title)}"><span class="room-symbol">#</span><span class="room-item-name">${escape_html(room.title)}</span><span class="room-item-number">${room.message_count}</span></button>`).join("");
  element("no-room").hidden = Boolean(state.room);
  element("room-content").hidden = !state.room;
  element("copy-reading").disabled = !state.room;
  element("go-context").disabled = !state.room;
}

/** Update persistent room metadata without overwriting a manually edited state draft. */
function render_room() {
  if (!state.room) return;
  const room = state.room;
  element("room-title").textContent = room.title;
  element("room-subtitle").textContent = `${room.message_count} 条发言 · 独立观点，共享记录`;
  element("message-count").textContent = room.message_count;
  element("room-goal").textContent = room.goal || "尚未填写议题目标。";
  element("latest-id").textContent = `#${room.latest_id}`;
  element("state-version").textContent = `整理至 #${room.state_until}`;
  element("state-update-note").textContent = `当前记录至 #${room.latest_id}；保存后标记为本次打开的 #${state.snapshot_id}。`;
  if (!state.context_dirty) {
    element("state-input").value = room.state_text;
    state.snapshot_id = room.latest_id;
    element("state-update-note").textContent = `保存时标记整理至 #${state.snapshot_id}，原始发言保持不变。`;
  }
  render_access();
  render_topic();
  update_composer_role();
}

/** Describe roles separately from authors and the actual submitter. */
function message_provenance(message) {
  const role = message.kind === "receipt" ? "运行回执" : message.kind === "moderation" ? "主持发言" : (message.author === "用户" ? "用户发言" : "专家观点");
  const forwarding = message.submitted_by && message.submitted_by !== message.author ? ` · ${message.submitted_by} 代发` : "";
  const turn = message.turn_id ? ` · 回答安排 #${message.turn_id}` : "";
  return `${role}${forwarding}${turn}`;
}

/** Build compact chat lines with colored names, reply references, and provenance. */
function message_markup(message) {
  const identity = IDENTITIES[message.author] || IDENTITIES["用户"];
  const text = escape_html(message.text).replace(/@(Codex|Claude|Gemini|DeepSeek|Qwen|用户)/g, '<span class="mention">@$1</span>');
  const reply = message.reply_to ? `<button class="quote-link" data-detail="${message.reply_to}">↳ 回复 #${message.reply_to} · 查看原文</button>` : "";
  return `<article class="message ${identity.style}" id="message-${message.id}"><span class="avatar message-avatar" aria-hidden="true">${identity.initials}</span><div class="message-line"><time title="${escape_html(message.created_at)}">[${format_time(message.created_at)}]</time><strong class="message-author">${escape_html(message.author)}</strong><span class="message-verb"> 说：</span><span class="message-text">${text}</span></div><div class="message-details"><span class="source-badge ${message.source === "demo" ? "" : "real"}">${SOURCE_LABELS[message.source] || "发言"}</span><span>${escape_html(message_provenance(message))}</span><button class="message-id" data-detail="${message.id}">#${message.id}</button>${reply}<span class="message-actions"><button data-reply="${message.id}" data-author="${escape_html(message.author)}">回复</button><button data-copy-message="${message.id}">复制原文链接</button></span></div></article>`;
}

/** Render one bounded page of history without silently dumping all records. */
function render_messages(result) {
  state.messages = result.messages;
  state.message_total = result.total;
  const container = element("messages");
  const scroll_position = container.scrollTop;
  const is_near_bottom = container.scrollHeight - container.clientHeight - scroll_position < SCROLL_BOTTOM_THRESHOLD;
  state.pages = result.pages;
  container.innerHTML = result.messages.length ? result.messages.map(message_markup).join("") :
    `<div class="empty-messages"><strong>${state.query || state.mention_only ? "没有找到匹配的发言" : "讨论从第一句话开始"}</strong><p>${state.query || state.mention_only ? "换个关键词，或清除筛选后查看完整记录。" : "提出你的问题，邀请不同的观点。"}</p></div>`;
  container.scrollTop = is_near_bottom ? container.scrollHeight : scroll_position;
  element("record-caption").textContent = state.query || state.mention_only ? `筛选结果 · ${result.total} 条` : "完整记录 · 按时间排列";
  element("pagination").hidden = result.pages <= 1;
  element("page-label").textContent = `${result.page} / ${result.pages}`;
  element("previous-page").disabled = state.page <= 1;
  element("next-page").disabled = state.page >= result.pages;
}

/** Refresh a room with version guards so slower requests cannot change the active view. */
async function refresh_room() {
  if (!state.room) {
    state.rooms = (await request_json("/api/rooms")).rooms;
    if (state.rooms.length) return select_room(state.rooms[0].id);
    render_rooms();
    set_connection(true);
    return;
  }
  const version = ++state.refresh_version;
  const room_id = state.room.id;
  const params = new URLSearchParams({ page: state.page, q: state.query });
  if (state.mention_only) params.set("mention", element("author-select").value);
  const [directory, room, result] = await Promise.all([
    request_json("/api/rooms"), request_json(`/api/rooms/${room_id}`),
    state.tab === "discussion" ? request_json(`/api/rooms/${room_id}/messages?${params}`) : null,
  ]);
  if (version !== state.refresh_version || state.room?.id !== room_id) return;
  state.rooms = directory.rooms;
  state.room = room;
  render_rooms();
  render_room();
  if (result) render_messages(result);
  set_connection(true);
}

/** Select a room and reset room-specific draft and filter state. */
async function select_room(room_id) {
  state.room = state.rooms.find((room) => room.id === room_id);
  state.page = 1;
  state.query = "";
  state.mention_only = false;
  state.context_dirty = false;
  state.topic_dirty = false;
  state.pending_turn = null;
  state.pending_submission = null;
  state.messages = [];
  element("message-input").value = "";
  element("search-input").value = "";
  element("mention-filter").setAttribute("aria-pressed", "false");
  cancel_reply();
  cancel_turn_reply();
  element("turn-form").reset();
  element("message-kind").value = "opinion";
  select_tab(VUE_THEMES.includes(document.documentElement.dataset.theme) ? "discussion" : "topic");
  if (state.room) history.replaceState(null, "", `/?room=${encodeURIComponent(room_id)}`);
  render_rooms();
  await refresh_room();
}

/** Switch between history, manually maintained state, and participation guidance. */
function select_tab(tab_name) {
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

/** Submit one message; reuse its identifier if a network failure requires a retry. */
async function send_message(event) {
  event.preventDefault();
  if (!state.room) return;
  const mode = element("message-kind").value;
  const payload = { author: mode === "moderation" ? state.room.host : element("author-select").value,
    text: element("message-input").value.trim(), reply_to: state.reply_to, turn_id: state.turn_reply_to,
    kind: ["moderation", "receipt"].includes(mode) ? mode : "opinion", submitted_by: ["opinion", "receipt"].includes(mode) ? "用户" : state.room.host };
  if (!payload.text) return;
  const signature = JSON.stringify({ room: state.room.id, ...payload });
  if (state.pending_submission?.signature !== signature) state.pending_submission = { signature, id: new_submission_id() };
  payload.submission_id = state.pending_submission.id;
  element("send-message").disabled = true;
  try {
    const result = await request_json(`/api/rooms/${state.room.id}/messages`, payload);
    element("message-input").value = "";
    state.pending_submission = null;
    cancel_reply();
    cancel_turn_reply();
    state.query = "";
    state.mention_only = false;
    element("search-input").value = "";
    element("mention-filter").setAttribute("aria-pressed", "false");
    const room = await request_json(`/api/rooms/${state.room.id}`);
    state.page = Math.max(1, Math.ceil(room.message_count / PAGE_SIZE));
    await refresh_room();
    element("messages").scrollTop = element("messages").scrollHeight;
    show_toast(`留言已保存 · #${result.message.id}`);
  } finally { element("send-message").disabled = false; }
}

/** Show exact original content and let the reader follow the reply chain. */
async function show_message(message_id) {
  const message = await request_json(`/api/rooms/${state.room.id}/messages/${message_id}`);
  element("detail-title").textContent = `#${message.id} · ${message.author}`;
  const source = SOURCE_LABELS[message.source] || message.source;
  element("detail-body").textContent = `${source} · ${message_provenance(message)} · ${new Date(message.created_at).toLocaleString("zh-CN")}\n\n${message.text}`;
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
  const base = `${location.origin}/r/${state.room.id}`;
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

/** Create a room from the dialog and switch into its empty history. */
async function submit_room(event) {
  event.preventDefault();
  const room = await request_json("/api/rooms", { title: element("new-room-title").value, goal: element("new-room-goal").value,
    host: element("new-room-host").value, background: element("new-room-background").value,
    boundaries: element("new-room-boundaries").value, experts: read_expert_inputs("new-expert-modes") });
  state.rooms.push(room);
  element("room-dialog").close();
  element("room-form").reset();
  render_expert_inputs("new-expert-modes", default_experts());
  await select_room(room.id);
  select_tab(VUE_THEMES.includes(document.documentElement.dataset.theme) ? "discussion" : "topic");
  show_toast("话题已创建");
}

/** Persist a manually edited summary with the snapshot it was based on. */
async function save_context(event) {
  event.preventDefault();
  await request_json(`/api/rooms/${state.room.id}/state`, { actor: state.room.host, text: element("state-input").value, until: state.snapshot_id });
  state.context_dirty = false;
  await refresh_room();
  show_toast("讨论状态已保存，原始记录保持不变");
}

/** Copy a participation entrypoint without bundling any discussion context. */
async function copy_context(mode = "online") {
  const participant = element("author-select").value;
  const params = new URLSearchParams({ mode });
  if (participant !== "用户") params.set("participant", participant);
  const address = `${location.origin}/r/${state.room.id}?${params}`;
  if (mode === "cli" && participant !== "用户" && state.room.experts[participant] !== "cli") {
    throw new Error("该身份在本话题不是本地 CLI，请在主持管理中调整参与方式");
  }
  const identity = participant === "用户" ? "你自己的身份" : `${participant} 身份`;
  const instruction = mode === "cli" ? "你是本地 CLI AI，可读取记录并通过留言板的 POST 接口发布，提交后重新读取核对。" :
    "你是在线 AI，只读取讨论，在当前聊天窗口输出观点和引用编号，由用户代发。不要尝试在留言板直接提交。";
  await copy_text(`请以${identity}参与讨论。${instruction}\n话题入口：${address}\n先检查阶段和安排；独立观点阶段只读目标、背景、边界和自己的已有讨论，提交后再读他人观点。暂停或收束时不追加观点。其余材料按需阅读，不必读取全部历史。`);
}

/** Copy a bounded background startup contract without starting any external task. */
async function copy_background() {
  const participant = element("author-select").value;
  if (participant === "用户" || state.room.experts[participant] !== "cli") throw new Error("请先在讨论区选择已配置为本地 CLI 的专家身份");
  const base = `${location.origin}/r/${state.room.id}`;
  const params = new URLSearchParams({ mode: "cli", participant });
  await copy_text(`请以 ${participant} 身份在当前会话后台参与讨论。\n话题入口：${base}?${params}\n参与协议：${base}/protocol\n立即检查一次，再使用当前会话实际可用的原生后台任务每 60 秒检查，含首次最多检查 20 次。未创建成功就报告失败；不要新建会话或操作前台。\n每次先检查阶段；initial 只读目标、背景、边界和自己的既有讨论，独立提交后再交叉阅读。只回答分配给自己的 pending/notified 安排，关联 turn_id；每项仅答一次，同次重试沿用 submission_id 并读取原文核对。无新安排不发言。\n创建任务后用 kind=receipt 留档本次运行编号、实际任务编号、频率、上限和状态，不关联 turn_id。paused/concluded 或达到上限时取消自己创建的任务，核对实际结果并追加 receipt；无法核验则写待确认。不要把停止请求当作已经退出。\n不修改项目代码，不调用模型服务 API。复制这段指令不会自动启动任务。`);
}

/** Supply participation defaults for a new topic. */
function default_experts() {
  return Object.fromEntries(Object.keys(IDENTITIES).filter((name) => name !== "用户").map((name) => [name, name === "Codex" ? "cli" : "online"]));
}

/** Render independently configurable expert modes without changing identity names. */
function render_expert_inputs(container_id, experts) {
  element(container_id).innerHTML = Object.keys(default_experts()).map((name) =>
    `<label>${name}<select data-expert="${name}" aria-label="${name} 参与方式"><option value="">不参与</option><option value="cli">本地 CLI · 读写</option><option value="online">在线 AI · 只读</option></select></label>`).join("");
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
  element("topic-host").textContent = `主持人：${room.host} · 可以同时作为专家参与`;
  for (const field of ["goal", "focus", "background", "boundaries"]) element(`topic-${field}`).textContent = room[field] || "尚未填写";
  element("topic-experts").textContent = Object.entries(room.experts).map(([name, mode]) =>
    `${name} · ${mode === "cli" ? "本地 CLI，可读可写" : "在线 AI，只读"}${name === room.host ? " · 兼任主持人" : ""}`).join("\n");
  element("turn-history").href = `${location.origin}/r/${room.id}/turns?page=1`;
  element("host-operator").textContent = `当前以 ${room.host} 的主持职责管理话题。AI 主持人通过 CLI 操作；用户可在这里协助。`;
  if (!state.topic_dirty) {
    for (const field of ["title", "goal", "focus", "background", "boundaries"]) element(`topic-${field}-input`).value = room[field];
    element("topic-host-select").value = room.host;
    element("topic-phase-select").value = room.phase;
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
  element("turn-status").textContent = turn ? TURN_LABELS[turn.status] : "尚未安排";
  element("turn-expert").textContent = turn ? `#${turn.id} · ${turn.expert}` : "由主持人安排下一位专家";
  element("turn-question").textContent = turn?.question || "在下方展开主持管理，填写本轮待回应的问题。";
  element("copy-turn").disabled = !active || inactive;
  element("confirm-notified").disabled = !turn || turn.status !== "pending" || inactive;
  element("forward-turn").disabled = !active || inactive;
  element("cancel-turn").disabled = !active;
  element("view-turn-answer").hidden = !turn?.answer_id;
  const unavailable = active || inactive || !Object.keys(state.room.experts).length;
  element("schedule-turn").disabled = Boolean(unavailable);
  element("schedule-note").textContent = inactive ? "话题已暂停或收束；恢复阶段后才能继续安排。" :
    (active ? "先完成或取消当前安排，再安排下一位。" : "创建后保持待通知，由主持人实际联系专家。");
}

/** Save host-edited information and direction without touching message history. */
async function save_topic(event) {
  event.preventDefault();
  const payload = { actor: state.room.host, host: element("topic-host-select").value,
    phase: element("topic-phase-select").value, experts: read_expert_inputs("topic-expert-modes") };
  for (const field of ["title", "goal", "focus", "background", "boundaries"]) payload[field] = element(`topic-${field}-input`).value;
  await request_json(`/api/rooms/${state.room.id}/topic`, payload);
  state.topic_dirty = false;
  await refresh_room();
  show_toast("话题资料与进度已保存");
}

/** Schedule an expert with an identifier retained across uncertain retries. */
async function schedule_turn(event) {
  event.preventDefault();
  const payload = { actor: state.room.host, expert: element("turn-expert-select").value, question: element("turn-question-input").value.trim() };
  const signature = JSON.stringify({ room: state.room.id, ...payload });
  if (state.pending_turn?.signature !== signature) state.pending_turn = { signature, id: new_submission_id() };
  element("schedule-turn").disabled = true;
  try {
    await request_json(`/api/rooms/${state.room.id}/turns`, { ...payload, submission_id: state.pending_turn.id });
    state.pending_turn = null;
    element("turn-question-input").value = "";
    await refresh_room();
    show_toast("发言安排已创建，等待主持人通知");
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
  await request_json(`/api/rooms/${state.room.id}/turns/${state.room.current_turn.id}`, { actor: state.room.host, status });
  await refresh_room();
  show_toast(status === "notified" ? "已记录主持人的通知确认" : "发言安排已取消");
}

/** Prepare a host-forwarded answer while retaining the expert's own authorship. */
function prepare_turn_answer() {
  const turn = state.room.current_turn;
  element("message-kind").value = "forward";
  element("author-select").value = turn.expert;
  state.turn_reply_to = turn.id;
  element("turn-answer-label").textContent = `回答安排 #${turn.id} · ${turn.expert}，由 ${state.room.host} 代发`;
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
  if (mode === "moderation" && state.room?.host) element("author-select").value = state.room.host;
  element("author-note").textContent = mode === "receipt" ? "运行回执，由用户录入" : mode === "moderation" ? "主持发言" :
    (mode === "forward" ? `由 ${state.room?.host || "主持人"} 代发` : (element("author-select").value === "用户" ? "发言" : "的观点代发"));
}

/** Bind the topic workflow separately from existing chat controls. */
function bind_host_controls() {
  const actions = { "topic-context": () => select_tab("context"), "topic-history": () => select_tab("discussion"),
    "copy-turn": copy_turn, "confirm-notified": () => change_turn_status("notified"), "cancel-turn": () => change_turn_status("cancelled"),
    "forward-turn": prepare_turn_answer, "cancel-turn-answer": cancel_turn_reply,
    "view-turn-answer": () => show_message(state.room.current_turn.answer_id),
    "copy-host": () => copy_text(`请以 ${state.room.host} 身份主持此话题，可兼任专家。\n话题入口：${location.origin}/r/${state.room.id}?mode=cli\n主持协议：${location.origin}/r/${state.room.id}/protocol\n由专家自主按需阅读；通知不附上下文。实际联系专家后再确认通知状态。`) };
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
      element("reply-label").textContent = `正在回复 #${state.reply_to} · ${button.dataset.author}`;
      element("reply-preview").hidden = false;
      element("message-input").focus();
    }
  });
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.addEventListener("click", () => select_tab(tab.dataset.tab)));
}

/** Bind forms, filters, and explicit read/write actions. */
function bind_controls() {
  const actions = { "new-room": () => element("room-dialog").showModal(), "empty-create": () => element("room-dialog").showModal(),
    "open-settings": () => element("settings-dialog").showModal(), "close-settings": () => element("settings-dialog").close(),
    "close-room-dialog": () => element("room-dialog").close(), "close-message-dialog": () => element("message-dialog").close(),
    "refresh": refresh_room, "cancel-reply": cancel_reply, "go-context": () => select_tab("context"),
    "copy-reading": () => copy_text(`${location.origin}/r/${state.room.id}`),
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
  element("previous-page").addEventListener("click", () => { state.page--; run_action(refresh_room); });
  element("next-page").addEventListener("click", () => { state.page++; run_action(refresh_room); });
  element("message-input").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); element("message-form").requestSubmit(); }
  });
}

/** Load persisted discussion data and keep visible pages up to date. */
async function initialize() {
  bind_theme_controls();
  render_identities();
  bind_delegated_actions();
  bind_controls();
  bind_host_controls();
  try {
    const result = await request_json("/api/rooms");
    state.rooms = result.rooms;
    const requested = new URLSearchParams(location.search).get("room");
    await select_room(state.rooms.some((room) => room.id === requested) ? requested : state.rooms[0]?.id);
    set_connection(true);
  } catch (error) { set_connection(false); show_toast(error.message, true); }
  setInterval(async () => {
    if (document.hidden) return;
    try { await refresh_room(); } catch { set_connection(false); }
  }, REFRESH_INTERVAL_MS);
}

/** Publish a presentation snapshot shared by the legacy and Vue renderers. */
function publish_view() {
  document.dispatchEvent(new CustomEvent("discuss:view"));
}

/** Read current form drafts without transferring ownership to either renderer. */
function view_snapshot() {
  const fields = Object.fromEntries(Array.from(document.querySelectorAll(".app-shell input[id], .app-shell textarea[id], .app-shell select[id], body > dialog input[id], body > dialog textarea[id], body > dialog select[id]"))
    .map((control) => [control.id, control.value]));
  const experts = Object.fromEntries(["new-expert-modes", "topic-expert-modes"].map((id) =>
    [id, element(id) ? read_expert_inputs(id) : {}]));
  return { rooms: state.rooms, room: state.room, messages: state.messages, total: state.message_total,
    connected: state.connected, page: state.page, pages: state.pages, query: state.query,
    mention_only: state.mention_only, reply_to: state.reply_to, turn_reply_to: state.turn_reply_to,
    tab: state.tab, snapshot_id: state.snapshot_id, context_dirty: state.context_dirty,
    theme: document.documentElement.dataset.theme, fields, experts };
}

/** Update a shared draft using the same input events as the original controls. */
function write_view_field(id, value) {
  const control = element(id);
  if (!control || !control.matches("input, textarea, select")) return;
  control.value = value ?? "";
  control.dispatchEvent(new Event("input", { bubbles: true }));
  control.dispatchEvent(new Event("change", { bubbles: true }));
  publish_view();
}

/** Update one expert's participation mode in a shared topic draft. */
function write_view_expert(container_id, name, value) {
  const control = element(container_id)?.querySelector(`[data-expert="${CSS.escape(name)}"]`);
  if (!control) return;
  control.value = value;
  control.dispatchEvent(new Event("input", { bubbles: true }));
  publish_view();
}

/** Select a quoted message for both renderers without changing its text. */
function set_view_reply(message) {
  state.reply_to = message.id;
  element("reply-label").textContent = `正在回复 #${message.id} · ${message.author}`;
  element("reply-preview").hidden = false;
}

/** Apply filters and retrieve a bounded page through the existing controller. */
async function filter_view({ query = state.query, mention = state.mention_only, page = 1 }) {
  state.query = query.trim();
  state.mention_only = mention;
  state.page = page;
  element("search-input").value = state.query;
  element("mention-filter").setAttribute("aria-pressed", String(mention));
  await refresh_room();
}

/** Execute a named view command, retaining existing retry and provenance rules. */
async function execute_view_action(name, value) {
  const event = { preventDefault() {} };
  const actions = { refresh: refresh_room, room: select_room, tab: select_tab,
    send: () => send_message(event), create: () => submit_room(event),
    save_context: () => save_context(event), save_topic: () => save_topic(event),
    schedule: () => schedule_turn(event), filter: filter_view, reply: set_view_reply,
    cancel_reply, cancel_answer: cancel_turn_reply, prepare_answer: prepare_turn_answer,
    copy_turn, notify: () => change_turn_status("notified"), cancel_turn: () => change_turn_status("cancelled"),
    copy_online: () => copy_context(), copy_cli: () => copy_context("cli"), copy_background,
    copy_reading: () => copy_text(`${location.origin}/r/${state.room.id}`), copy: copy_text };
  try {
    await actions[name](value);
    return true;
  } catch (error) {
    show_toast(error.message, true);
    return false;
  } finally { publish_view(); }
}

/** Switch renderers while retaining the shared room, filters, and form drafts. */
function change_view_theme(theme) {
  element("settings-dialog")?.close();
  apply_theme(theme);
  try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* Keep the session preference. */ }
}

window.discuss_view = { snapshot: view_snapshot, write_field: write_view_field,
  write_expert: write_view_expert, execute: execute_view_action, theme: change_view_theme,
  request: request_json, identities: IDENTITIES, sources: SOURCE_LABELS, phases: PHASE_LABELS,
  turns: TURN_LABELS, provenance: message_provenance, format_time };

restore_theme();
document.addEventListener("DOMContentLoaded", initialize);
