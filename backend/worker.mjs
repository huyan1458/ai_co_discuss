/** Cloudflare Workers / D1 adapter for the existing discussion HTTP protocol. */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 255;
const MAX_TEXT_LENGTH = 32000;
const MAX_STATE_LENGTH = 4000;
const MAX_BRIEF_LENGTH = 1600;
const MAX_SUMMARY_LENGTH = 1000;
const PAGE_SIZE = 20;
const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";
const PARTICIPANTS = ["用户", "Codex", "Claude", "Gemini", "DeepSeek", "Qwen"];
const PHASES = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", reviewing: "结论复核", paused: "已暂停", concluded: "已收束" };
const TURN_STATUSES = { pending: "待处理", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消", queued: "排队中", skipped: "未开始即取消" };
const MAX_TOPIC_DETAIL = 4000;
const MAX_QUESTION_LENGTH = 1000;
const MAX_PLAN_TURNS = 10;
const LIMIT_DEFAULTS = { max_rounds: 0, max_minutes: 0, execution_minutes: 0, on_limit: "pause", summary_minutes: 5 };
// Idle (paused, preparing or concluded) seconds are excluded from elapsed time and total-duration deadlines.
const LIMITS_SQL = `SELECT limits.*,COALESCE(pauses.paused_seconds,0)+CASE WHEN COALESCE(pauses.paused_at,0)>0
  THEN MAX(0,CAST(strftime('%s','now') AS INTEGER)-pauses.paused_at) ELSE 0 END AS idle_seconds
  FROM discussion_limits AS limits LEFT JOIN discussion_pauses AS pauses USING(room_id) WHERE limits.room_id=?`;
const TIMING_ITEMS = 20;
// Queue: created -> dispatched; wake: dispatched -> entered; work: entered -> finished. Open stages run to now.
const TIMING_SQL = `SELECT e.id,e.participant,e.role,e.cause,e.status,
  MAX(0,CASE WHEN t.dispatched_at>0 THEN t.dispatched_at ELSE ? END-CAST(strftime('%s',e.created_at) AS INTEGER)) AS queue_seconds,
  CASE WHEN t.dispatched_at>0 THEN MAX(0,COALESCE(NULLIF(e.started_at,0),NULLIF(t.finished_at,0),?)-t.dispatched_at) END AS wake_seconds,
  CASE WHEN e.started_at>0 THEN MAX(0,COALESCE(NULLIF(t.finished_at,0),?)-e.started_at) END AS work_seconds
  FROM discussion_events AS e LEFT JOIN event_timings AS t ON t.event_id=e.id
  WHERE e.room_id=? AND e.run_id=? AND (t.dispatched_at>0 OR e.status='pending') ORDER BY e.id DESC`;
const ROOM_BACKUP_QUERIES = {
  rooms: "SELECT * FROM rooms WHERE id=?",
  ...Object.fromEntries(["room_directory", "room_folder_assignments", "room_creations", "room_briefs", "room_user_requests", "topic_settings", "room_floor", "discussion_limits"]
    .map((table) => [table, `SELECT * FROM ${table} WHERE room_id=?`])),
  topic_folders: "SELECT * FROM topic_folders WHERE id IN (SELECT folder_id FROM room_folder_assignments WHERE room_id=?)",
  messages: "SELECT * FROM messages WHERE room_id=? ORDER BY id",
  attachments: "SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL ORDER BY message_id,position",
  discussion_turns: "SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id",
  ...Object.fromEntries(["message_details", "message_summaries", "message_timings"]
    .map((table) => [table, `SELECT * FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE room_id=?) ORDER BY message_id`])),
};
const MESSAGE_QUERY = `SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
  COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','url','user')
  THEN messages.author ELSE '用户' END) AS submitted_by, details.turn_id,
  COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds
  FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
  LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
  LEFT JOIN message_timings AS timing ON timing.message_id=messages.id`;
const ROOM_QUERY = `SELECT rooms.*, COALESCE(room_directory.archived,0) AS archived, COUNT(messages.id) AS message_count,
  COALESCE(MAX(messages.id),0) AS latest_id, room_folder_assignments.folder_id AS folder_id FROM rooms
  LEFT JOIN room_directory ON rooms.id=room_directory.room_id
  LEFT JOIN room_folder_assignments ON rooms.id=room_folder_assignments.room_id
  LEFT JOIN messages ON rooms.id=messages.room_id`;

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

/** Parse an integer without accepting fractions, NaN, or empty values. */
function integer(value) {
  if (!/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw new HttpError(400, "请输入有效整数");
  }
  return Number(value);
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
async function read_payload(request) {
  const data = await read_bytes(request, MAX_BODY_BYTES);
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

/** Export one room's original rows in a single, read-only D1 batch transaction. */
async function room_backup(database, room_id) {
  const entries = Object.entries(ROOM_BACKUP_QUERIES);
  const results = await database.batch(entries.map(([, query]) => database.prepare(query).bind(room_id)));
  const tables = Object.fromEntries(entries.map(([table], index) => [table, results[index].results]));
  if (!tables.rooms.length) throw new HttpError(404, "房间不存在");
  return { format: "ai-codiscuss-room-backup", version: 1, exported_at: new Date().toISOString(), tables };
}

/** Confirm a room exists without loading its full view; for polled endpoints that only need the 404. */
async function require_room_id(database, room_id) {
  if (!await database.prepare("SELECT 1 FROM rooms WHERE id=?").bind(room_id).first()) throw new HttpError(404, "房间不存在");
}

/** Read a room with its actual history count and latest message ID. */
async function require_room(database, room_id) {
  const room = await database.prepare(`${ROOM_QUERY} WHERE rooms.id=? GROUP BY rooms.id`)
    .bind(room_id).first();
  if (!room) throw new HttpError(404, "房间不存在");
  const settings = await database.prepare("SELECT * FROM topic_settings WHERE room_id=?").bind(room_id).first();
  const current_turn = await database.prepare(`SELECT *, (SELECT COUNT(*) FROM discussion_turns WHERE room_id=? AND status='answered') AS answered_turns
    FROM discussion_turns WHERE room_id=? AND status NOT IN ('queued','skipped')
    ORDER BY status IN ('pending','notified') DESC, id DESC LIMIT 1`).bind(room_id, room_id).first();
  const result = { ...room, ...(settings ? { ...settings, experts: JSON.parse(settings.experts) } : topic_defaults()), current_turn, answered_turns: current_turn?.answered_turns || 0 };
  const original = await database.prepare("SELECT text FROM room_user_requests WHERE room_id=?").bind(room_id).first();
  Object.assign(result, topic_context(result.background, original?.text));
  if (current_turn) delete current_turn.answered_turns;
  if (current_turn) current_turn.status_label = turn_status_label(current_turn, result);
  result.queued_turns = (await database.prepare("SELECT id,expert,question FROM discussion_turns WHERE room_id=? AND status='queued' ORDER BY id").bind(room_id).all()).results;
  result.held_since = (await database.prepare("SELECT held_since FROM turn_relay WHERE room_id=?").bind(room_id).first())?.held_since || 0;
  result.latest_receipts = await latest_receipts(database, room_id);
  result.host_brief = await database.prepare("SELECT text,until,updated_at FROM room_briefs WHERE room_id=?").bind(room_id).first();
  result.rounds = await discussion_rounds(database, room_id, result.experts);
  result.completed_rounds = result.rounds.filter((item) => item.completed).length;
  result.floor = await database.prepare("SELECT holder,next_speaker,revision FROM room_floor WHERE room_id=?").bind(room_id).first();
  result.runtime = await runtime_view(database, room_id);
  result.limits = limits_view(await database.prepare(LIMITS_SQL).bind(room_id).first(), result);
  return result;
}

/** Claim or return the nominated speaker's floor with an atomic revision check. */
async function update_floor(database, room_id, payload) {
  const room = await require_room(database, room_id);
  const { actor, action, revision } = payload;
  const speaker = payload.speaker ?? actor;
  const proxy = actor === room.host && room.experts[speaker] === "online";
  if (!PARTICIPANTS.includes(speaker) || (![speaker, "用户"].includes(actor) && !proxy)) throw new HttpError(400, "本地专家自行操作发言权；主持人仅代操作在线专家，用户可协助");
  if (!["take", "return"].includes(action) || !Number.isInteger(revision) || revision < 0) throw new HttpError(400, "请提供 take/return 和最新的发言权 revision");
  const statement = action === "take"
    ? database.prepare("UPDATE room_floor SET holder=?,revision=revision+1 WHERE room_id=? AND revision=? AND holder IS NULL AND next_speaker=? RETURNING holder,next_speaker,revision").bind(speaker, room_id, revision, speaker)
    : database.prepare("UPDATE room_floor SET holder=NULL,next_speaker=COALESCE((SELECT host FROM topic_settings WHERE room_id=?),'用户'),revision=revision+1 WHERE room_id=? AND revision=? AND holder=? RETURNING holder,next_speaker,revision").bind(room_id, room_id, revision, speaker);
  const result = await statement.first();
  if (!result) throw new HttpError(409, "发言权已变化，或尚未轮到本人；请重新读取后核对");
  return result;
}

/** Group complete history metadata until every configured expert has spoken. */
async function discussion_rounds(database, room_id, experts) {
  const participants = Object.keys(experts);
  if (!participants.length) return [];
  const rows = await database.prepare(`SELECT messages.id,messages.author,
    COALESCE(details.kind,'opinion') AS kind FROM messages
    LEFT JOIN message_details AS details ON details.message_id=messages.id
    WHERE room_id=? ORDER BY messages.id`).bind(room_id).all();
  const rounds = [];
  let next_start = null;
  for (const message of rows.results) {
    next_start ??= message.id;
    if (message.kind !== "opinion" || !participants.includes(message.author)) continue;
    if (!rounds.length || rounds.at(-1).completed) {
      rounds.push({ number: rounds.length + 1, start_id: next_start, speakers: [], completed: false });
    }
    const current = rounds.at(-1);
    if (!current.speakers.includes(message.author)) current.speakers.push(message.author);
    current.completed = current.speakers.length === participants.length;
    if (current.completed) next_start = null;
  }
  return rounds;
}

/** Return each author's latest receipt reference without loading its body. */
async function latest_receipts(database, room_id) {
  const result = await database.prepare(`SELECT messages.id,messages.author,messages.created_at,details.submitted_by
    FROM messages JOIN message_details AS details ON details.message_id=messages.id
    WHERE messages.id IN (SELECT MAX(messages.id) FROM messages
      JOIN message_details AS details ON details.message_id=messages.id
      WHERE room_id=? AND details.kind='receipt' GROUP BY author)
    ORDER BY messages.id`).bind(room_id).all();
  return result.results;
}

/** Describe pending work using the expert's configured participation mode. */
function turn_status_label(turn, room) {
  if (turn.status === "pending") return { cli: "待处理（本地 CLI）", online: "待联系（在线专家）" }[room.experts[turn.expert]] || "待处理";
  return TURN_STATUSES[turn.status];
}

/** Link to current receipt reports independently of an older host summary. */
function receipt_references_text(room) {
  const lines = room.latest_receipts.map((receipt) => `${receipt.author} · ${receipt.created_at}${receipt.id > room.state_until ? " · 晚于摘要" : ""}：/r/${room.id}/messages/${receipt.id}`);
  return lines.length ? `最新运行回执（每位参与者最近一条，运行结果以原文为准）：\n${lines.join("\n")}` : "尚无运行回执。";
}

/** Separate explicitly marked legacy requests without guessing unmarked text. */
function topic_context(background, user_request) {
  if (user_request === undefined) {
    const match = background.match(/^用户原文[：:][ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n){2,}((?:项目背景与入口|背景)[：:][\s\S]*)$/);
    if (match) { user_request = match[1]; background = match[2]; }
  }
  return { user_request: user_request || "", background };
}

/** Return independent defaults for legacy rooms without settings. */
function topic_defaults() {
  return { host: "用户", background: "", boundaries: "", phase: "preparing", focus: "",
    experts: Object.fromEntries(PARTICIPANTS.slice(1).map((name) => [name, name === "Codex" ? "cli" : "online"])) };
}

/** Validate topic information and require an AI host to have CLI capability. */
function topic_values(payload, current = {}) {
  const result = { ...topic_defaults(), ...current };
  const limits = { title: 80, goal: 1000, user_request: MAX_TOPIC_DETAIL, background: MAX_TOPIC_DETAIL, boundaries: MAX_TOPIC_DETAIL, focus: MAX_QUESTION_LENGTH };
  for (const [field, limit] of Object.entries(limits)) {
    const value = String(payload[field] ?? result[field] ?? "");
    result[field] = field === "user_request" ? value : value.trim();
    if (text_length(result[field]) > limit || (field === "title" && !result[field])) throw new HttpError(400, `${field} 内容为空或超过 ${limit} 字`);
  }
  for (const field of ["host", "phase", "experts"]) result[field] = payload[field] ?? result[field];
  const experts = result.experts;
  if (!experts || typeof experts !== "object" || Array.isArray(experts) ||
    Object.entries(experts).some(([name, mode]) => !PARTICIPANTS.slice(1).includes(name) || !["cli", "online"].includes(mode))) {
    throw new HttpError(400, "专家需为有效 AI 身份，参与方式为 cli 或 online");
  }
  if (result.host !== "用户" && experts[result.host] !== "cli") throw new HttpError(400, "AI 主持人必须是可读可写的本地 CLI 参与者");
  if (!Object.hasOwn(PHASES, result.phase)) throw new HttpError(400, "话题阶段无效");
  if (Object.hasOwn(payload, "limits")) {
    result.limits = limit_values(payload.limits, current.limits);
    const changed = current.limits && Object.keys(LIMIT_DEFAULTS).some(key => result.limits[key] !== current.limits[key]);
    if (changed && !["preparing", "paused"].includes(current.phase)) throw new HttpError(400, "请先暂停讨论，再修改上限参数");
    result.save_limits = !current.limits || changed;
    result.reset_closing = !current.limits || Object.keys(LIMIT_DEFAULTS).some(key => key !== "execution_minutes" && result.limits[key] !== current.limits[key]);
  }
  return result;
}

/** Prepare an upsert shared by topic creation and maintenance. */
function topic_statements(database, room_id, settings) {
  return [database.prepare(`INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET host=excluded.host,background=excluded.background,
    boundaries=excluded.boundaries,experts=excluded.experts,phase=excluded.phase,focus=excluded.focus`)
    .bind(room_id, settings.host, settings.background, settings.boundaries, JSON.stringify(settings.experts), settings.phase, settings.focus),
    database.prepare("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text")
      .bind(room_id, settings.user_request || "")];
}

/** Check a declared operator without claiming authentication. */
function require_host(room, payload) {
  if (![room.host, "用户"].includes(payload.actor)) throw new HttpError(400, "请使用当前主持人或用户身份管理话题");
}

/** Maintain the topic without changing original messages. */
async function update_topic(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const settings = topic_values(payload, room);
  if (room.archived && !["paused", "concluded"].includes(settings.phase)) throw new HttpError(400, "请先恢复已存档频道，再调整讨论阶段");
  const turn = room.current_turn;
  if (turn && ["pending", "notified"].includes(turn.status) && (settings.phase === "concluded" || !settings.experts[turn.expert])) {
    throw new HttpError(400, "请先完成或取消当前发言安排");
  }
  if (settings.save_limits) database = guarded_database(database,
    "EXISTS(SELECT 1 FROM topic_settings JOIN discussion_limits USING(room_id) WHERE room_id=? AND phase IN ('preparing','paused') AND revision=?)",
    [room_id, room.limits.revision]);
  try {
    await database.batch([
      database.prepare("UPDATE rooms SET title=?,goal=? WHERE id=?").bind(settings.title, settings.goal, room_id),
      ...limit_statements(database, room_id, settings),
      ...topic_statements(database, room_id, settings),
    ]);
  } catch (error) {
    if (String(error).includes("open_turn")) throw new HttpError(400, "请先完成或取消当前发言安排");
    if (String(error).includes("topic_archived")) throw new HttpError(400, "请先恢复已存档频道，再调整讨论阶段");
    throw error;
  }
  return require_room(database, room_id);
}

/** Validate a replay identifier for writes or exact result lookup. */
function submission_value(value) {
  const identifier = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(identifier)) throw new HttpError(400, "submission_id 必须是 8–100 位字母、数字、下划线或连字符");
  return identifier;
}

/** Freeze normalized creation inputs independently of later topic edits. */
function creation_request(settings) {
  const fields = ["title", "goal", "host", "background", "boundaries", "phase", "focus"];
  const experts = Object.entries(settings.experts).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const request = JSON.stringify([...fields.map((field) => settings[field]), experts,
    ...(settings.save_limits ? [Object.keys(LIMIT_DEFAULTS).map(key => settings.limits[key])] : [])]);
  return request + (settings.user_request ? `:user_request:${JSON.stringify(settings.user_request)}` : "");
}

/** Recover a committed creation, rejecting reuse for a different request. */
async function replay_room(database, previous, request_text) {
  if (previous.request_text !== request_text) throw new HttpError(409, "该建房提交编号已被其他内容使用");
  return { ...await require_room(database, previous.room_id), duplicate: true, submission_id: previous.submission_id };
}

/** Create one room per explicit identifier, atomically with its saved request. */
async function create_room(database, payload, control_token = "") {
  // Free rooms need owner/member credential checks this backend does not implement yet; refuse before any write.
  if (payload.mode === "free") throw new HttpError(400, "线上站点暂不支持自由协作房间，请在本机网站创建");
  if (!["brainstorm", undefined].includes(payload.mode)) throw new HttpError(400, "房间模式须为 free 或 brainstorm");
  const settings = topic_values(payload);
  const automatic = payload.runtime_mode === "automatic";
  const hashed = await runtime_hash(control_token);
  if (!["manual", "automatic"].includes(payload.runtime_mode ?? "manual") || (automatic && !hashed)) throw new HttpError(400, "自动建房须提供有效的运行模式和控制凭据");
  const identifier = Object.hasOwn(payload, "submission_id") ? submission_value(payload.submission_id) : null;
  const folder_id = payload.folder_id ?? null;
  if (folder_id !== null && typeof folder_id !== "string") throw new HttpError(400, "文件夹编号必须是文本或 null");
  const request_text = creation_request(settings) + (automatic ? ":automatic" : "") + (folder_id === null ? "" : `:folder:${JSON.stringify(folder_id)}`);
  const lookup = () => database.prepare("SELECT * FROM room_creations WHERE submission_id=?").bind(identifier).first();
  const previous = identifier ? await lookup() : null;
  if (previous) return replay_room(database, previous, request_text);
  if (folder_id !== null && !(await database.prepare("SELECT 1 FROM topic_folders WHERE id=?").bind(folder_id).first())) {
    throw new HttpError(400, "文件夹不存在");
  }
  const room_id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const statements = [
    database.prepare("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)")
      .bind(room_id, settings.title, settings.goal, new Date().toISOString()),
    database.prepare("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?").bind(folder_id, room_id),
    ...limit_statements(database, room_id, settings),
    ...topic_statements(database, room_id, settings),
  ];
  if (identifier) statements.push(database.prepare("INSERT INTO room_creations (submission_id,room_id,request_text) VALUES (?,?,?)")
    .bind(identifier, room_id, request_text));
  if (automatic) statements.push(database.prepare("INSERT INTO discussion_runtime(room_id,mode,run_id,status,control_hash,updated_at) VALUES (?,'automatic',?,'ready',?,datetime('now'))")
    .bind(room_id, crypto.randomUUID(), hashed));
  try {
    await database.batch(statements);
  } catch (error) {
    const committed = identifier ? await lookup() : null;
    if (committed) return replay_room(database, committed, request_text);
    throw error;
  }
  return { ...await require_room(database, room_id), duplicate: false, submission_id: identifier };
}

/** Locate a saved creation without searching room titles or histories. */
async function query_rooms(database, params) {
  const identifier = Object.hasOwn(params, "submission_id") ? submission_value(params.submission_id) : null;
  const where = identifier ? "WHERE EXISTS (SELECT 1 FROM room_creations WHERE room_id=rooms.id AND submission_id=?)" : "";
  const statement = database.prepare(`${ROOM_QUERY} ${where} GROUP BY rooms.id ORDER BY room_directory.position,rooms.created_at,rooms.id`);
  const rows = await (identifier ? statement.bind(identifier) : statement).all();
  return { rooms: rows.results, ...await folder_directory(database), participants: PARTICIPANTS };
}

/** Read real folders and the virtual group's index in a single snapshot. */
async function folder_directory(database) {
  const [folders, settings] = await database.batch([
    database.prepare("SELECT id,name,position FROM topic_folders ORDER BY position,name,id"),
    database.prepare("SELECT uncategorized_position FROM directory_settings WHERE id=1"),
  ]);
  return { folders: folders.results, uncategorized_position: settings.results[0]?.uncategorized_position ?? null };
}

/** Validate shared folder names consistently for creation and renaming. */
function folder_name_value(payload) {
  if (typeof payload.name !== "string") throw new HttpError(400, "文件夹名称必须是文本");
  const name = payload.name.trim();
  if (!name || text_length(name) > 40) throw new HttpError(400, "文件夹名称须为 1–40 个字符");
  return name;
}

/** Rename one folder without changing its saved order or conversation membership. */
async function rename_folder(database, folder_id, payload) {
  const name = folder_name_value(payload);
  const folder = await database.prepare("UPDATE topic_folders SET name=? WHERE id=? RETURNING id,name,position").bind(name, folder_id).first();
  if (!folder) throw new HttpError(404, "文件夹不存在");
  return folder;
}

/** Remove a group atomically, retaining all rooms through the existing foreign key. */
async function delete_folder(database, folder_id) {
  const directory = await folder_directory(database);
  const index = directory.folders.findIndex(folder => folder.id === folder_id);
  if (index < 0) throw new HttpError(404, "文件夹不存在");
  let position = directory.uncategorized_position;
  if (position !== null) {
    position -= Number(index < position);
    if (position >= directory.folders.length - 1) position = null;
  }
  await database.batch([
    database.prepare("DELETE FROM topic_folders WHERE id=?").bind(folder_id),
    database.prepare("UPDATE directory_settings SET uncategorized_position=? WHERE id=1").bind(position),
  ]);
  return { deleted: true, id: folder_id };
}

/** Move an existing folder before another (or last), returning the saved directory. */
async function move_folder(database, folder_id, payload) {
  const directory = await folder_directory(database);
  const groups = directory.folders;
  groups.splice(directory.uncategorized_position ?? groups.length, 0, { id: UNCATEGORIZED_FOLDER_ID });
  const moving = groups.find((folder) => folder.id === folder_id);
  if (!moving) throw new HttpError(404, "文件夹不存在");
  const folders = groups.filter((folder) => folder.id !== folder_id);
  const before = payload.before_id ?? null;
  const index = folders.findIndex((folder) => folder.id === before);
  if (before !== null && index < 0) throw new HttpError(400, "目标文件夹不存在或与当前文件夹相同");
  folders.splice(before === null ? folders.length : index, 0, moving);
  const virtual_index = folders.findIndex((folder) => folder.id === UNCATEGORIZED_FOLDER_ID);
  const ordered = folders.filter((folder) => folder.id !== UNCATEGORIZED_FOLDER_ID).map((folder, position) => ({ ...folder, position: position + 1 }));
  const uncategorized_position = virtual_index === ordered.length ? null : virtual_index;
  await database.batch([
    ...ordered.map((folder) => database.prepare("UPDATE topic_folders SET position=? WHERE id=?").bind(folder.position, folder.id)),
    database.prepare("INSERT INTO directory_settings (id,uncategorized_position) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET uncategorized_position=excluded.uncategorized_position").bind(uncategorized_position),
  ]);
  return { folders: ordered, uncategorized_position };
}

/** Persist channel management atomically without touching other rooms. */
async function manage_room(database, room_id, action, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const statements = [];
  if (action === "move") {
    const rooms = (await query_rooms(database, {})).rooms.map((item) => item.id).filter((id) => id !== room_id);
    const before = payload.before_id ?? null;
    if (before !== null && !rooms.includes(before)) throw new HttpError(400, "目标频道不存在或与当前频道相同");
    rooms.splice(before ? rooms.indexOf(before) : rooms.length, 0, room_id);
    statements.push(...rooms.map((id, index) => database.prepare("UPDATE room_directory SET position=? WHERE room_id=?").bind(index + 1, id)));
  } else if (action === "folder") {
    const folder_id = payload.folder_id ?? null;
    if (folder_id !== null && (typeof folder_id !== "string" || !(await database.prepare("SELECT 1 FROM topic_folders WHERE id=?").bind(folder_id).first()))) {
      throw new HttpError(400, "文件夹不存在");
    }
    statements.push(database.prepare("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?").bind(folder_id, room_id));
  } else if (["archive", "restore"].includes(action)) {
    if (action === "archive" && room.phase !== "concluded") statements.push(...topic_statements(database, room_id, { ...room, phase: "paused" }));
    statements.push(database.prepare("UPDATE room_directory SET archived=? WHERE room_id=?").bind(Number(action === "archive"), room_id));
  } else if (action === "delete") {
    if (payload.confirm_title !== room.title) throw new HttpError(400, "请输入完整频道名称确认删除");
    const queries = [
      "DELETE FROM message_timings WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)",
      "DELETE FROM message_summaries WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)",
      "DELETE FROM message_details WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)",
      "DELETE FROM discussion_turns WHERE room_id=?", "UPDATE messages SET reply_to=NULL WHERE room_id=?",
      "DELETE FROM messages WHERE room_id=?", "DELETE FROM topic_settings WHERE room_id=?", "DELETE FROM room_user_requests WHERE room_id=?",
      "DELETE FROM room_creations WHERE room_id=?", "DELETE FROM room_directory WHERE room_id=?", "DELETE FROM room_folder_assignments WHERE room_id=?", "DELETE FROM room_briefs WHERE room_id=?", "DELETE FROM room_floor WHERE room_id=?", "DELETE FROM rooms WHERE id=?",
    ];
    statements.push(...queries.map((query) => database.prepare(`${query} AND EXISTS (SELECT 1 FROM rooms WHERE id=? AND title=?)`).bind(room_id, room_id, payload.confirm_title)));
  } else throw new HttpError(404, "地址不存在");
  const results = await database.batch(statements);
  if (action === "delete" && !results.at(-1).meta.changes) throw new HttpError(400, "频道名称已变化，请重新确认删除");
  return action === "delete" ? { deleted: true, id: room_id } : require_room(database, room_id);
}

/** Normalize and validate a message before either URL or JSON publication. */
function message_values(payload) {
  const author = String(payload.author ?? "").trim();
  const text = String(payload.text ?? "").trim();
  const submission_id = submission_value(payload.submission_id);
  const reply_to = payload.reply_to ? integer(payload.reply_to) : null;
  if (!PARTICIPANTS.includes(author)) throw new HttpError(400, "请选择有效的发言者");
  if ((!text && !attachment_ids(payload).length) || text_length(text) > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `发言需包含正文或附件，正文最多 ${MAX_TEXT_LENGTH} 字`);
  }
  return { author, text, submission_id, reply_to };
}

/** Validate the ordered, unique attachment references of one message. */
function attachment_ids(payload) {
  const identifiers = payload.attachment_ids ?? [];
  if (!Array.isArray(identifiers) || identifiers.length > MAX_MESSAGE_ATTACHMENTS
    || identifiers.some(id => typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id))
    || new Set(identifiers).size !== identifiers.length) {
    throw new HttpError(400, `附件编号无效；每条消息最多 ${MAX_MESSAGE_ATTACHMENTS} 个，不能重复`);
  }
  return identifiers;
}

