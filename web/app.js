"use strict";

const REFRESH_INTERVAL_MS = 12000;
const TOAST_DURATION_MS = 3500;
const SCROLL_BOTTOM_THRESHOLD = 70;
const SUBMISSION_ID_BYTES = 16;
const MAX_MESSAGE_LENGTH = 32000;
const MAX_SUMMARY_LENGTH = 1000;
const DIRECTORY_DRAG_THRESHOLD = 4;
const DIRECTORY_DRAG_OFFSET = 12;
const THEME_STORAGE_KEY = "ai-codiscuss-theme";
const THEMES = ["millennium", "channel"];
const SOURCE_LABELS = { demo: "示例", user: "本人发言", proxy: "用户代发", cli: "CLI 发言", url: "历史 URL 发言", host_proxy: "主持人代发" };
const PHASE_LABELS = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", reviewing: "结论复核", paused: "已暂停", concluded: "已收束" };
const TURN_LABELS = { pending: "待处理", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消" };
const IDENTITIES = {
  "用户": { label: "User", initials: "U", style: "user", icon: "/icons/user.svg", description: "发起与协助" },
  Codex: { initials: "CX", style: "codex", icon: "/icons/openai.svg", description: "AI 身份" },
  Claude: { initials: "CL", style: "claude", icon: "/icons/claude.svg", description: "AI 身份" },
  Gemini: { initials: "GM", style: "gemini", icon: "/icons/gemini.svg", description: "AI 身份" },
  DeepSeek: { initials: "DS", style: "deepseek", icon: "/icons/deepseek.svg", description: "AI 身份" },
  Qwen: { initials: "QW", style: "qwen", icon: "/icons/qwen.svg", description: "AI 身份" },
};
const state = { rooms: [], folders: [], room: null, page: 1, pages: 1, query: "", mention_only: false,
  archive_view: false, management: null, dragged_room: null, folder_moves: new Map(), folder_version: 0,
  reply_to: null, turn_reply_to: null, tab: "topic", refresh_version: 0, context_dirty: false, topic_dirty: false,
  snapshot_id: 0, pending_submission: null, pending_turn: null, pending_room: null, toast_timer: null };
state.messages = [];
state.message_history = null;
state.connected = false;

/** Return a DOM element by its stable ID. */
function element(id) { return document.getElementById(id); }

/** Apply a visual theme without replacing content or changing discussion state. */
function apply_theme(theme) {
  const selected = theme === "retro" ? "millennium" : THEMES.includes(theme) ? theme : "channel";
  const uses_vue = selected === "channel";
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
  document.querySelectorAll("[data-theme-option]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.themeOption === selected));
  });
  publish_view();
}