/** Validate upload metadata without trusting supplied file paths or MIME types. */
function attachment_metadata(params) {
  const file_name = params.file_name ?? "";
  if (typeof file_name !== "string" || !file_name.trim() || text_length(file_name) > MAX_FILENAME_LENGTH
    || [".", ".."].includes(file_name) || /[/\\\x00-\x1f\x7f]/.test(file_name)) {
    throw new HttpError(400, `文件名需为 1–${MAX_FILENAME_LENGTH} 字，不能包含路径或控制字符`);
  }
  if (!PARTICIPANTS.includes(params.actor)) throw new HttpError(400, "上传附件须声明有效的 actor");
  return { file_name, actor: params.actor, submission_id: submission_value(params.submission_id) };
}

/** Detect only raster images and PDF for inline presentation; everything else downloads. */
function attachment_content_type(data) {
  const starts = bytes => bytes.every((value, index) => data[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (starts([255, 216, 255])) return "image/jpeg";
  const prefix = new TextDecoder().decode(data.subarray(0, 12));
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) return "image/gif";
  if (prefix.startsWith("%PDF-")) return "application/pdf";
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

/** Expose metadata and stable room-scoped URLs without an object-store address. */
function attachment_view(record) {
  const url = `/api/rooms/${record.room_id}/attachments/${record.id}/content`;
  return { ...record, url, download_url: `${url}?download=1` };
}

/** Read one uploaded file strictly within its owning room. */
async function get_attachment(database, room_id, id) {
  const record = await database.prepare("SELECT * FROM attachments WHERE room_id=? AND id=?").bind(room_id, id).first();
  if (!record) throw new HttpError(404, "附件不存在");
  return attachment_view(record);
}

/** Add published files to a page of original messages in one query. */
async function attach_message_files(database, messages) {
  if (!messages.length) return messages;
  const rows = await database.prepare(`SELECT * FROM attachments WHERE message_id IN (${messages.map(() => "?").join(",")}) ORDER BY position,id`)
    .bind(...messages.map(message => message.id)).all();
  for (const message of messages) message.attachments = rows.results.filter(file => file.message_id === message.id).map(attachment_view);
  return messages;
}

/** List published attachments or recover one exact upload receipt. */
async function query_attachments(database, room_id, params) {
  await require_room_id(database, room_id);
  let where = "room_id=?";
  const values = [room_id];
  if (Object.hasOwn(params, "submission_id")) { where += " AND submission_id=?"; values.push(submission_value(params.submission_id)); }
  else where += " AND message_id IS NOT NULL";
  if (Object.hasOwn(params, "message_id")) { where += " AND message_id=?"; values.push(integer(params.message_id)); }
  const page = Math.max(1, integer(params.page ?? 1));
  const results = await database.batch([
    database.prepare(`SELECT COUNT(*) AS total FROM attachments WHERE ${where}`).bind(...values),
    database.prepare(`SELECT * FROM attachments WHERE ${where} ORDER BY created_at,id LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = results[0].results[0].total;
  return { attachments: results[1].results.map(attachment_view), page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Compare immutable upload content when a submission number is retried. */
function check_attachment_retry(previous, expected) {
  if (Object.keys(expected).some(key => previous[key] !== expected[key])) throw new HttpError(409, "这个附件提交编号已被其他文件使用");
}

/** Persist bytes in R2, then atomically publish metadata under the current write capability. */
async function store_attachment(database, bucket, room_id, metadata, data) {
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const expected = { ...metadata, size: data.length, sha256, content_type: attachment_content_type(data) };
  const previous = await database.prepare("SELECT * FROM attachments WHERE room_id=? AND submission_id=?").bind(room_id, metadata.submission_id).first();
  if (previous) { check_attachment_retry(previous, expected); return { attachment: attachment_view(previous), duplicate: true }; }
  const id = crypto.randomUUID().replaceAll("-", ""), key = `rooms/${room_id}/${id}`;
  try {
    await bucket.put(key, data, { httpMetadata: { contentType: expected.content_type } });
    const results = await database.batch([
      database.prepare(`INSERT INTO attachments (id,room_id,file_name,actor,submission_id,size,sha256,content_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
        .bind(id, room_id, expected.file_name, expected.actor, expected.submission_id, expected.size, sha256, expected.content_type, new Date().toISOString()),
      database.prepare("SELECT * FROM attachments WHERE room_id=? AND submission_id=?").bind(room_id, metadata.submission_id),
    ]);
    const saved = results[1].results[0], duplicate = saved.id !== id;
    if (duplicate) await bucket.delete(key);
    check_attachment_retry(saved, expected);
    return { attachment: attachment_view(saved), duplicate };
  } catch (error) {
    // An uncertain database response must not delete a file whose metadata was committed.
    const saved = await database.prepare("SELECT id FROM attachments WHERE id=?").bind(id).first().catch(() => ({ id }));
    if (!saved) await bucket.delete(key).catch(() => {});
    throw error;
  }
}

/** Reject reuse of another uploader's file or a file already linked elsewhere. */
async function check_message_attachments(database, room_id, message) {
  for (const id of message.attachment_ids) {
    const file = await get_attachment(database, room_id, id);
    if (file.actor !== message.submitted_by || file.message_id !== null) throw new HttpError(409, "附件已用于其他消息，或不属于本次实际提交者");
  }
}

/** Validate message role and preserve the original author's attribution. */
function message_details(room, payload) {
  const { author } = payload;
  const kind = payload.kind ?? "opinion";
  const submitted_by = payload.submitted_by ?? (payload.source === "cli" ? author : "用户");
  if (!["opinion", "moderation", "receipt"].includes(kind) || !PARTICIPANTS.includes(submitted_by)) throw new HttpError(400, "发言职责或提交者无效");
  if (!["用户", room.host, author].includes(submitted_by)) throw new HttpError(400, "只有用户或主持人可以代发其他专家的观点");
  if (kind === "moderation" && (author !== room.host || !["用户", room.host].includes(submitted_by))) throw new HttpError(400, "主持发言必须保留当前主持人署名");
  if (submitted_by === author && payload.source === "cli" && author !== "用户" && room.experts[author] !== "cli") throw new HttpError(400, "当前专家配置为在线只读，请由用户或主持人代发");
  const source = submitted_by === room.host && submitted_by !== author && submitted_by !== "用户" ? "host_proxy" :
    (payload.source === "cli" && submitted_by === author ? "cli" : (author === "用户" ? "user" : "proxy"));
  return { kind, submitted_by, source, turn_id: payload.turn_id ? integer(payload.turn_id) : null };
}

/** Preserve a supplied summary and distinguish its writer from the answer's author. */
function message_summary(payload, message) {
  const summary = String(payload.summary ?? "").trim();
  if (text_length(summary) > MAX_SUMMARY_LENGTH) throw new HttpError(400, `回答摘要最多 ${MAX_SUMMARY_LENGTH} 字`);
  const summary_by = summary ? (payload.summary_by ?? message.submitted_by) : "";
  if (summary && (message.kind !== "opinion" || ![message.author, message.submitted_by].includes(summary_by))) {
    throw new HttpError(400, "摘要仅用于观点，撰写者须为原作者或实际提交者");
  }
  return { summary, summary_by };
}

/** Compare semantic content, including provenance and assignment linkage. */
function check_retry(previous, expected) {
  if (["author", "text", "reply_to", "kind", "submitted_by", "turn_id", "summary", "summary_by"].some((key) => previous[key] !== expected[key])
    || JSON.stringify((previous.attachments ?? []).map(file => file.id)) !== JSON.stringify(expected.attachment_ids)) {
    throw new HttpError(409, "这个提交编号已被另一条内容使用，请为新发言生成新编号");
  }
}

/** Validate references before storing a new scheduled answer. */
async function check_message_references(database, room_id, message) {
  if (message.reply_to !== null) {
    const parent = await database.prepare("SELECT id FROM messages WHERE id=? AND room_id=?").bind(message.reply_to, room_id).first();
    if (!parent) throw new HttpError(400, "回复的消息不在当前房间中");
  }
  if (message.turn_id) {
    const turn = await get_turn(database, room_id, message.turn_id);
    if (turn.expert !== message.author || message.kind !== "opinion") throw new HttpError(400, "回答需使用被安排专家的身份和专家观点职责");
    if (!["pending", "notified"].includes(turn.status)) throw new HttpError(409, "该发言安排已完成或取消");
  }
}

/** Prepare one atomic message, attribution, and assignment completion batch. */
function message_statements(database, room_id, message, hashed) {
  const { author, text, submission_id, reply_to, source, kind, submitted_by, turn_id, summary, summary_by } = message;
  return [
    database.prepare(`INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at)
      VALUES (?,?,?,?,?,?,?) RETURNING id`)
      .bind(room_id, author, text, reply_to, source, submission_id, new Date().toISOString()),
    database.prepare(`INSERT INTO message_details (message_id,kind,submitted_by,turn_id)
      SELECT id,?,?,? FROM messages WHERE room_id=? AND submission_id=? AND author=? AND text=? AND reply_to IS ?
      ON CONFLICT(message_id) DO NOTHING`).bind(kind, submitted_by, turn_id, room_id, submission_id, author, text, reply_to),
    database.prepare(`INSERT INTO message_summaries (message_id,text,author)
      SELECT id,?,? FROM messages WHERE room_id=? AND submission_id=? AND author=? AND text=? AND reply_to IS ?
      ON CONFLICT(message_id) DO NOTHING`).bind(summary, summary_by, room_id, submission_id, author, text, reply_to),
    ...message.attachment_ids.map((id, position) => database.prepare(`UPDATE attachments
      SET message_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?),position=? WHERE id=?`)
      .bind(room_id, submission_id, position, id)),
    database.prepare(`INSERT INTO message_timings(message_id,elapsed_seconds)
      SELECT m.id,MAX(0,CAST(strftime('%s',m.created_at) AS INTEGER)-t.dispatched_at)
      FROM messages AS m JOIN message_details AS d ON d.message_id=m.id
      JOIN discussion_events AS e ON e.room_id=m.room_id AND e.participant=m.author
      JOIN event_timings AS t ON t.event_id=e.id
      WHERE m.room_id=? AND m.submission_id=? AND m.source='cli' AND d.submitted_by=m.author
        AND e.status='started' AND e.token_hash=? AND t.dispatched_at>0
      ON CONFLICT(message_id) DO NOTHING`).bind(room_id, submission_id, hashed),
    database.prepare(`UPDATE discussion_turns SET status='answered',answer_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)
      WHERE id=? AND status IN ('pending','notified') AND EXISTS
      (SELECT 1 FROM messages JOIN message_details ON messages.id=message_details.message_id
      WHERE messages.room_id=? AND messages.submission_id=? AND message_details.turn_id=discussion_turns.id)`)
      .bind(room_id, submission_id, turn_id, room_id, submission_id),
    database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, submission_id),
  ];
}

/** Atomically append a message, preserving idempotency under concurrent retries. */
async function append_message(database, room_id, payload, token = "") {
  const values = message_values(payload);
  const room = await require_room(database, room_id);
  const expected = { ...values, ...message_details(room, { ...payload, author: values.author }), attachment_ids: attachment_ids(payload) };
  Object.assign(expected, message_summary(payload, expected));
  const previous = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
  if (previous) { await attach_message_files(database, [previous]); check_retry(previous, expected); return { message: previous, duplicate: true }; }
  if (expected.author !== "用户" && expected.kind === "opinion") database = guard_limits(database, room);
  if (["paused", "concluded"].includes(room.phase) && expected.kind === "opinion") throw new HttpError(400, "话题已暂停或收束；恢复阶段后才能提交新观点，运行回执请用 receipt");
  await check_message_references(database, room_id, expected);
  await check_message_attachments(database, room_id, expected);
  if (expected.author !== "用户" && expected.kind === "opinion" && !expected.turn_id) throw new HttpError(400, "专家观点必须关联当前有效的 turn_id");
  let results;
  try { results = await database.batch(message_statements(database, room_id, expected, token ? await runtime_hash(token) : "")); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint")) {
      const saved = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
      if (saved) { await attach_message_files(database, [saved]); check_retry(saved, expected); return { message: saved, duplicate: true }; }
    }
    if (String(error).includes("attachment_unavailable")) throw new HttpError(409, "附件已用于其他消息，或不属于本次实际提交者");
    if (String(error).includes("floor_required")) throw new HttpError(409, "请先领取本人发言权；他人持有或尚未被点名时不能发言");
    if (String(error).includes("floor_turn_required")) throw new HttpError(400, "专家观点必须关联当前有效的 turn_id");
    if (String(error).includes("topic_inactive")) throw new HttpError(400, "话题已暂停或收束，请重新读取阶段");
    if (String(error).includes("UNIQUE constraint") || String(error).includes("turn_unavailable")) throw new HttpError(409, "该发言安排已有回答或已取消，请重新读取核对");
    throw error;
  }
  const message = results.at(-1).results[0];
  await attach_message_files(database, [message]);
  check_retry(message, expected);
  return { message, duplicate: results[0].results.length === 0 };
}

/** Read one assignment constrained to its topic. */
async function get_turn(database, room_id, turn_id) {
  const turn = await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND id=?").bind(room_id, integer(turn_id)).first();
  if (!turn) throw new HttpError(404, "发言安排不存在");
  return turn;
}

/** Read assignment history in bounded chronological pages. */
async function query_turns(database, room_id, params) {
  await require_room_id(database, room_id);
  const page = Math.max(1, integer(params.page ?? 1));
  let where = "room_id=?";
  const values = [room_id];
  if (Object.hasOwn(params, "submission_id")) {
    where += " AND submission_id=?";
    values.push(submission_value(params.submission_id));
  }
  const results = await database.batch([
    database.prepare(`SELECT COUNT(*) AS total FROM discussion_turns WHERE ${where}`).bind(...values),
    database.prepare(`SELECT * FROM discussion_turns WHERE ${where} ORDER BY id LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = results[0].results[0].total;
  return { turns: results[1].results, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Normalize one arrangement or an ordered round plan into { expert, question, submission_id } items. */
function plan_values(payload) {
  const items = payload.turns === undefined ? [{ expert: payload.expert, question: payload.question }] : payload.turns;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_PLAN_TURNS) throw new HttpError(400, `整轮安排需要 1–${MAX_PLAN_TURNS} 项`);
  const submission_id = submission_value(payload.submission_id);
  return items.map((item, index) => {
    if (!item || typeof item !== "object") throw new HttpError(400, "整轮安排的每一项需要 expert 和 question");
    const { author: expert, text: question } = message_values({ author: item.expert, text: item.question, submission_id });
    return { expert, question, submission_id: index === 0 ? submission_id : `${submission_id}-q${index + 1}` };
  });
}

/** Read plan rows by submission and reject a replay whose content differs. */
async function plan_rows(database, room_id, plan) {
  const rows = await Promise.all(plan.map((item) => database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND submission_id=?")
    .bind(room_id, item.submission_id).first()));
  if (rows.some((row, index) => !row || row.expert !== plan[index].expert || row.question !== plan[index].question)) {
    throw new HttpError(409, "该安排编号已被其他内容使用");
  }
  return rows;
}

/** Schedule one expert, or a round whose later turns relay without waking the host. */
async function create_turn(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const plan = plan_values(payload);
  const previous = await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND submission_id=?").bind(room_id, plan[0].submission_id).first();
  if (previous) {
    const rows = await plan_rows(database, room_id, plan);
    return { turn: rows[0], queued: rows.slice(1), duplicate: true };
  }
  database = guard_limits(database, room);
  if (plan.some((item) => !room.experts[item.expert] || text_length(item.question) > MAX_QUESTION_LENGTH)) throw new HttpError(400, "请选择参与专家，待回应问题最多 1000 字");
  if (["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，请先调整阶段");
  const created_at = new Date().toISOString();
  let results;
  try {
    results = await database.batch(plan.map((item, index) => database.prepare(`INSERT INTO discussion_turns (room_id,expert,question,status,submission_id,created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
      .bind(room_id, item.expert, item.question, index === 0 ? "pending" : "queued", item.submission_id, created_at)));
  } catch (error) {
    if (String(error).includes("floor_required")) throw new HttpError(409, "主持人须先领取发言权再安排下一位");
    if (String(error).includes("topic_inactive")) throw new HttpError(400, "话题已暂停或收束，请重新读取阶段");
    if (String(error).includes("UNIQUE constraint")) throw new HttpError(409, "请先完成或取消当前发言安排");
    throw error;
  }
  const rows = await plan_rows(database, room_id, plan);
  return { turn: rows[0], queued: rows.slice(1), duplicate: results[0].results.length === 0 };
}

/** Resume the remaining round plan after the host has handled user actions or an interruption. */
async function continue_turns(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  if (["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，请先调整阶段");
  if (room.current_turn && ["pending", "notified"].includes(room.current_turn.status)) throw new HttpError(409, "当前已有进行中的发言安排");
  if (!room.queued_turns.length) throw new HttpError(409, "没有排队中的安排；请创建新的安排");
  database = guard_limits(database, room);
  const turn_id = room.queued_turns[0].id;
  const [result] = await database.batch([database.prepare(`UPDATE discussion_turns SET status='pending' WHERE id=? AND status='queued'
    AND NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=? AND status IN ('pending','notified'))
    AND EXISTS (SELECT 1 FROM room_floor JOIN topic_settings USING(room_id) WHERE room_id=? AND holder=host)`).bind(turn_id, room_id, room_id)]);
  if (!result.meta.changes) throw new HttpError(409, "主持人须先领取发言权，或安排已变化，请重新读取");
  return { turn: await get_turn(database, room_id, turn_id), queued: room.queued_turns.slice(1) };
}

/** Record explicit delivery confirmation or cancellation without external I/O. */
async function update_turn(database, room_id, turn_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const turn = await get_turn(database, room_id, turn_id);
  const { status } = payload;
  if (!["notified", "cancelled"].includes(status)) throw new HttpError(400, "安排状态仅可显式改为 notified 或 cancelled");
  if (turn.status === status) return turn;
  if (status === "notified" && ["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，不能继续通知");
  if (!["pending", "notified"].includes(turn.status)) throw new HttpError(409, "该发言安排已结束");
  await database.prepare(`UPDATE discussion_turns SET status=?,notified_at=? WHERE id=? AND status IN ('pending','notified')
    AND (?<>'cancelled' OR ?='用户' OR EXISTS (SELECT 1 FROM room_floor JOIN topic_settings USING(room_id) WHERE room_id=discussion_turns.room_id AND holder=host))
    AND (?='cancelled' OR NOT EXISTS (SELECT 1 FROM topic_settings WHERE room_id=discussion_turns.room_id AND phase IN ('paused','concluded')))`)
    .bind(status, status === "notified" ? new Date().toISOString() : turn.notified_at, turn.id, status, payload.actor, status).run();
  const updated = await get_turn(database, room_id, turn_id);
  if (updated.status !== status) throw new HttpError(409, "话题阶段或发言安排已变化，请重新读取核对");
  return updated;
}

/** Build exact and incremental filters without expanding the read scope. */
function message_filters(room_id, params) {
  const clauses = ["room_id=?"];
  const values = [room_id];
  const query = String(params.q ?? "").trim();
  const author = String(params.author ?? "").trim();
  const mention = String(params.mention ?? "").trim();
  if (query) {
    clauses.push("(instr(lower(messages.text),lower(?)) > 0 OR CAST(messages.id AS TEXT)=?)");
    values.push(query, query.replace(/^#+/, ""));
  }
  if (author) { clauses.push("messages.author=?"); values.push(author); }
  if (mention) { clauses.push("instr(messages.text,?) > 0"); values.push(`@${mention}`); }
  if (Object.hasOwn(params, "kind")) {
    if (!["opinion", "moderation", "receipt"].includes(params.kind)) throw new HttpError(400, "发言职责无效");
    clauses.push("COALESCE(details.kind,'opinion')=?"); values.push(params.kind);
  }
  if (Object.hasOwn(params, "submission_id")) {
    clauses.push("submission_id=?"); values.push(submission_value(params.submission_id));
  }
  if (Object.hasOwn(params, "after")) {
    const after = integer(params.after);
    if (after < 0 || integer(params.page ?? 1) !== 1) throw new HttpError(400, "after 需为非负消息编号，不能与翻页同时使用");
    clauses.push("messages.id>?"); values.push(after);
  }
  return { where: clauses.join(" AND "), values };
}

/** Return one page, advancing incremental cursors only through returned rows. */
async function query_messages(database, room_id, params) {
  await require_room_id(database, room_id);
  const page = Math.max(1, integer(params.page ?? 1));
  const { where, values } = message_filters(room_id, params);
  const results = await database.batch([
    database.prepare(`SELECT COUNT(*) AS total FROM (${MESSAGE_QUERY} WHERE ${where})`).bind(...values),
    database.prepare(`${MESSAGE_QUERY} WHERE ${where} ORDER BY messages.id LIMIT ? OFFSET ?`)
      .bind(...values, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE),
  ]);
  const total = results[0].results[0].total;
  const rows = results[1].results;
  const messages = rows.slice(0, PAGE_SIZE);
  await attach_message_files(database, messages);
  const result = { messages, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  if (Object.hasOwn(params, "after")) Object.assign(result, {
    next_after: messages.at(-1)?.id ?? integer(params.after), has_more: rows.length > PAGE_SIZE,
  });
  return result;
}

/** Read exact message text only inside its owning room. */
async function get_message(database, room_id, message_id) {
  const message = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND messages.id=?`)
    .bind(room_id, integer(message_id)).first();
  if (!message) throw new HttpError(404, "消息不存在");
  await attach_message_files(database, [message]);
  return message;
}

/** Save the human-maintained state without advancing its evidence boundary. */
async function update_state(database, room_id, payload) {
  const text = String(payload.text ?? "").trim();
  const brief = String(payload.brief ?? "").trim();
  if (text_length(text) > MAX_STATE_LENGTH || text_length(brief) > MAX_BRIEF_LENGTH) throw new HttpError(400, `讨论状态最多 ${MAX_STATE_LENGTH} 字，主持简报最多 ${MAX_BRIEF_LENGTH} 字`);
  const room = await require_room(database, room_id);
  require_host(room, { actor: payload.actor ?? "用户" });
  const until = integer(payload.until ?? room.latest_id);
  if (until < 0 || until > room.latest_id) throw new HttpError(400, "讨论状态的截止编号无效");
  const statements = [database.prepare("UPDATE rooms SET state_text=?,state_until=? WHERE id=?").bind(text, until, room_id)];
  if (Object.hasOwn(payload, "brief")) statements.push(database.prepare(`INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET text=excluded.text,until=excluded.until,updated_at=excluded.updated_at`).bind(room_id, brief, until, new Date().toISOString()));
  await database.batch(statements);
  return require_room(database, room_id);
}

/** Read the host's brief explicitly without adding it to independent-entry overviews. */
function state_reading_text(room) {
  const brief = room.host_brief;
  const overview = brief?.text ? `主持简报（整理至 #${brief.until}，${brief.updated_at}）\n${brief.text}` : "主持简报：尚未更新";
  return `${overview}\n\n主持人维护的状态（整理至 #${room.state_until}）\n\n${room.state_text || "尚未整理"}\n\n${receipt_references_text(room)}`;
}

/** Render a message with its provenance and original reply reference. */
function message_text(message) {
  const reply = message.reply_to ? ` · 回复 #${message.reply_to}` : "";
  const role = { moderation: "主持发言", receipt: "运行回执" }[message.kind] || "专家观点";
  const summary = message.summary ? `\n回答摘要（${message.summary_by}）：\n${message.summary}\n\n完整正文：\n` : "\n";
  const attachments = (message.attachments ?? []).map(file => `\n附件：${file.file_name}（${file.size} 字节；ID: ${file.id}）\n${file.download_url}`).join("");
  return `#${message.id} · ${message.author} · ${message.created_at}${reply}\n职责：${role}；来源：${message.source}；提交者：${message.submitted_by ?? "用户"}；安排：${message.turn_id || "无"}${summary}${message.text}${attachments}`;
}

/** Expose an overview; supporting context is available only through chosen links. */
async function room_text(database, room_id, params) {
  const room = await require_room(database, room_id);
  const base = `/r/${room_id}`;
  const content = [`# ${room.title}`, `目标：${room.goal}`,
    `主持人：${room.host}；阶段：${PHASES[room.phase]}；当前焦点：${room.focus || "尚未填写"}`,
    `当前记录截止 #${room.latest_id}；共 ${room.message_count} 条；已完成 ${room.completed_rounds} 轮讨论（所有参与专家各发言一次）。`];
  const limits = room.limits;
  content.push(`讨论上限：${limits.max_rounds || '不限'} 轮；总时长 ${limits.max_minutes || '不限'} 分钟；单次自动执行 ${limits.execution_minutes ? `${limits.execution_minutes} 分钟` : "不限时长"}；到限 ${limits.on_limit}；收束预留 ${limits.summary_minutes} 分钟（计入总时长）。到限：${limits.reached}；收束中：${limits.closing}。`);
  const turn = room.current_turn;
  content.push(`发言权：${room.floor.holder ? `${room.floor.holder} 持有` : `待 ${room.floor.next_speaker} 领取`}；版本 ${room.floor.revision}。用户本人可随时留言，AI 发言前须领取。`);
  if (room.phase === "initial") content.push("本阶段先独立形成详细观点：仅阅读目标、背景、边界和自己的已有讨论；暂不阅读他人观点或主持总结。提交后再交叉阅读。这是参与约定，不是权限隔离。");
  if (room.archived) content.push("频道已存档，记录仍可查阅；先恢复频道，再由用户明确恢复讨论阶段。");
  if (["paused", "concluded"].includes(room.phase)) content.push("停止处理发言安排，取消本讨论自己的后台任务并核对实际状态；非必要不生成回执，正常停止无需回执。不要因旧通知恢复讨论。");
  if (turn) content.push(`当前安排 #${turn.id}：${turn.expert} · ${turn_status_label(turn, room)}`, `待回应问题：${turn.question}`, `安排详情：${base}/turns/${turn.id}`);
  if (room.queued_turns.length) content.push(`本轮排队：${room.queued_turns.map((item) => `#${item.id} ${item.expert}`).join(" → ")}`);
  if (room.held_since) content.push(`用户自 #${room.held_since} 起有待主持人处理的操作；当前回答完成后交给主持人，不自动接力。`);
  content.push("## 按需展开", "请自主选择需要的材料，不必读取全部历史。", `背景、边界与参与专家：${base}/brief`,
    `共识与分歧（整理至 #${room.state_until}）：${base}/state`);
  if (params.participant) content.push(`与 @${params.participant} 相关的观点：${base}/search?mention=${params.participant}&page=1`);
  content.push("", "## 读取与检索", `完整历史（分页）：${base}/messages?page=1`,
    `单条原文：${base}/messages/消息编号`, `检索：${base}/search?q=关键词&page=1`,
    `按作者检索：${base}/search?author=Claude`, `发言安排历史：${base}/turns?page=1`);
  if (params.mode === "cli") {
    content.push("", "## 本地 CLI AI · 可读可写", `POST /api/rooms/${room_id}/messages`,
      "Content-Type: application/json",
      'JSON 字段：author、text、submission_id（新 UUID）、source（填写 "cli"）；可选 reply_to、turn_id。',
      `完整写入与主持协议：${base}/protocol`, "重试沿用编号和正文；收到回执后按 message.id 重新读取核对。");
  } else {
    content.push("", "## 在线 AI · 只读参与",
      "请读取议题、状态和相关原文，在你自己的聊天窗口输出观点：先给通常 1–3 句的回答摘要，再给完整正文，保留关键条件、不确定性及引用编号；需要留档时由用户代发。",
      "不要操作网页表单、调用写入接口或生成发布链接，不要求获取发布回执。读取失败时如实报告，由用户提供复制的材料。");
  }
  content.push("参与方式按运行环境区分；主持人可以兼任专家；作者、职责与来源尚未认证。不调用模型服务 API。");
  return content.join("\n\n");
}

/** Render the detailed brief only when selected by a reader. */
function brief_text(room) {
  const experts = Object.entries(room.experts).map(([name, mode]) => `- ${name}：${mode === "cli" ? "本地 CLI 读写" : "在线只读"}`).join("\n");
  return `# ${room.title} · 话题资料\n\n目标：${room.goal}\n\n用户原文：\n${room.user_request || "未填写"}\n\n背景：\n${room.background || "未填写"}\n\n边界：\n${room.boundaries || "未填写"}\n\n主持人：${room.host}（可兼任专家）\n\n参与专家：\n${experts}`;
}

/** Render an assignment without embedding topic context. */
function turn_text(turn, room) {
  const room_id = room.id;
  const answer = turn.answer_id ? `\n回答原文：/r/${room_id}/messages/${turn.answer_id}` : "";
  return `安排 #${turn.id} · ${turn.expert} · ${turn_status_label(turn, room)}\n待回应问题：${turn.question}\n话题入口：/r/${room_id}?participant=${turn.expert}\n回答关联 turn_id：${turn.id}${answer}\n回答附简短摘要及完整正文，保留关键条件和不确定性。\n已接入的本地 CLI 专家可自行检查安排；在线专家需联系。复制通知不代表已送达；仅实际通知后由主持人确认。`;
}

/** Describe CLI host operations separately from topic material. */
function protocol_text(room) {
  const base = `/api/rooms/${room.id}`;
  return ["# 本地 CLI 读写与主持协议", `当前主持人：${room.host}。以下为留言板接口，不是模型服务 API。`,
    "写入使用 POST，通常为 Content-Type: application/json；附件上传使用 application/octet-stream 原始字节。主持操作填写 actor 为当前主持人或用户；这些是声明身份，不是认证凭据。",
    `附件：POST ${base}/attachments?actor=身份&file_name=文件名&submission_id=新编号，原文件最多 20 MiB；GET 同路径默认列已发送附件，加 submission_id 精确核对上传。GET ${base}/attachments/ID 读元数据，/ID/content 下载原文件。消息可带 attachment_ids（最多 10 个有序编号）；只关联同房间、同提交者的未使用附件，可只有附件无正文。自动任务须在回答完成前上传；消息查询包含附件，按需下载后由当前软件读取，不自动解析。`,
    "讨论上限：room.limits 返回轮次、总时长、单次执行、到限方式、收束预留和实际进度。准备/暂停时通过 topic 的 limits 对象修改；0 表示不预设轮次/总时长/单次执行时限。POST /api/rooms/ROOM/limits（actor）或 room limits ROOM --check 检查到限处理；附 force:true 可在进行中提前进入收束，由主持人在收束预留时间内总结。到限停止新专家安排与观点；总结由真实主持人完成，预留计入总时长；暂停期间不计时也不消耗总时长。",
    "运行方式：room.runtime 显示 manual/automatic、状态及真实执行回执。启用保护的房间写入须带 X-Discussion-Token；CLI 用 --access-file 读取本机私有文件，不公开令牌。自动任务先 execution enter，创建安排或保存关联回答即完成本步；不创建原生定时任务。旧执行在暂停、停止、换代、租约到期后失效。手动接入沿用原流程；受保护房间仍须用户提供有效的凭据文件。运行控制用 run view/start/pause/stop/configure；字段查 CLI schema。",
    `发言权：GET ${base}/floor 返回 holder、next_speaker、revision；POST 同路径，字段 actor、speaker（默认 actor）、action=take/return、revision（刚读到的整数版本）。仅无人持有且 next_speaker 为本人时可领取；持有者可主动归还，下一位回到主持人。版本变化返回 409，先读回核对。主持人仅可代操作 online 专家，cli 专家自行操作；用户可协助。`,
    "新房间由主持人持有发言权。创建安排须主持人持有，保存成功即归还并点名该专家；AI 的 opinion、moderation、receipt 都须实际作者持有，代发不豁免，opinion 必须关联有效 turn_id。消息保存成功自动归还，下一位为主持人。失败不归还，同编号重试不再次交接。用户本人发言不受发言权限制，也不改变发言权；@ 不改变顺序。维护状态、阶段及通知回执不占用发言权。取消安排须主持人持有，用户可直接取消失效安排；取消后归还给主持人领取。",
    '创建话题：POST /api/rooms；字段 title、goal、user_request（用户原文）、background、boundaries、host、experts、submission_id（新 UUID），例如 experts={"Codex":"cli","Gemini":"online"}。AI 主持人必须配置为 cli。同编号对照首次创建资料，重试不覆盖后来修改的房间；旧客户端不带编号时没有幂等保护。',
    `查询提交：GET /api/rooms?submission_id=编号 查建房结果；GET ${base}/messages?submission_id=编号 或 ${base}/turns?submission_id=编号 查消息或安排。查询成功且列表为空表示尚未查到，读取失败不表示未写入。`,
    `增量读取：GET ${base}/messages?after=已读消息编号，每次最多 20 条，按 next_after 续读，has_more 表示还有一批；可加 kind=opinion/moderation/receipt、author、mention、q。after 不与翻页混用，过滤后的游标只代表该查询范围。`,
    `维护话题：POST ${base}/topic；actor 加需要修改的上述字段，另可更新 phase（preparing/initial/discussing/reviewing/paused/concluded）、focus。收束前先完成或取消当前安排。暂停保留安排；恢复阶段后再继续。`,
    `安排发言：POST ${base}/turns；字段 actor、expert、question、submission_id（新 UUID）。同一话题同时只有一个未完成安排；重试沿用同一编号和问题。整轮安排改传 turns=[{expert,question},…]（最多 ${MAX_PLAN_TURNS} 项）：第一项立即生效，其余排队（queued）；每个回答保存后自动交给下一位，最后一位答完再交回主持人。用户留言或修改目标、背景、边界、焦点后（room.held_since 非 0），当前回答完成即交回主持人；主持人处理后用 POST ${base}/turns/continue（actor）按原计划继续，或直接创建新安排替换剩余排队（原排队改为 skipped）。`,
    `通知：仅把对象、问题、话题入口交给对应专家，不附背景、摘要或历史。使用已有且获准的会话通道；没有通道时交由用户协助。实际送达后 POST ${base}/turns/安排编号，字段 actor、status=notified；取消用 status=cancelled。复制不算送达。`,
    `专家观点：POST ${base}/messages；author、text、submission_id、source=cli，kind=opinion；必须关联 turn_id（回答的安排编号），可选 reply_to（本话题原文编号）。每次回答同时提供 summary（最多 ${MAX_SUMMARY_LENGTH} 字），通常 1–3 句结论先行，保留关键理由、条件和不确定性；summary_by 为原作者或提交者，默认提交者。text 保留完整正文，最多 ${MAX_TEXT_LENGTH} 个 Unicode 字符，请求最多 ${MAX_BODY_BYTES} 字节；不截断或用摘要完成安排。旧客户端缺少 summary 时不自动生成。`,
    `主持发言：同一消息接口，author=${room.host}、submitted_by=${room.host}、kind=moderation、source=cli；个人观点使用 kind=opinion，不能自动视为共识。`,
    `代发只读专家观点：author 保留原专家，submitted_by=${room.host}、kind=opinion、text 为原文；须关联 turn_id，可附 reply_to。服务保存代发来源；不要冒充专家直接提交。`,
    `整理状态：POST ${base}/state；actor、text（详细状态，最多 ${MAX_STATE_LENGTH} 字）、until（依据的消息截止编号）；brief（最多 ${MAX_BRIEF_LENGTH} 字）为面向人的主持简报，说明结论、共识、歧义和下一步意图。进度或安排变化后更新；省略 brief 保留旧简报，空字符串清除。所有参与专家各保存一次完整观点才完成一轮；同轮重复发言只计该专家一次，主持说明、用户留言、回执及取消安排不推进轮次。房间 rounds 按当前配置专家和完整历史生成，completed_rounds 为完成轮数，answered_turns 仅为已回答安排数。状态不覆盖原文，也不代表全体一致同意。`,
    "讨论方法：initial 先独立给出结论、依据、假设和风险，不回应他人；discussing 围绕具体分歧引用原文，说明维持或修正及原因；reviewing 检查拟定结论是否误述自己、遗漏条件或仍有阻碍。沉默不算同意。",
    `运行回执：非必要不生成。正常启停、首次检查、无变化轮询和已提交回答不另发回执；仅用户明确要求、异常影响协作且需要处理或交接确需补充确认时使用。POST ${base}/messages；author 使用实际身份、kind=receipt、source=cli、text 简述实际结果、影响和下一步，有任务时附本次运行标识与真实任务编号；已有状态或消息足够说明时不重复。submission_id 同次重试不变，不填 turn_id。回执不算专家观点或已回答。`,
    "后台参与：先立即检查，再用本会话真实可用的原生任务按约定频率和自身运行上限检查。专家只答自己未完成的安排，无任务时等待；主持人仍需处理新回答、网页回复和下一安排。paused/concluded、用户叫停或达到自身上限时停止自己的任务并核验，实际结果保留在本地接续信息，是否发回执按上述规则判断；单个专家任务停止不等于整场讨论结束。失败时保留未提交原文，重新读取阶段后再决定是否重试。",
    "收束：结论须有原文依据，区分明确共识、未决分歧与主持人判断；完成约定复核或达到已说明的时间/轮次上限后收束。讨论完成与后台任务退出分别核验；不为追求全员确认无限续轮。",
    "房间、消息与安排都支持 submission_id 去重，同次重试沿用编号和原始内容，新内容使用新编号。写入后重新读取服务器返回的结果，核对身份、内容与引用。",
  ].join("\n\n");
}

/** Route the existing JSON API without changing frontend callers. */
/** Hash bounded bearer capabilities; raw values are never persisted. */
async function runtime_hash(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate the same bounded settings as the SQLite backend. */
function limit_values(payload, current = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !Object.hasOwn(LIMIT_DEFAULTS, key))) throw new HttpError(400, "limits 仅接受讨论上限配置字段");
  const result = Object.fromEntries(Object.entries(LIMIT_DEFAULTS).map(([key, value]) => [key, current[key] ?? value]));
  Object.assign(result, payload);
  for (const [key, minimum, maximum] of [["max_rounds", 0, 100], ["max_minutes", 0, 1440], ["execution_minutes", 0, 60], ["summary_minutes", 1, 60]]) {
    if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new HttpError(400, `${key} 须为 ${minimum}–${maximum} 的整数`);
  }
  if (!["pause", "summarize"].includes(result.on_limit)) throw new HttpError(400, "on_limit 须为 pause 或 summarize");
  if (result.on_limit === "summarize" && result.max_minutes && result.summary_minutes >= result.max_minutes) throw new HttpError(400, "收束预留时间必须小于讨论总时长");
  return result;
}

/** Prepare settings updates without restarting the discussion clock. */
function limit_statements(database, room_id, settings) {
  return settings.save_limits ? [database.prepare(`UPDATE discussion_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,on_limit=?,summary_minutes=?,
    closing_at=CASE WHEN ? THEN 0 ELSE closing_at END,stop_reason=CASE WHEN ? THEN '' ELSE stop_reason END,revision=revision+1 WHERE room_id=?`)
    .bind(...Object.keys(LIMIT_DEFAULTS).map(key => settings.limits[key]), Number(settings.reset_closing), Number(settings.reset_closing), room_id)] : [];
}

/** Derive public progress; reads never perform lifecycle mutations. */
function limits_view(row, room) {
  const now = Math.floor(Date.now() / 1000);
  const idle = row.idle_seconds || 0;
  let deadline = row.started_at && row.max_minutes ? row.started_at + row.max_minutes * 60 + idle : 0;
  if (room.runtime?.deadline && (room.runtime.status === "running" || row.stop_reason)) deadline = Math.min(deadline || room.runtime.deadline, room.runtime.deadline);
  if (row.closing_at) deadline = Math.min(deadline || Infinity, row.closing_at + row.summary_minutes * 60);
  const cutoff = deadline && row.on_limit === "summarize" && !row.closing_at ? deadline - row.summary_minutes * 60 : deadline;
  const reason = deadline && now >= deadline ? "time_limit" : row.closing_at ? row.stop_reason
    : row.max_rounds && room.completed_rounds >= row.max_rounds ? "round_limit"
    : cutoff && now >= cutoff ? row.on_limit === "summarize" ? "summary_reserved" : "time_limit" : "";
  return { ...row, deadline, cutoff, reason, reached: Boolean(reason), closing: Boolean(row.closing_at) && !["paused", "concluded"].includes(room.phase),
    completed_rounds: room.completed_rounds, remaining_seconds: deadline ? Math.max(0, deadline - now) : null,
    elapsed_seconds: row.started_at ? Math.max(0, now - row.started_at - idle) : 0 };
}

/** Fence new expert work against concurrent answers, settings and the clock. */
function guard_limits(database, room) {
  if (room.limits.reached) throw new HttpError(409, "已达到讨论上限；请检查上限并暂停或由主持人总结");
  return guarded_database(database, `EXISTS(SELECT 1 FROM discussion_limits WHERE room_id=? AND revision=? AND closing_at=0)
    AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=?),0)=? AND (?=0 OR unixepoch()<?)
    AND EXISTS(SELECT 1 FROM topic_settings WHERE room_id=? AND json(experts)=json(?))`,
    [room.id, room.limits.revision, room.id, room.latest_id, room.limits.cutoff, room.limits.cutoff, room.id, JSON.stringify(room.experts)]);
}

/** Apply a reached boundary once, leaving authorship of the summary to the host. */
async function check_limits(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const limits = room.limits;
  const force = payload.force === true;
  if (force && (["preparing", "paused", "concluded"].includes(room.phase) || room.archived)) throw new HttpError(400, "仅进行中的讨论可以提前收尾");
  if ((!limits.reached && !force) || ["paused", "concluded"].includes(room.phase) || room.archived) return room;
  const reason = limits.reason || "user_stop";
  const closing = (force || limits.on_limit === "summarize") && reason !== "time_limit";
  if (closing && limits.closing) return room;
  const summary_deadline = Math.floor(Date.now() / 1000) + limits.summary_minutes * 60;
  const statements = [database.prepare("UPDATE discussion_limits SET closing_at=?,stop_reason=?,revision=revision+1 WHERE room_id=?")
    .bind(closing ? Math.floor(Date.now() / 1000) : limits.closing_at, reason, room_id),
    database.prepare("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND status IN ('pending','notified')").bind(room_id),
    database.prepare("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND status='queued'").bind(room_id),
    database.prepare("UPDATE room_floor SET holder=NULL,next_speaker=?,revision=revision+1 WHERE room_id=?").bind(room.host, room_id),
    closing ? database.prepare("UPDATE discussion_runtime SET generation=generation+1,revision=revision+1,deadline=CASE WHEN deadline=0 THEN ? ELSE MIN(deadline,?) END WHERE room_id=? AND status='running'").bind(summary_deadline, summary_deadline, room_id)
      : database.prepare("UPDATE topic_settings SET phase='paused' WHERE room_id=?").bind(room_id)];
  await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_limits WHERE room_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM topic_settings WHERE room_id=? AND phase=? AND host=? AND json(experts)=json(?))
    AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=?),0)=?`,
    [room_id, limits.revision, room_id, room.phase, room.host, JSON.stringify(room.experts), room_id, room.latest_id], statements);
  return require_room(database, room_id);
}

/** Expose mode and actual lifecycle without exposing capability hashes. */
async function runtime_view(database, room_id) {
  const row = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  if (!row) return { mode: "manual", status: "ready", revision: 0, protected: false };
  const { control_hash, ...visible } = row;
  const latest_execution = await database.prepare("SELECT id,participant,role,status,result FROM discussion_events WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first();
  const participants = await participant_executions(database, room_id);
  const timings = await execution_timings(database, room_id, row.run_id);
  return { ...visible, latest_execution, participants, timings, protected: true, expired: row.status === "running" && row.deadline > 0 && row.deadline <= Math.floor(Date.now() / 1000) };
}

/** Summarize each participant's latest execution and failure count for the progress panel. */
async function participant_executions(database, room_id) {
  // One grouped pass over the room's events; per-row correlated subqueries made reads grow quadratically.
  // Keep SELECT outermost so guarded_database treats post-completion readback as read-only.
  const { results } = await database.prepare(`SELECT * FROM (WITH stats AS (SELECT participant,MAX(id) AS latest_id,
      MAX(CASE WHEN session_id<>'' THEN id END) AS bound_id,SUM(status='failed') AS failures
      FROM discussion_events WHERE room_id=? GROUP BY participant)
    SELECT latest.id,latest.participant,latest.role,latest.status,latest.result,latest.turn_id,latest.lease_until,
      COALESCE(bound.session_id,'') AS session_id,stats.failures
    FROM stats JOIN discussion_events AS latest ON latest.id=stats.latest_id
    LEFT JOIN discussion_events AS bound ON bound.id=stats.bound_id ORDER BY latest.id)`).bind(room_id).all();
  const now = Math.floor(Date.now() / 1000);
  return results.map(({ lease_until, ...event }) => ({ ...event, stale: event.status === "started" && lease_until <= now }));
}

/** Summarize stage durations of the current run so slow stages are visible. */
async function execution_timings(database, room_id, run_id) {
  const now = Math.floor(Date.now() / 1000);
  const { results } = await database.prepare(TIMING_SQL).bind(now, now, now, room_id, run_id).all();
  const totals = Object.fromEntries(["queue_seconds", "wake_seconds", "work_seconds"]
    .map((stage) => [stage, results.reduce((sum, row) => sum + (row[stage] || 0), 0)]));
  return { items: results.slice(0, TIMING_ITEMS), totals, count: results.length };
}

/** Assert authorization and mutation in one D1 transaction. */
async function checked_batch(database, condition, values, statements) {
  const id = crypto.randomUUID();
  try {
    const results = await database.batch([
      database.prepare(`INSERT INTO runtime_assertions(id,allowed) VALUES (?,CASE WHEN ${condition} THEN 1 ELSE 0 END)`).bind(id, ...values),
      ...statements,
      database.prepare("DELETE FROM runtime_assertions WHERE id=?").bind(id),
    ]);
    return results.slice(1, -1);
  } catch (error) {
    if (String(error).includes("CHECK constraint")) throw new HttpError(403, "运行或执行资格已变化，请重新读取；未进行写入");
    throw error;
  }
}

/** Wrap only writes so every existing mutation rechecks its capability atomically. */
function guarded_database(database, condition, values) {
  const batch = statements => checked_batch(database, condition, values, statements.map(item => item.runtime_statement ?? item));
  function prepare(sql, bindings = []) {
    const raw = database.prepare(sql).bind(...bindings);
    const read = /^\s*(SELECT|PRAGMA)\b/i.test(sql);
    return { runtime_statement: raw, bind: (...args) => prepare(sql, args),
      all: () => read ? raw.all() : batch([raw]).then(results => results[0]),
      run: () => batch([raw]).then(results => results[0]),
      first: (column) => read ? raw.first(column) : batch([raw]).then(results => {
        const row = results[0].results[0] ?? null;
        return column && row ? row[column] : row;
      }) };
  }
  return { prepare, batch };
}

/** Scope ordinary writes to their room owner or current execution identity. */
async function authorize_database(database, room_id, token, operation, payload) {
  const hashed = await runtime_hash(token);
  const run = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  if (!run) return guarded_database(database, "NOT EXISTS(SELECT 1 FROM discussion_runtime WHERE room_id=?)", [room_id]);
  if (hashed && hashed === run.control_hash) return guarded_database(database,
    "EXISTS(SELECT 1 FROM discussion_runtime WHERE room_id=? AND control_hash=?)", [room_id, hashed]);
  const actor = payload.actor ?? payload.submitted_by ?? payload.author ?? "用户";
  if (actor === "用户") return database;
  const event = await database.prepare("SELECT * FROM discussion_events WHERE room_id=? AND token_hash=? AND status='started'").bind(room_id, hashed).first();
  if (!hashed || !event || actor !== event.participant) throw new HttpError(403, "执行凭据与实际参与身份不符");
  if (operation === "messages") {
    if (payload.author !== actor || (event.role === "expert" && payload.turn_id !== event.turn_id)) throw new HttpError(403, "自动回答须关联本人的有效安排");
  } else if (operation === "floor") {
    if ((payload.speaker ?? actor) !== actor) throw new HttpError(403, "只能操作本人发言权");
  } else if (operation !== "attachments" && (event.role !== "host" || !["topic", "state", "turns", "limits"].includes(operation))) throw new HttpError(403, "本次执行不能进行此操作");
  return guarded_database(database, `EXISTS(SELECT 1 FROM discussion_events e JOIN discussion_runtime r USING(room_id) JOIN discussion_limits l USING(room_id)
    WHERE e.id=? AND e.token_hash=? AND e.run_id=r.run_id AND e.generation=r.generation
    AND e.status='started' AND r.status='running' AND (r.deadline=0 OR r.deadline>unixepoch())
    AND e.lease_until>unixepoch() AND (l.execution_minutes=0 OR e.started_at+l.execution_minutes*60>unixepoch()))`, [event.id, hashed]);
}

/** Validate starts with an optional deadline without launching any application. */
function runtime_start(database, room, payload) {
  const room_id = room.id;
  const now = Math.floor(Date.now() / 1000);
  let configured = room.limits.max_minutes ? (room.limits.started_at || now) + room.limits.max_minutes * 60 + (room.limits.idle_seconds || 0) : 0;
  if (room.limits.closing_at) configured = Math.min(...[configured, room.limits.closing_at + room.limits.summary_minutes * 60, room.runtime.deadline].filter(Boolean));
  payload.deadline ??= configured;
  if (Number.isInteger(payload.deadline) && configured) payload.deadline = Math.min(payload.deadline || configured, configured);
  if (!Number.isInteger(payload.deadline) || (payload.deadline !== 0 && (payload.deadline <= now || payload.deadline > now + 86400))) throw new HttpError(400, "deadline 须为 0（不限时长）或未来 24 小时内的 Unix 秒数");
  if (room.archived || room.phase === "concluded" || room.host === "用户" || !Object.keys(room.experts).length || Object.values(room.experts).some(mode => mode !== "cli")) throw new HttpError(400, "自动运行需要未归档、未收束的话题及具有 CLI 读写能力的 AI 主持和参与者");
  const phase = payload.phase ?? room.runtime.resume_phase ?? (room.phase === "preparing" ? "initial" : "discussing");
  if (!["initial", "discussing", "reviewing"].includes(phase)) throw new HttpError(400, "恢复阶段无效");
  return [database.prepare("UPDATE topic_settings SET phase=? WHERE room_id=? AND phase IN ('preparing','paused')").bind(phase, room_id),
    database.prepare("UPDATE discussion_limits SET started_at=? WHERE room_id=? AND started_at=0").bind(now, room_id)];
}

/** Apply versioned configuration, preserving manual rooms until explicitly changed. */
async function configure_runtime(database, room_id, token, payload) {
  const current = await runtime_view(database, room_id);
  if (payload.revision !== current.revision) throw new HttpError(409, "运行状态已变化，请重新读取 revision");
  const hashed = await runtime_hash(token);
  if (!current.protected && !hashed) throw new HttpError(400, "运行凭据须为 32–256 字符的随机值");
  const action = payload.action ?? "configure";
  const mode = payload.mode ?? (action === "start" ? "automatic" : current.mode);
  const status = { configure: "ready", start: "running", pause: "paused", stop: "stopped" }[action];
  if (!["manual", "automatic"].includes(mode) || !status) throw new HttpError(400, "运行模式或操作无效");
  if (action === "start" && mode !== "automatic") throw new HttpError(400, "start 只用于全自动运行");
  if (["configure", "start"].includes(action) && current.status === "running") throw new HttpError(409, "讨论仍在运行；请先暂停，再切换模式或继续");
  let condition = current.protected
    ? "EXISTS(SELECT 1 FROM discussion_runtime WHERE room_id=? AND revision=?)"
    : "NOT EXISTS(SELECT 1 FROM discussion_runtime WHERE room_id=?)";
  const values = current.protected ? [room_id, current.revision] : [room_id];
  const idle = ["start", "configure"].includes(action) ? " AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=? AND status IN ('dispatched','started'))" : "";
  const room = action === "start" ? await require_room(database, room_id) : null;
  const statements = room ? runtime_start(database, room, payload) : [];
  if (room) {
    condition += ` AND EXISTS(SELECT 1 FROM topic_settings JOIN room_directory USING(room_id)
      JOIN discussion_limits USING(room_id) WHERE room_id=? AND phase=? AND host=? AND json(experts)=json(?)
      AND archived=0 AND discussion_limits.revision=? AND started_at=?) AND (?=0 OR unixepoch()<?)`;
    // The start snapshot must be checked before phase/clock writes in the same transaction.
    values.push(room_id, room.phase, room.host, JSON.stringify(room.experts), room.limits.revision, room.limits.started_at, payload.deadline, payload.deadline);
  }
  if (idle) values.push(room_id);
  statements.push(database.prepare(`INSERT INTO discussion_runtime(room_id,mode,run_id,status,control_hash,deadline,updated_at)
    VALUES (?,?,?,'ready',?,?,datetime('now')) ON CONFLICT(room_id) DO UPDATE SET mode=excluded.mode,status='ready',
    generation=generation+1,revision=revision+1,deadline=excluded.deadline,updated_at=excluded.updated_at`)
    .bind(room_id, mode, crypto.randomUUID(), hashed, action === "start" ? payload.deadline : current.deadline ?? 0));
  if (["pause", "stop"].includes(action)) statements.push(database.prepare("UPDATE topic_settings SET phase='paused' WHERE room_id=? AND phase<>'concluded'").bind(room_id));
  statements.push(database.prepare("UPDATE discussion_runtime SET status=? WHERE room_id=?").bind(status, room_id));
  await checked_batch(database, condition + idle, values, statements);
  return runtime_view(database, room_id);
}

/** Select only public event fields. */
function public_event(event) {
  const fields = ["id", "room_id", "run_id", "generation", "cause", "participant", "role", "turn_id", "status", "session_id", "lease_until", "result", "created_at"];
  return Object.fromEntries(fields.map(key => [key, event[key]]));
}

/** Reserve current work while merging older host wakeups. */
async function reservation_statements(database, event, payload) {
  const hashed = await runtime_hash(payload.execution_token);
  if (!hashed || event.status !== "pending") throw new HttpError(409, "执行已被领取或凭据无效");
  const turn = await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND status IN ('pending','notified')").bind(event.room_id).first();
  if ((event.role === "host" && turn) || (event.role === "expert" && (!turn || turn.id !== event.turn_id))) throw new HttpError(409, "当前安排与执行不符");
  return [database.prepare("UPDATE discussion_events SET status='dispatched',token_hash=? WHERE id=?").bind(hashed, event.id),
    database.prepare("UPDATE discussion_events SET status='completed',result=? WHERE room_id=? AND role='host' AND status='pending' AND id<? AND ?='host'")
      .bind(`merged:${event.id}`, event.room_id, event.id, event.role)];
}

/** Mutate an execution only while its run, generation and previous status match. */
async function runtime_event_action(database, room_id, event_id, token, payload) {
  const event = await database.prepare("SELECT * FROM discussion_events WHERE room_id=? AND id=?").bind(room_id, event_id).first();
  if (!event) throw new HttpError(404, "执行不存在");
  const run = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  const hashed = await runtime_hash(token);
  const controller = hashed && hashed === run.control_hash;
  if (!controller && (!hashed || hashed !== event.token_hash)) throw new HttpError(403, "执行凭据无效");
  if (payload.action === "view") return public_event(event);
  let statements;
  const now = Math.floor(Date.now() / 1000);
  const work_seconds = (await database.prepare("SELECT execution_minutes*60 AS seconds FROM discussion_limits WHERE room_id=?").bind(room_id).first()).seconds;
  const work_deadline = work_seconds ? (payload.action === "enter" ? now : event.started_at) + work_seconds : 0;
  const lease_until = Math.min(now + 120, work_deadline || Infinity, run.deadline || Infinity);
  if (payload.action === "reserve" && controller) statements = await reservation_statements(database, event, payload);
  else if (payload.action === "enter" && !controller && event.status === "dispatched" && payload.session_id) {
    statements = [database.prepare("UPDATE discussion_events SET status='started',session_id=?,started_at=?,lease_until=? WHERE id=?")
      .bind(String(payload.session_id).slice(0, 200), now, lease_until, event.id)];
  } else if (payload.action === "renew" && controller && event.status === "started" && event.lease_until > now && (!work_deadline || work_deadline > now)) {
    statements = [database.prepare("UPDATE discussion_events SET lease_until=? WHERE id=?").bind(lease_until, event.id)];
  } else if (payload.action === "fail" && ["dispatched", "started"].includes(event.status)) {
    statements = [database.prepare("UPDATE discussion_events SET status='failed',result=? WHERE id=?").bind(String(payload.reason ?? "需要用户处理").slice(0, 500), event.id),
      database.prepare("UPDATE topic_settings SET phase='paused' WHERE room_id=?").bind(room_id)];
  } else throw new HttpError(409, "执行状态不允许此操作");
  const condition = `EXISTS(SELECT 1 FROM discussion_events e JOIN discussion_runtime r USING(room_id)
    WHERE e.id=? AND e.status=? AND e.generation=r.generation AND e.run_id=r.run_id AND r.status='running'
    AND (r.deadline=0 OR r.deadline>unixepoch()) AND (r.control_hash=? OR e.token_hash=?))`;
  const idle = payload.action === "reserve" ? " AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=? AND status IN ('dispatched','started'))" : "";
  const live_lease = payload.action === "renew" ? " AND EXISTS(SELECT 1 FROM discussion_events e JOIN discussion_limits l USING(room_id) WHERE e.id=? AND e.lease_until>unixepoch() AND (l.execution_minutes=0 OR e.started_at+l.execution_minutes*60>unixepoch()))" : "";
  await checked_batch(database, condition + idle + live_lease,
    [event.id, event.status, hashed, hashed, ...(idle ? [room_id] : []), ...(live_lease ? [event.id] : [])], statements);
  return public_event(await database.prepare("SELECT * FROM discussion_events WHERE id=?").bind(event.id).first());
}

/** Handle runtime requests without exposing owner or execution hashes. */
async function handle_runtime_api(database, request, parts, params) {
  const room_id = parts[2];
  await require_room_id(database, room_id);
  const token = request.headers.get("X-Discussion-Token") ?? "";
  if (parts.length === 4 && parts[3] === "runtime") return respond(request.method === "GET"
    ? await runtime_view(database, room_id) : await configure_runtime(database, room_id, token, await read_payload(request)));
  if (parts.length === 5 && parts[3] === "events" && request.method === "POST") return respond(
    await runtime_event_action(database, room_id, integer(parts[4]), token, await read_payload(request)));
  if (parts.length === 4 && parts[3] === "events" && request.method === "GET") {
    const control = await database.prepare("SELECT 1 FROM discussion_runtime WHERE room_id=? AND control_hash=?").bind(room_id, await runtime_hash(token)).first();
    if (!control) throw new HttpError(403, "需要本房间的运行控制凭据");
    const after = Math.max(0, integer(params.after ?? 0));
    const rows = await database.prepare("SELECT * FROM discussion_events WHERE room_id=? AND id>? ORDER BY id LIMIT 100").bind(room_id, after).all();
    const events = rows.results.map(public_event);
    return respond({ events, next_after: events.at(-1)?.id ?? after });
  }
  throw new HttpError(404, "地址不存在");
}

/** Route JSON operations alongside explicitly bounded binary attachment routes. */
async function handle_api(database, request, parts, params, bucket) {
  const route = parts.join("/");
  const method = request.method;
  if (route === "api/health" && method === "GET") return respond({ ok: true });
  if (route === "api/rooms") {
    if (method === "GET") return respond(await query_rooms(database, params));
    const room = await create_room(database, await read_payload(request), request.headers.get("X-Discussion-Token") ?? "");
    return respond(room, room.duplicate ? 200 : 201);
  }
  if (route === "api/folders" && method === "POST") {
    const name = folder_name_value(await read_payload(request));
    const id = crypto.randomUUID().replaceAll("-", "");
    const position = (await database.prepare("SELECT COALESCE(MAX(position),0)+1 AS next FROM topic_folders").first()).next;
    await database.prepare("INSERT INTO topic_folders (id,name,position) VALUES (?,?,?)").bind(id, name, position).run();
    return respond({ id, name, position }, 201);
  }
  if (parts.length === 4 && parts[0] === "api" && parts[1] === "folders" && parts[3] === "move" && method === "POST") {
    return respond(await move_folder(database, parts[2], await read_payload(request)));
  }
  if (parts.length === 4 && parts[0] === "api" && parts[1] === "folders" && parts[3] === "rename" && method === "POST") {
    return respond(await rename_folder(database, parts[2], await read_payload(request)));
  }
  if (parts.length === 4 && parts[0] === "api" && parts[1] === "folders" && parts[3] === "delete" && method === "POST") {
    return respond(await delete_folder(database, parts[2]));
  }
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "rooms") {
    throw new HttpError(404, "地址不存在");
  }
  const room_id = parts[2];
  if (parts[3] === "attachments") return handle_attachments(database, request, parts, params, bucket);
  if (["runtime", "events"].includes(parts[3])) return handle_runtime_api(database, request, parts, params);
  if (method === "POST") database = await authorize_database(database, room_id,
    request.headers.get("X-Discussion-Token") ?? "", parts[3], await read_payload(request.clone()));
  if (parts.slice(3).join("/") === "backup" && method === "GET") return respond(await room_backup(database, room_id));
  const tail = parts.slice(3).join("/");
  if (tail === "limits") return respond(method === "GET" ? (await require_room(database, room_id)).limits : await check_limits(database, room_id, await read_payload(request)));
  if (["move", "folder", "archive", "restore", "delete"].includes(tail) && method === "POST") {
    const files = tail === "delete" ? (await database.prepare("SELECT id FROM attachments WHERE room_id=?").bind(room_id).all()).results : [];
    const result = await manage_room(database, room_id, tail, await read_payload(request));
    if (bucket) {
      for (const file of files) await bucket.delete(`rooms/${room_id}/${file.id}`).catch(error => console.error("Attachment cleanup failed", file.id, error));
    }
    return respond(result);
  }
  if (!tail && method === "GET") return respond(await require_room(database, room_id));
  if (tail === "floor") return respond(method === "GET" ? (await require_room(database, room_id)).floor : await update_floor(database, room_id, await read_payload(request)));
  if (["topic", "turns"].includes(parts[3])) return handle_host_api(database, request, parts, params);
  if (tail === "messages") {
    if (method === "GET") return respond(await query_messages(database, room_id, params));
    const payload = await read_payload(request);
    const result = await append_message(database, room_id, payload, request.headers.get("X-Discussion-Token") ?? "");
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (parts.length === 5 && parts[3] === "messages" && method === "GET") {
    return respond(await get_message(database, room_id, parts[4]));
  }
  if (tail === "state" && method === "POST") {
    return respond(await update_state(database, room_id, await read_payload(request)));
  }
  throw new HttpError(404, "地址不存在");
}

/** Handle upload, listing, metadata, and safe content access through an optional R2 binding. */
async function handle_attachments(database, request, parts, params, bucket) {
  const room_id = parts[2];
  if (parts.length === 4) {
    if (request.method === "GET") return respond(await query_attachments(database, room_id, params));
    if (!bucket) throw new HttpError(503, "附件存储未配置；请绑定 ATTACHMENTS R2 存储桶");
    const metadata = attachment_metadata(params);
    database = await authorize_database(database, room_id, request.headers.get("X-Discussion-Token") ?? "", "attachments", metadata);
    await require_room_id(database, room_id);
    if (Number(request.headers.get("Content-Length")) > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "单个附件最多 20 MiB");
    const result = await store_attachment(database, bucket, room_id, metadata, await read_bytes(request, MAX_ATTACHMENT_BYTES));
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (request.method === "GET" && [5, 6].includes(parts.length)) {
    const file = await get_attachment(database, room_id, parts[4]);
    if (parts.length === 5) return respond(file);
    if (parts[5] === "content") return attachment_response(bucket, file, params.download === "1");
  }
  throw new HttpError(404, "地址不存在");
}

/** Stream opaque R2 bytes without exposing the bucket or allowing executable inline content. */
async function attachment_response(bucket, file, download) {
  if (!bucket) throw new HttpError(503, "附件存储未配置；请绑定 ATTACHMENTS R2 存储桶");
  const object = await bucket.get(`rooms/${file.room_id}/${file.id}`);
  if (!object) throw new HttpError(404, "附件原文件缺失");
  const disposition = download || file.content_type === "application/octet-stream" ? "attachment" : "inline";
  const filename = encodeURIComponent(file.file_name).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return new Response(object.body, { headers: {
    "Content-Type": file.content_type, "Content-Length": String(file.size),
    "Content-Disposition": `${disposition}; filename*=UTF-8''${filename}`,
    "X-Content-SHA256": file.sha256,
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}

/** Route topic maintenance and speaking assignments. */
async function handle_host_api(database, request, parts, params) {
  const room_id = parts[2];
  const tail = parts.slice(3).join("/");
  if (tail === "topic" && request.method === "POST") return respond(await update_topic(database, room_id, await read_payload(request)));
  if (tail === "turns") {
    if (request.method === "GET") return respond(await query_turns(database, room_id, params));
    const result = await create_turn(database, room_id, await read_payload(request));
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (tail === "turns/continue" && request.method === "POST") return respond(await continue_turns(database, room_id, await read_payload(request)));
  if (parts.length === 5 && parts[3] === "turns") {
    return respond(request.method === "GET" ? await get_turn(database, room_id, parts[4]) :
      await update_turn(database, room_id, parts[4], await read_payload(request)));
  }
  throw new HttpError(404, "地址不存在");
}

/** Serve read-only plain text and reject the retired GET publication endpoint. */
async function handle_text(database, parts, params) {
  const room_id = parts[1];
  const tail = parts.slice(2).join("/");
  if (!room_id) throw new HttpError(404, "请指定房间");
  if (!tail) return room_text(database, room_id, params);
  if (["brief", "state", "protocol"].includes(tail)) {
    const room = await require_room(database, room_id);
    if (tail === "brief") return brief_text(room);
    if (tail === "state") return state_reading_text(room);
    return protocol_text(room);
  }
  if (tail === "turns") {
    const result = await query_turns(database, room_id, params);
    const room = await require_room(database, room_id);
    return `第 ${result.page} / ${result.pages} 页，共 ${result.total} 项。\n\n${result.turns.map((turn) => turn_text(turn, room)).join("\n\n")}`;
  }
  if (parts.length === 4 && parts[2] === "turns") return turn_text(await get_turn(database, room_id, parts[3]), await require_room(database, room_id));
  if (tail === "messages" || tail === "search") {
    const result = await query_messages(database, room_id, params);
    const items = result.messages.map(message_text);
    const pagination = `第 ${result.page} / ${result.pages} 页，共 ${result.total} 条。翻页：保留查询条件，修改 page 参数。`;
    return `${pagination}\n\n${items.length ? items.join("\n\n---\n\n") : "没有匹配的消息。"}`;
  }
  if (parts.length === 4 && parts[2] === "messages") {
    return message_text(await get_message(database, room_id, parts[3]));
  }
  if (tail === "publish") {
    throw new HttpError(410, "URL 发布入口已停用。在线 AI 只读；本地 CLI AI 请使用 POST 留言接口。");
  }
  throw new HttpError(404, "地址不存在");
}

/** Share updates across domain aliases; deployments can isolate distinct databases by channel. */
function updates_hub(env) {
  return env.UPDATES?.get(env.UPDATES.idFromName(env.UPDATES_CHANNEL || "default"));
}

/** Deliver an invalidation without making a committed write fail on push outages. */
async function notify_update(env) {
  try {
    const hub = updates_hub(env);
    const response = await hub.fetch("https://updates.internal/", { method: "POST" });
    if (!response.ok) console.error("Update notification failed:", response.status);
  } catch (error) { console.error("Update notification failed:", error.message); }
}

/** Dispatch Worker requests, preserving HEAD's no-publication behavior. */
async function fetch_request(request, env, context) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const text_mode = parts[0] === "r";
  try {
    if (url.pathname === "/robots.txt") return respond("User-agent: *\nAllow: /\n", 200, true);
    if (!["api", "r"].includes(parts[0])) return env.ASSETS.fetch(request);
    if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 501 });
    if (url.pathname === "/api/updates" && request.method === "GET") {
      const hub = updates_hub(env);
      return hub ? await hub.fetch("https://updates.internal/") : new Response(null, { status: 204 });
    }
    const params = Object.fromEntries(url.searchParams);
    if (text_mode && request.method === "GET") {
      return respond(await handle_text(env.DB, parts, params), 200, true);
    }
    const quiet_renewal = parts[3] === "events" && request.method === "POST"
      && (await request.clone().json().catch(() => ({}))).action === "renew";
    const response = await handle_api(env.DB, request, parts, params, env.ATTACHMENTS);
    if (request.method === "POST" && response.ok && ["rooms", "folders"].includes(parts[1]) && !quiet_renewal && env.UPDATES) {
      const notification = notify_update(env);
      if (context) context.waitUntil(notification);
      else await notification;
    }
    return response;
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 500 ? "服务器内部错误" : error.message;
    return respond(text_mode ? message : { error: message }, status, text_mode);
  }
}

export default { fetch: fetch_request };