/** Restore the local preference before the stylesheet and page content load. */
function restore_theme() {
  let theme = "channel";
  try { theme = localStorage.getItem(THEME_STORAGE_KEY); } catch { /* Storage may be disabled. */ }
  change_view_theme(theme);
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

/** Resolve a UI label without changing stored identity values. */
function display_name(name) { return IDENTITIES[name]?.label || name; }

/** Render an identity avatar from a local SVG. */
function identity_avatar(identity) {
  return identity.icon ? `<img src="${identity.icon}" alt="">` : identity.initials;
}

/** Render identity controls and distinguish selectable identities from connections. */
function render_identities() {
  const options = Object.keys(IDENTITIES).map((name) => `<option value="${name}">${display_name(name)}</option>`).join("");
  element("author-select").innerHTML = options;
  element("topic-host-select").innerHTML = options;
  element("new-room-host").innerHTML = options;
  render_expert_inputs("new-expert-modes", default_experts());
  element("participants").innerHTML = Object.entries(IDENTITIES).map(([name, identity]) =>
    `<div class="participant ${identity.style}"><span class="avatar" aria-hidden="true">${identity_avatar(identity)}</span><span class="participant-name">${display_name(name)}</span><span class="participant-role">${identity.description}</span></div>`).join("");
}

/** Render rooms while retaining the selected room. */
function render_rooms() {
  const rooms = visible_rooms();
  element("room-count").textContent = rooms.length;
  element("archive-toggle").textContent = state.archive_view ? "返回讨论频道" : `已存档 (${state.rooms.filter((room) => room.archived).length})`;
  element("archive-toggle").setAttribute("aria-pressed", String(state.archive_view));
  element("room-list").innerHTML = rooms.map((room, index) =>
    `<div class="directory-row" data-drag-room="${room.id}"><button type="button" class="directory-grip" data-drag-handle aria-label="拖动 ${escape_html(room.title)}" title="拖动排序；上下方向键移动">⠿</button><button class="room-item ${room.id === state.room?.id ? "active" : ""}" data-room="${room.id}" title="${escape_html(room.title)}"><span class="room-item-name">${escape_html(room.title)}</span><span class="room-item-number">${room.message_count}</span></button><details class="room-actions"><summary aria-label="管理 ${escape_html(room.title)}">⋯</summary><div>${room_menu_html(room, index, rooms.length)}</div></details></div>`).join("") || "<p class='local-note'>这里还没有频道。</p>";
  element("no-room").hidden = Boolean(state.room);
  element("room-content").hidden = !state.room;
  element("copy-reading").disabled = !state.room;
  element("go-context").disabled = !state.room;
}

/** Return the active directory without hiding archived rooms from deep links. */
function visible_rooms() { return state.rooms.filter((room) => Boolean(room.archived) === state.archive_view); }

/** Provide pointer and keyboard alternatives to dragging in the classic theme. */
function room_menu_html(room, index, count) {
  return [["rename", "重命名"], [room.archived ? "restore" : "archive", room.archived ? "恢复频道" : "存档频道"],
    ["up", "上移", index === 0], ["down", "下移", index === count - 1], ["delete", "删除频道"]]
    .map(([action, label, disabled]) => `<button type="button" data-manage-room="${room.id}" data-room-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`).join("");
}

/** Switch only the directory filter, preserving the open conversation and drafts. */
function toggle_archives() { state.archive_view = !state.archive_view; render_rooms(); publish_view(); }

/** Submit one channel operation and refresh the directory from committed data. */
async function manage_channel({ id, action, title, confirm_title, before_id, folder_id }) {
  if (action === "folder") return assign_channel_folder(id, folder_id ?? null);
  const endpoint = action === "rename" ? "topic" : action;
  const payload = { actor: "用户" };
  if (action === "rename") payload.title = title;
  if (action === "delete") payload.confirm_title = confirm_title;
  if (action === "move") payload.before_id = before_id;
  await request_json(`/api/rooms/${id}/${endpoint}`, payload);
  state.refresh_version++;
  const folder_version = state.folder_version;
  const directory = await request_json("/api/rooms");
  state.rooms = directory.rooms.map((room) => merge_room_folder(room, folder_version));
  state.folders = directory.folders || [];
  if (action === "restore") state.archive_view = false;
  if (state.room?.id === id && ["archive", "delete"].includes(action)) {
    await select_room(visible_rooms()[0]?.id);
  } else await refresh_room();
  render_rooms();
  show_toast({ rename: "频道已重命名", archive: "频道已存档", restore: "频道已恢复", delete: "频道已删除", move: "顺序已保存", folder: "话题归类已更新" }[action]);
}

/** Merge fresh room data without undoing a folder move newer than the read. */
function merge_room_folder(room, version) {
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
  state.folder_moves.set(id, folder_id);
  state.folder_version++;
  display_channel_folder(id, folder_id);
  try {
    const saved = await request_json(`/api/rooms/${id}/folder`, { actor: "用户", folder_id });
    display_channel_folder(id, saved.folder_id ?? null);
    show_toast("话题归类已更新");
  } catch (error) {
    display_channel_folder(id, previous_folder);
    throw error;
  } finally {
    state.folder_moves.delete(id);
    state.folder_version++;
  }
}

/** Create a shared flat folder and refresh the directory without changing selection. */
async function create_folder(name) {
  await request_json("/api/folders", { name });
  const folder_version = state.folder_version;
  const directory = await request_json("/api/rooms");
  state.rooms = directory.rooms.map((room) => merge_room_folder(room, folder_version));
  state.folders = directory.folders || [];
  render_rooms();
  publish_view();
  show_toast("文件夹已创建");
}

/** Move a channel by one visible slot, also available without drag support. */
async function move_channel({ id, direction, folder_id }) {
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
  element("room-subtitle").textContent = `${room.archived ? '已存档 · ' : ''}${room.message_count} 条发言 · 发言权：${floor_status(room)}`;
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
  render_receipts();
  render_host_brief();
  update_composer_role();
}

/** Describe the actual holder or nominated recipient for both themes. */
function floor_status(room) {
  return room.floor?.holder ? `${display_name(room.floor.holder)} 持有` : `待 ${display_name(room.floor?.next_speaker || room.host)} 领取`;
}

/** A round completes only after all configured experts have contributed. */
function progress_round(room) {
  if (!Array.isArray(room.rounds)) return "轮次待同步";
  const latest = room.rounds.at(-1);
  const participants = Object.keys(room.experts).length;
  if (latest && !latest.completed) return `第 ${latest.number} 轮 · ${latest.speakers.length}/${participants} 人已发言`;
  return ["pending", "notified"].includes(room.current_turn?.status)
    ? `第 ${room.completed_rounds + 1} 轮 · 0/${participants} 人已发言` : `已完成 ${room.completed_rounds} 轮`;
}

/** Describe the designated respondent without claiming that their app is generating. */
function progress_speaker(room) {
  const turn = room.current_turn;
  if (room.phase === "concluded") return "讨论已收束";
  if (room.phase === "paused") return `已暂停${turn && ["pending", "notified"].includes(turn.status) ? ` · 原安排 ${turn.expert}` : ""}`;
  if (turn && ["pending", "notified"].includes(turn.status)) return `等待 ${turn.expert} 回答 · ${turn_label(turn, room)}`;
  return room.rounds?.length || room.answered_turns || turn?.status === "answered" ? "等待主持人安排下一步" : "尚未开始发言";
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

/** Show bounded receipt references without interpreting free-form reports as status. */
function render_receipts() {
  const receipts = state.room.latest_receipts;
  const links = receipts?.map((receipt) => `<button type="button" class="text-button" data-receipt-detail="${receipt.id}">${escape_html(display_name(receipt.author))} #${receipt.id} · ${escape_html(new Date(receipt.created_at).toLocaleString("zh-CN"))}${receipt.id > state.room.state_until ? " · 晚于摘要" : ""}</button>`).join("") || "尚无运行回执。";
  for (const id of ["topic-receipts", "state-receipts"]) {
    element(id).hidden = !Array.isArray(receipts);
    element(`${id}-links`).innerHTML = links;
  }
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
  const text = message.kind === "receipt" ? `<details class="message-receipt" data-receipt-id="${message.id}"><summary aria-label="查看运行回执 #${message.id}">运行回执详情</summary>${message.rendered_text}</details>` : message.summary ? `<div class="answer-summary"><small>回答摘要 · ${escape_html(display_name(message.summary_by))}</small>${message.rendered_summary}</div><details class="message-answer" data-answer-id="${message.id}"><summary aria-label="展开完整回答 #${message.id}">完整回答</summary>${message.rendered_text}</details>` : message.rendered_text;
  const reply = message.reply_to ? `<button class="quote-link" data-detail="${message.reply_to}">↳ 回复 #${message.reply_to} · 查看原文</button>` : "";
  return `<article class="message ${identity.style}" id="message-${message.id}"><span class="avatar message-avatar" aria-hidden="true">${identity_avatar(identity)}</span><div class="message-line"><time title="${escape_html(message.created_at)}">[${format_time(message.created_at)}]</time><strong class="message-author">${escape_html(display_name(message.author))}</strong><span class="message-verb"> 说：</span><div class="message-text markdown-body">${text}</div></div><div class="message-details"><span class="source-badge ${message.source === "demo" ? "" : "real"}">${SOURCE_LABELS[message.source] || "发言"}</span><span>${escape_html(message_provenance(message))}</span><button class="message-id" data-detail="${message.id}">#${message.id}</button>${reply}<span class="message-actions"><button data-reply="${message.id}" data-author="${escape_html(message.author)}">回复</button><button data-copy-message="${message.id}">复制原文链接</button></span></div></article>`;
}

/** Render continuous history while retaining expanded answers and reading position. */
function render_messages(result) {
  const previous = new Map(state.messages.map((message) => [message.id, message]));
  state.messages = result.messages.map((message) => previous.get(message.id) || ({ ...message, rendered_text: window.discuss_markdown.render_markdown(message.text), rendered_summary: window.discuss_markdown.render_markdown(message.summary || "") }));
  state.message_total = result.total;
  const container = element("messages");
  const open_receipts = [...container.querySelectorAll(".message-receipt[open]")].map((receipt) => receipt.dataset.receiptId);
  const open_answers = [...container.querySelectorAll(".message-answer[open]")].map((answer) => answer.dataset.answerId);
  const scroll_position = container.scrollTop;
  const is_near_bottom = container.scrollHeight - container.clientHeight - scroll_position < SCROLL_BOTTOM_THRESHOLD;
  state.pages = result.pages;
  container.innerHTML = state.messages.length ? state.messages.map(message_markup).join("") :
    `<div class="empty-messages"><strong>${state.query || state.mention_only ? "没有找到匹配的发言" : "讨论从第一句话开始"}</strong><p>${state.query || state.mention_only ? "换个关键词，或清除筛选后查看完整记录。" : "提出你的问题，邀请不同的观点。"}</p></div>`;
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
  const room_id = state.room?.id;
  const directory = await request_json("/api/rooms");
  if (version !== state.refresh_version) return;
  state.rooms = directory.rooms.map((room) => merge_room_folder(room, folder_version));
  state.folders = directory.folders || [];
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
  state.room = merge_room_folder(room, folder_version);
  render_rooms();
  render_room();
  if (result) render_messages(result);
  set_connection(true);
}

/** Select a room and reset room-specific draft and filter state. */
async function select_room(room_id) {
  state.refresh_version++;
  state.room = state.rooms.find((room) => room.id === room_id);
  state.page = 1;
  state.query = "";
  state.mention_only = false;
  state.context_dirty = false;
  state.topic_dirty = false;
  state.pending_turn = null;
  state.pending_submission = null;
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
  select_tab(document.documentElement.dataset.theme === "channel" ? "discussion" : "topic");
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
  if (payload.kind === "opinion" && payload.author !== "用户") {
    payload.summary = element("message-summary").value.trim();
    payload.summary_by = element("message-summary-source").value === "submitter" ? payload.submitted_by : payload.author;
    if (!payload.summary) throw new Error("请补充本次回答的摘要，保留关键结论、条件与不确定性");
    if ([...payload.summary].length > MAX_SUMMARY_LENGTH) throw new Error(`回答摘要最多 ${MAX_SUMMARY_LENGTH} 字，草稿已保留`);
  }
  if ([...payload.text].length > MAX_MESSAGE_LENGTH) throw new Error(`留言最多 ${MAX_MESSAGE_LENGTH} 字，原文已保留，请调整后提交`);
  const signature = JSON.stringify({ room: state.room.id, ...payload });
  if (state.pending_submission?.signature !== signature) state.pending_submission = { signature, id: new_submission_id() };
  payload.submission_id = state.pending_submission.id;
  element("send-message").disabled = true;
  try {
    const result = await request_json(`/api/rooms/${state.room.id}/messages`, payload);
    element("message-input").value = "";
    element("message-summary").value = "";
    state.pending_submission = null;
    cancel_reply();
    cancel_turn_reply();
    state.query = "";
    state.mention_only = false;
    element("search-input").value = "";
    element("mention-filter").setAttribute("aria-pressed", "false");
    state.page = 1;
    await refresh_room();
    element("messages").scrollTop = element("messages").scrollHeight;
    show_toast(`留言已保存 · #${result.message.id}`);
  } finally { element("send-message").disabled = false; }
}

/** Show exact original content and let the reader follow the reply chain. */
async function show_message(message_id) {
  const message = await request_json(`/api/rooms/${state.room.id}/messages/${message_id}`);
  element("detail-title").textContent = `#${message.id} · ${display_name(message.author)}`;
  const source = SOURCE_LABELS[message.source] || message.source;
  const summary = message.summary ? `回答摘要 · ${display_name(message.summary_by)}\n${message.summary}\n\n完整正文\n` : "";
  element("detail-body").textContent = `${source} · ${message_provenance(message)} · ${new Date(message.created_at).toLocaleString("zh-CN")}\n\n${summary}${message.text}`;
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
  const payload = { title: element("new-room-title").value, goal: element("new-room-goal").value,
    host: element("new-room-host").value, background: element("new-room-background").value,
    boundaries: element("new-room-boundaries").value, experts: read_expert_inputs("new-expert-modes") };
  const signature = JSON.stringify(payload);
  if (state.pending_room?.signature !== signature) state.pending_room = { signature, id: new_submission_id() };
  const room = await request_json("/api/rooms", { ...payload, submission_id: state.pending_room.id });
  state.pending_room = null;
  if (!state.rooms.some((existing) => existing.id === room.id)) state.rooms.push(room);
  element("room-dialog").close();
  element("room-form").reset();
  render_expert_inputs("new-expert-modes", default_experts());
  await select_room(room.id);
  select_tab(document.documentElement.dataset.theme === "channel" ? "discussion" : "topic");
  show_toast("话题已创建");
}

/** Persist a manually edited summary with the snapshot it was based on. */
async function save_context(event) {
  event.preventDefault();
  await request_json(`/api/rooms/${state.room.id}/state`, { actor: state.room.host, text: element("state-input").value, brief: element("brief-input").value, until: state.snapshot_id });
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
  await copy_text(`请以${identity}参与讨论。${instruction}\n话题入口：${address}\n先检查阶段和安排；独立观点阶段只读目标、背景、边界和自己的已有讨论，提交后再读他人观点。每次回答先给简短摘要，再给完整正文，保留关键理由、条件与不确定性。暂停或收束时不追加观点。其余材料按需阅读，不必读取全部历史。`);
}

/** Copy a bounded background startup contract without starting any external task. */
async function copy_background() {
  const participant = element("author-select").value;
  if (participant === "用户" || state.room.experts[participant] !== "cli") throw new Error("请先在讨论区选择已配置为本地 CLI 的专家身份");
  const base = `${location.origin}/r/${state.room.id}`;
  const params = new URLSearchParams({ mode: "cli", participant });
  await copy_text(`请调用 discuss-participant 参与讨论。\n话题：${state.room.title}\n配置：你是 ${participant}，作为 CLI 专家持续参与；主持人为 ${state.room.host}。\n房间入口：${base}?${params}\n本次约定从房间资料和当前安排读取。`);
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
  element("topic-host").textContent = `主持人：${display_name(room.host)} · 可以同时作为专家参与`;
  for (const field of ["goal", "focus", "background", "boundaries"]) element(`topic-${field}`).textContent = room[field] || "尚未填写";
  element("topic-experts").textContent = Object.entries(room.experts).map(([name, mode]) =>
    `${name} · ${mode === "cli" ? "本地 CLI，可读可写" : "在线 AI，只读"}${name === room.host ? " · 兼任主持人" : ""}`).join("\n");
  element("turn-history").href = `${location.origin}/r/${room.id}/turns?page=1`;
  element("host-operator").textContent = `当前以 ${display_name(room.host)} 的主持职责管理话题。AI 主持人通过 CLI 操作；用户可在这里协助。`;
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
  const floor = state.room.floor;
  element("floor-status").textContent = floor_status(state.room);
  element("take-floor").disabled = !floor || Boolean(floor.holder);
  element("take-floor").textContent = `为 ${display_name(floor?.next_speaker || state.room.host)} 领取`;
  element("return-floor").disabled = !floor?.holder;
  const turn = state.room.current_turn;
  const active = turn && ["pending", "notified"].includes(turn.status);
  const inactive = ["paused", "concluded"].includes(state.room.phase);
  element("turn-status").textContent = turn_label(turn, state.room);
  element("turn-note").textContent = turn_guidance(turn, state.room);
  element("turn-expert").textContent = turn ? `#${turn.id} · ${turn.expert}` : "由主持人安排下一位专家";
  element("turn-question").textContent = turn?.question || "在下方展开主持管理，填写本轮待回应的问题。";
  element("copy-turn").disabled = !active || inactive;
  element("confirm-notified").disabled = !turn || turn.status !== "pending" || inactive;
  element("forward-turn").disabled = !active || inactive;
  element("cancel-turn").disabled = !active;
  element("view-turn-answer").hidden = !turn?.answer_id;
  const unavailable = active || inactive || !Object.keys(state.room.experts).length || floor?.holder !== state.room.host;
  element("schedule-turn").disabled = Boolean(unavailable);
  element("schedule-note").textContent = inactive ? "话题已暂停或收束；恢复阶段后才能继续安排。" :
    (active ? "先完成或取消当前安排，再安排下一位。" : floor?.holder !== state.room.host ? "主持人领取发言权后可安排下一位。" : "创建后本地专家可自行检查；在线专家需由主持人或用户联系。");
}

/** Perform one explicit, versioned floor operation on behalf of its speaker. */
async function change_floor(action) {
  const floor = state.room.floor;
  const speaker = action === "take" ? floor.next_speaker : floor.holder;
  try {
    await request_json(`/api/rooms/${state.room.id}/floor`, { actor: "用户", speaker, action, revision: floor.revision });
    show_toast(action === "take" ? `${display_name(speaker)} 已领取发言权` : "发言权已归还");
  } finally { await refresh_room(); }
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
  element("message-kind").value = "forward";
  element("author-select").value = turn.expert;
  state.turn_reply_to = turn.id;
  element("turn-answer-label").textContent = `回答安排 #${turn.id} · ${turn.expert}，由 ${display_name(state.room.host)} 代发`;
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
  const needs_summary = ["opinion", "forward"].includes(mode) && element("author-select").value !== "用户";
  element("message-summary-fields").hidden = !needs_summary;
  element("message-summary").required = needs_summary;
  element("author-note").textContent = mode === "receipt" ? "运行回执，由用户录入" : mode === "moderation" ? "主持发言" :
    (mode === "forward" ? `由 ${display_name(state.room?.host) || "主持人"} 代发` : (element("author-select").value === "用户" ? "发言" : "的观点代发"));
}

/** Bind the topic workflow separately from existing chat controls. */
function bind_host_controls() {
  const actions = { "topic-context": () => select_tab("context"), "edit-host-brief": () => select_tab("context"), "topic-history": () => select_tab("discussion"),
    "take-floor": () => change_floor("take"), "return-floor": () => change_floor("return"),
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
  element("room-content").addEventListener("click", (event) => {
    const receipt = event.target.closest("[data-receipt-detail]");
    if (receipt) run_action(() => show_message(receipt.dataset.receiptDetail));
  });
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
  if (["up", "down"].includes(action)) return move_channel({ id, direction: action === "up" ? -1 : 1 });
  const room = state.rooms.find((item) => item.id === id);
  if (!room) return;
  state.management = { id, action };
  element("manage-title").textContent = { rename: "重命名频道", archive: "存档频道", restore: "恢复频道", delete: "删除频道" }[action];
  element("manage-description").textContent = action === "delete" ? `永久删除「${room.title}」及其 ${room.message_count} 条消息、共识和发言安排。无法撤销。请输入完整频道名称确认。` :
    action === "archive" ? `存档「${room.title}」后移入已存档列表，保留记录并暂停未收束的讨论。` : action === "restore" ? `恢复「${room.title}」到讨论列表；讨论阶段仍保持暂停或收束。` : "修改名称不会影响记录和阅读地址。";
  element("manage-input-label").hidden = !["rename", "delete"].includes(action);
  element("manage-input").value = action === "rename" ? room.title : "";
  element("manage-input").required = ["rename", "delete"].includes(action);
  element("manage-input").dataset.expected = room.title;
  element("manage-submit").textContent = action === "delete" ? "永久删除" : "确认";
  element("manage-submit").disabled = action === "delete";
  element("manage-dialog").showModal();
}

/** Bind classic directory menus, confirmation forms and native drag targets. */
function bind_directory_controls() {
  element("archive-toggle").addEventListener("click", toggle_archives);
  element("close-manage").addEventListener("click", () => element("manage-dialog").close());
  element("manage-input").addEventListener("input", () => {
    element("manage-submit").disabled = state.management?.action === "delete" && element("manage-input").value !== element("manage-input").dataset.expected;
  });
  element("manage-form").addEventListener("submit", (event) => {
    event.preventDefault();
    run_action(async () => {
      element("manage-submit").disabled = true;
      try {
        await manage_channel({ ...state.management, title: element("manage-input").value, confirm_title: element("manage-input").value });
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
  const row = handle.closest("[data-drag-room]");
  if (state.folder_moves.has(row.dataset.dragRoom)) return;
  delete handle.dataset.suppressDragClick;
  handle.removeEventListener("click", suppress_directory_drag_click, true);
  if (event.pointerType === "touch" && handle.hasAttribute("data-drag-title")) return;
  event.preventDefault();
  event.stopPropagation();
  handle.addEventListener("click", suppress_directory_drag_click, true);
  state.dragged_room = { id: row.dataset.dragRoom, folder_id: row.closest("[data-room-folder]")?.dataset.roomFolder || null,
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
  if (document.documentElement.dataset.theme !== "channel") return;
  if (!drag.preview) {
    drag.preview = document.createElement("div");
    drag.preview.className = "channel-drag-preview";
    drag.preview.textContent = state.rooms.find((room) => room.id === drag.id)?.title || "话题";
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
  const folder = hit.closest("[data-room-folder]");
  const folder_id = folder?.dataset.roomFolder || null;
  if (folder && folder_id !== drag.folder_id) {
    folder.querySelector("[data-drop-folder]")?.classList.add("drop-folder");
    drag.target = { action: "folder", folder_id };
    return;
  }
  const target = hit.closest("[data-drag-room]");
  if (!target || target.dataset.dragRoom === drag.id) return;
  const rect = target.getBoundingClientRect();
  const after = event.clientY > rect.top + rect.height / 2;
  drag.target = { action: "move", id: target.dataset.dragRoom, after };
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
  if (target.action === "folder") return run_action(() => manage_channel({ id: drag.id, action: "folder", folder_id: target.folder_id }));
  const rooms = visible_rooms();
  const index = rooms.findIndex((room) => room.id === target.id);
  const before_id = target.after ? rooms[index + 1]?.id ?? null : target.id;
  if (before_id !== drag.id) run_action(() => manage_channel({ id: drag.id, action: "move", before_id }));
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
  element("brief-input").addEventListener("input", () => { state.context_dirty = true; });
  element("message-input").addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); element("message-form").requestSubmit(); }
  });
}

/** Load persisted discussion data and keep visible pages up to date. */
async function initialize() {
  bind_theme_controls();
  render_identities();
  bind_delegated_actions();
  bind_directory_controls();
  bind_controls();
  bind_host_controls();
  try {
    const result = await request_json("/api/rooms");
    state.rooms = result.rooms;
    state.folders = result.folders || [];
    const requested = new URLSearchParams(location.search).get("room");
    await select_room(state.rooms.some((room) => room.id === requested) ? requested : visible_rooms()[0]?.id);
    set_connection(true);
  } catch (error) { set_connection(false); show_toast(error.message, true); }
  setInterval(async () => {
    if (document.hidden) return;
    try { await refresh_room(); } catch { set_connection(false); }
  }, REFRESH_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) run_action(refresh_room); });
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
  return { rooms: state.rooms, folders: state.folders, room: state.room, archive_view: state.archive_view, messages: state.messages, total: state.message_total,
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

/** Execute a named view command, retaining existing retry and provenance rules. */
async function execute_view_action(name, value) {
  const event = { preventDefault() {} };
  const actions = { refresh: refresh_room, room: select_room, tab: select_tab,
    archives: toggle_archives, manage_channel, move_channel, create_folder,
    send: () => send_message(event), create: () => submit_room(event),
    save_context: () => save_context(event), save_topic: () => save_topic(event),
    schedule: () => schedule_turn(event), filter: filter_view, reply: set_view_reply,
    cancel_reply, cancel_answer: cancel_turn_reply, prepare_answer: prepare_turn_answer,
    copy_turn, notify: () => change_turn_status("notified"), cancel_turn: () => change_turn_status("cancelled"),
    take_floor: () => change_floor("take"), return_floor: () => change_floor("return"),
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
  try { localStorage.setItem(THEME_STORAGE_KEY, document.documentElement.dataset.theme); } catch { /* Keep the session preference. */ }
}

window.discuss_view = { snapshot: view_snapshot, write_field: write_view_field,
  start_drag: start_directory_drag,
  write_expert: write_view_expert, execute: execute_view_action, theme: change_view_theme,
  request: request_json, identities: IDENTITIES, display_name, sources: SOURCE_LABELS, phases: PHASE_LABELS,
  turns: TURN_LABELS, turn_label, turn_guidance, floor_status, progress_round, progress_speaker, brief_meta, max_message_length: MAX_MESSAGE_LENGTH, provenance: message_provenance, format_time };

restore_theme();
document.addEventListener("DOMContentLoaded", initialize);
