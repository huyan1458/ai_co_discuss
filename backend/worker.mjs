/** Cloudflare Workers / D1 adapter for the existing discussion HTTP protocol. */
const MAX_BODY_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_MESSAGE_ATTACHMENTS = 10;
const MAX_FILENAME_LENGTH = 255;
// A revision check names at most this many rooms; a runner or page asks only for the rooms it follows; mirrors backend/server.py.
const MAX_REVISION_ROOMS = 100;
const MAX_TEXT_LENGTH = 32000;
const MAX_STATE_LENGTH = 4000;
const MAX_BRIEF_LENGTH = 1600;
const MAX_SUMMARY_LENGTH = 1000;
const PAGE_SIZE = 20;
const UNCATEGORIZED_FOLDER_ID = "__uncategorized__";
const PARTICIPANTS = ["用户", "Codex", "Claude", "Gemini", "DeepSeek", "Qwen", "Grok"];
// A platform is a type; `Claude` and `Claude-评审` are two instances of it with their own sessions.
const INSTANCE_PATTERN = new RegExp(`^(${PARTICIPANTS.slice(1).join("|")})(?:-[0-9A-Za-z_一-鿿]{1,16})?$`);
const MAX_ROOM_AGENTS = 12;

/** Whether a name is an AI platform or a named instance of one. */
function is_ai(name) { return typeof name === "string" && INSTANCE_PATTERN.test(name); }

/** Whether a name may author, submit or be scheduled: the user or any AI instance. */
function is_participant(name) { return name === "用户" || is_ai(name); }
const PHASES = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", paused: "已暂停", concluded: "已收束" };
const TURN_STATUSES = { pending: "待处理", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消", queued: "排队中", skipped: "未开始即取消" };
const MAX_TOPIC_DETAIL = 4000;
const MAX_QUESTION_LENGTH = 1000;
const MAX_PLAN_TURNS = 10;
const RECENT_DECISIONS = 100;
const ROUTING_VISIBLE_SECONDS = 120;
const MAX_DECISION_LABEL = 200;
const MAX_DECISION_DETAIL = 4000;
const MAX_DECISION_NOTE = 200;
const MAX_DECISION_MEMBER = 60;
const MAX_DECISION_CONTEXT = 500;
const MAX_DECISION_INPUT = 60000;
const FEEDBACK_CASES_PAGE = 50;
// Every discussion of a room with its conclusion snapshot (null until it ends) and the message counts that place it on
// the room's timeline; message ids are site-wide, so counts come from the room's own messages.
const DISCUSSIONS_SELECT = `SELECT s.id,s.goal,s.status,s.started_message_id,s.ended_message_id,s.created_at,
    (SELECT COUNT(*) FROM messages m WHERE m.room_id=s.room_id AND m.id<=s.started_message_id
      AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)) AS messages_before,
    (SELECT COUNT(*) FROM messages m WHERE m.room_id=s.room_id AND (s.ended_message_id=0 OR m.id<=s.ended_message_id)
      AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)) AS messages_through,
    c.stop_reason,c.max_rounds,c.max_minutes,c.brief,c.state,c.state_until,c.concluded_at
    FROM discussion_sessions AS s LEFT JOIN discussion_conclusions AS c ON c.session_id=s.id WHERE s.room_id=? ORDER BY s.id`;
const DECISION_SELECT = `SELECT d.*,f.rating AS feedback,COALESCE(f.should_be,'') AS should_be,COALESCE(f.note,'') AS note,c.context
  FROM scheduler_decisions d LEFT JOIN scheduler_feedback f ON f.decision_id=d.id LEFT JOIN scheduler_decision_context c ON c.decision_id=d.id`;
const LIMIT_DEFAULTS = { max_rounds: 0, max_minutes: 0, execution_minutes: 0 };
// Older clients may still send these; reaching a limit always pauses, so only the pause value is accepted and the reserve is ignored.
const LEGACY_LIMIT_FIELDS = ["on_limit", "summary_minutes"];
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
  ...Object.fromEntries(["room_directory", "room_folder_assignments", "room_creations", "room_briefs", "room_user_requests", "topic_settings", "discussion_limits", "discussion_options", "round_budgets"]
    .map((table) => [table, `SELECT * FROM ${table} WHERE room_id=?`])),
  scheduler_decisions: `${DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id`,
  topic_folders: "SELECT * FROM topic_folders WHERE id IN (SELECT folder_id FROM room_folder_assignments WHERE room_id=?)",
  messages: "SELECT * FROM messages WHERE room_id=? ORDER BY id",
  message_withdrawals: "SELECT w.* FROM message_withdrawals w JOIN messages m ON m.id=w.message_id WHERE m.room_id=? ORDER BY w.message_id",
  attachments: "SELECT * FROM attachments WHERE room_id=? AND message_id IS NOT NULL ORDER BY message_id,position",
  discussion_turns: "SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id",
  ...Object.fromEntries(["message_details", "message_summaries", "message_timings"]
    .map((table) => [table, `SELECT * FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE room_id=?) ORDER BY message_id`])),
  discussion_sessions: "SELECT * FROM discussion_sessions WHERE room_id=? ORDER BY id",
  discussion_conclusions: "SELECT * FROM discussion_conclusions WHERE room_id=? ORDER BY session_id",
  session_requests: "SELECT * FROM session_requests WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY id",
  ...Object.fromEntries(["session_state", "session_limits", "session_round_budgets", "session_pauses", "session_options"]
    .map((table) => [table, `SELECT * FROM ${table} WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY session_id`])),
  task_message_sources: "SELECT * FROM task_message_sources WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) ORDER BY message_id",
};
const MESSAGE_QUERY = `SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
  COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','api','url','user')
  THEN messages.author ELSE '用户' END) AS submitted_by, details.turn_id,
  COALESCE(summaries.text,'') AS summary, COALESCE(summaries.author,'') AS summary_by, timing.elapsed_seconds,
  answered.execution_id, answered.request_message_id, COALESCE(withdrawn.kind,'') AS withdrawn
  FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
  LEFT JOIN message_withdrawals AS withdrawn ON withdrawn.message_id=messages.id
  LEFT JOIN message_summaries AS summaries ON summaries.message_id=messages.id
  LEFT JOIN message_timings AS timing ON timing.message_id=messages.id
  LEFT JOIN (SELECT answer_id, MIN(execution_id) AS execution_id, MIN(message_id) AS request_message_id
    FROM member_requests WHERE answer_id IS NOT NULL AND execution_id IS NOT NULL GROUP BY answer_id) AS answered
    ON answered.answer_id=messages.id`;
// Messages the owner took back leave AI reads; the page asks for them with withdrawn=include to keep them in place.
const INCLUDE_WITHDRAWN = "include";
const ROOM_QUERY = `SELECT rooms.*, COALESCE(room_directory.archived,0) AS archived, COUNT(messages.id) AS message_count,
  COALESCE(MAX(messages.id),0) AS latest_id, room_folder_assignments.folder_id AS folder_id FROM rooms
  LEFT JOIN room_directory ON rooms.id=room_directory.room_id
  LEFT JOIN room_folder_assignments ON rooms.id=room_folder_assignments.room_id
  LEFT JOIN messages ON rooms.id=messages.room_id
    AND NOT EXISTS (SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)`;

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

/** Export one room's original rows in a single, read-only D1 batch transaction. */
async function room_backup(database, room_id, token = "") {
  const initial_session = await database.prepare(`SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    WHERE s.room_id=? AND s.status IN ('active','paused') AND st.phase='initial' LIMIT 1`).bind(room_id).first();
  if (initial_session) {
    const owner_hash = await runtime_hash(token);
    const owner = owner_hash && await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?").bind(room_id, owner_hash).first();
    const host = owner ? null : await database.prepare("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? AND role='host' AND status='active'")
      .bind(room_id, owner_hash).first();
    if (!owner && !host) throw new HttpError(403, "独立观点阶段需房主凭据导出");
  }
  const entries = Object.entries({ ...ROOM_BACKUP_QUERIES, ...FREE_BACKUP_QUERIES,
    room_creations: "SELECT submission_id,room_id FROM room_creations WHERE room_id=?" });
  const results = await database.batch(entries.map(([, query]) => database.prepare(query).bind(room_id)));
  const tables = Object.fromEntries(entries.map(([table], index) => [table, results[index].results]));
  if (!tables.rooms.length) throw new HttpError(404, "房间不存在");
  return { format: "ai-codiscuss-room-backup", version: 2, exported_at: new Date().toISOString(), tables };
}

// Import mirrors backend/room_import.py: same room ID, renumbered rows, triggers kept from replaying history.
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
// "reviewing" only appears in backups made before that phase was retired; it imports like discussing.
const IMPORT_ACTIVE_PHASES = ["initial", "discussing", "reviewing"];
const IMPORT_RENUMBERED = ["messages", "discussion_turns", "room_members", "member_requests", "discussion_sessions", "session_requests"];
const IMPORT_LIMIT_FIELDS = ["max_rounds", "max_minutes", "execution_minutes", "on_limit", "summary_minutes", "started_at", "closing_at", "stop_reason", "revision"];
// D1 binds at most 100 parameters per statement, so multi-row writes are chunked.
const D1_MAX_PARAMETERS = 100;

/** Validate the backup envelope and return its tables and the single room row. */
function backup_tables(backup) {
  if (backup?.format !== "ai-codiscuss-room-backup" || ![1, 2].includes(backup.version)) throw new HttpError(400, "不是可导入的房间备份（需要 ai-codiscuss-room-backup 第 1 或第 2 版）");
  const tables = backup.tables;
  if (!tables || typeof tables !== "object" || !Array.isArray(tables.rooms) || tables.rooms.length !== 1) throw new HttpError(400, "备份须恰好包含一个房间");
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new HttpError(400, `备份表 ${name} 格式无效`);
  }
  const room = tables.rooms[0];
  if (typeof room.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(room.id)) throw new HttpError(400, "备份中的房间编号无效");
  return { tables, room };
}

/** Number renumbered rows after the target's maximum, in backup order; files get new IDs. */
function import_maps(tables, bases) {
  const maps = Object.fromEntries(IMPORT_RENUMBERED.map(table => [table, new Map((tables[table] || []).map((row, index) => [row.id, bases[table] + index + 1]))]));
  maps.attachments = new Map((tables.attachments || []).map(row => [row.id, crypto.randomUUID().replaceAll("-", "")]));
  return maps;
}

/** Point `#ID` references at renumbered messages, and map a "covers up to ID" mark. */
const remap_text = (value, messages) => (value || "").replace(/#(\d+)/g, (match, id) => messages.has(Number(id)) ? `#${messages.get(Number(id))}` : match);
const remap_until = (value, messages) => Math.max(0, ...[...messages].filter(([old]) => old <= (value || 0)).map(([, renumbered]) => renumbered));

/** Insert many rows with as few statements as D1's parameter limit allows. */
function insert_rows(table, columns, rows) {
  const size = Math.floor(D1_MAX_PARAMETERS / columns.length), statements = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    statements.push([`INSERT INTO ${table} (${columns.join(",")}) VALUES ${chunk.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`, chunk.flat()]);
  }
  return statements;
}

/** Update several rows' columns by key in chunked statements. */
function update_rows(table, key, columns, rows) {
  const size = Math.floor(D1_MAX_PARAMETERS / (columns.length + 1)), statements = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size), names = ["k", ...columns.map((_, position) => `c${position}`)];
    statements.push([`WITH v(${names.join(",")}) AS (VALUES ${chunk.map(() => `(${names.map(() => "?").join(",")})`).join(",")})
      UPDATE ${table} SET ${columns.map((column, position) => `${column}=(SELECT c${position} FROM v WHERE k=${key})`).join(",")} WHERE ${key} IN (SELECT k FROM v)`, chunk.flat()]);
  }
  return statements;
}

/** Room, directory, a temporary free mode (history needs no turns) and away members; the room arrives unfiled. */
function import_room_rows(tables, room, maps, control_hash) {
  const messages = maps.messages, experts = JSON.parse(tables.topic_settings?.[0]?.experts || "{}");
  const statements = [["INSERT INTO rooms (id,title,goal,state_text,state_until,created_at) VALUES (?,?,?,?,?,?)",
    [room.id, room.title, remap_text(room.goal, messages), remap_text(room.state_text, messages), remap_until(room.state_until, messages), room.created_at]],
  ["UPDATE room_directory SET archived=? WHERE room_id=?", [tables.room_directory?.[0]?.archived ? 1 : 0, room.id]],
  ["INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,'free',?)", [room.id, control_hash]]];
  statements.push(...insert_rows("room_members", ["id", "room_id", "name", "adapter", "role", "status", "token_hash", "read_until", "created_at", "access", "session_mode"],
    (tables.room_members || []).map(member => [maps.room_members.get(member.id), room.id, member.name, member.adapter || "", member.role || "member",
      member.status === "removed" ? "removed" : "away", crypto.randomUUID().replaceAll("-", "").repeat(2), remap_until(member.read_until, messages), member.created_at,
      member.access || (experts[member.name] === "online" ? "online" : "manual"), member.session_mode || "new"])));
  return statements;
}

/** Messages and turns as queued placeholders, then their real kinds, links and statuses. */
function import_history_rows(tables, room_id, maps) {
  const { messages, discussion_turns: turns } = maps, link = (map, id) => map.get(id) ?? null;
  const statements = [
    ...insert_rows("messages", ["id", "room_id", "author", "text", "reply_to", "source", "submission_id", "created_at"], (tables.messages || []).map(row =>
      [messages.get(row.id), room_id, row.author, remap_text(row.text, messages), link(messages, row.reply_to), row.source, row.submission_id, row.created_at])),
    ...insert_rows("discussion_turns", ["id", "room_id", "expert", "question", "status", "submission_id", "created_at", "notified_at", "answer_id"], (tables.discussion_turns || []).map(row =>
      [turns.get(row.id), room_id, row.expert, remap_text(row.question, messages), "queued", row.submission_id, row.created_at, row.notified_at || "", link(messages, row.answer_id)])),
    ...insert_rows("message_details", ["message_id", "kind", "submitted_by"], (tables.message_details || []).map(row => [messages.get(row.message_id), "import", row.submitted_by])),
    ...update_rows("message_details", "message_id", ["kind", "turn_id"], (tables.message_details || []).map(row => [messages.get(row.message_id), row.kind, link(turns, row.turn_id)])),
    // A held relay stops an answered turn from promoting the next queued one; open turns are restored last.
    ["INSERT INTO turn_relay (room_id,held_since) VALUES (?,1) ON CONFLICT(room_id) DO UPDATE SET held_since=1", [room_id]]];
  const settled = (tables.discussion_turns || []).filter(row => !["queued", "notified", "pending"].includes(row.status));
  const open = (tables.discussion_turns || []).filter(row => ["notified", "pending"].includes(row.status));
  statements.push(...update_rows("discussion_turns", "id", ["status"], settled.map(row => [turns.get(row.id), row.status])),
    ...open.map(row => ["UPDATE discussion_turns SET status=? WHERE id=?", [row.status, turns.get(row.id)]]));
  return statements;
}

/** Topic, limits, idle clock and texts (a backup's retired speaking floor is ignored); an active brainstorm arrives paused because it has no run. */
function import_setting_rows(tables, room_id, maps, now) {
  const messages = maps.messages, statements = [];
  const free = (tables.room_modes || []).some(row => row.mode === "free");
  for (const row of (tables.topic_settings || []).slice(0, 1)) {
    const phase = !free && IMPORT_ACTIVE_PHASES.includes(row.phase) ? "paused" : row.phase;
    statements.push(["INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus) VALUES (?,?,?,?,?,?,?)",
      [room_id, row.host, remap_text(row.background, messages), remap_text(row.boundaries, messages), row.experts, phase, remap_text(row.focus, messages)]],
    ["INSERT INTO discussion_pauses (room_id,paused_at) VALUES (?,?)", [room_id, IMPORT_ACTIVE_PHASES.includes(phase) ? 0 : now]]);
  }
  for (const row of (tables.discussion_limits || []).slice(0, 1)) statements.push([`UPDATE discussion_limits SET ${IMPORT_LIMIT_FIELDS.map(field => `${field}=?`).join(",")} WHERE room_id=?`,
    [...IMPORT_LIMIT_FIELDS.map(field => row[field]), room_id]]);
  for (const row of (tables.room_user_requests || []).slice(0, 1)) statements.push(["INSERT INTO room_user_requests (room_id,text) VALUES (?,?)", [room_id, remap_text(row.text, messages)]]);
  for (const row of (tables.room_briefs || []).slice(0, 1)) statements.push(["INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)",
    [room_id, remap_text(row.text, messages), remap_until(row.until, messages), row.updated_at]]);
  for (const row of (tables.discussion_options || []).slice(0, 1)) statements.push(["INSERT INTO discussion_options (room_id,named_followup) VALUES (?,?)", [room_id, row.named_followup]]);
  for (const row of (tables.round_budgets || []).slice(0, 1)) statements.push(["INSERT INTO round_budgets (room_id,base,cap,extra) VALUES (?,?,?,?)", [room_id, row.base, row.cap, row.extra]]);
  for (const row of tables.scheduler_decisions || []) {
    statements.push(["INSERT INTO scheduler_decisions (room_id,after_message_id,kind,label,confidence,applied,provider,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [room_id, messages.get(row.after_message_id) ?? 0, row.kind, row.label, row.confidence ?? null, row.applied, row.provider, row.created_at]]);
    if (row.feedback) statements.push(["INSERT INTO scheduler_feedback (decision_id,rating,should_be,note,created_at) VALUES (last_insert_rowid(),?,?,?,?)",
      [row.feedback, row.should_be ?? "", row.note ?? "", row.created_at]]);
    if (row.context) statements.push(["INSERT INTO scheduler_decision_context (decision_id,context) SELECT id,? FROM scheduler_decisions WHERE room_id=? ORDER BY id DESC LIMIT 1", [row.context, room_id]]);
  }
  return statements;
}

/** Summaries, timings, attachment records and free-room requests attached to renumbered rows. */
function import_record_rows(tables, room_id, maps) {
  const { messages, room_members: members, member_requests: requests, attachments } = maps;
  return [
    ...insert_rows("message_summaries", ["message_id", "text", "author"], (tables.message_summaries || []).map(row => [messages.get(row.message_id), remap_text(row.text, messages), row.author])),
    ...insert_rows("message_timings", ["message_id", "elapsed_seconds"], (tables.message_timings || []).map(row => [messages.get(row.message_id), row.elapsed_seconds])),
    ...insert_rows("attachments", ["id", "room_id", "message_id", "position", "file_name", "content_type", "size", "sha256", "actor", "submission_id", "created_at"],
      (tables.attachments || []).map(row => [attachments.get(row.id), room_id, messages.get(row.message_id), row.position, row.file_name, row.content_type, row.size, row.sha256, row.actor, row.submission_id, row.created_at])),
    ...insert_rows("member_requests", ["id", "room_id", "member_id", "message_id", "status", "answer_id", "created_at", "chain_id", "batch_id", "purpose", "created_by"],
      (tables.member_requests || []).map(row => [requests.get(row.id), room_id, members.get(row.member_id), messages.get(row.message_id),
        ["pending", "delivering"].includes(row.status) ? "cancelled" : row.status, messages.get(row.answer_id) ?? null, row.created_at,
        messages.get(row.chain_id) ?? 0, messages.get(row.batch_id) ?? 0, row.purpose ?? "ask", row.created_by ?? "user"])),
    ...insert_rows("member_suggestions", ["message_id", "member_id"], (tables.member_suggestions || []).map(row => [messages.get(row.message_id), members.get(row.member_id)])),
    ...insert_rows("message_withdrawals", ["message_id", "kind", "created_at"], (tables.message_withdrawals || []).map(row => [messages.get(row.message_id), row.kind, row.created_at])),
    // Imported recommendations are history only: an open or waiting one no longer acts.
    ...insert_rows("member_recommendations", ["message_id", "room_id", "member_id", "provider", "confidence", "created_at", "expires_at", "status", "mode"],
      (tables.member_recommendations || []).map(row => [messages.get(row.message_id), room_id, members.get(row.member_id), row.provider, row.confidence,
        row.created_at, row.expires_at, row.status === "adopted" ? "adopted" : "open", row.mode ?? ""])),
  ];
}

/** Restore session history while converting live work into concluded, inert history. */
function import_session_rows(tables, room_id, maps) {
  const { messages, room_members: members, member_requests: member_requests, discussion_sessions: sessions,
    session_requests: requests } = maps;
  const task_messages = new Set((tables.task_message_sources || []).map(row => row.message_id));
  const latest_visible_message = Math.max(0, ...[...messages].filter(([old_id]) => !task_messages.has(old_id)).map(([, id]) => id));
  const statements = [];
  for (const row of tables.discussion_sessions || []) {
    const active = ["active", "paused"].includes(row.status);
    statements.push([`INSERT INTO discussion_sessions (id,room_id,goal,status,started_message_id,ended_message_id,created_at)
      VALUES (?,?,?,?,?,?,?)`, [sessions.get(row.id), room_id, remap_text(row.goal, messages), active ? "concluded" : row.status,
      remap_until(row.started_message_id, messages), active ? latest_visible_message : remap_until(row.ended_message_id, messages), row.created_at]]);
  }
  statements.push(...insert_rows("discussion_conclusions",
    ["session_id", "room_id", "stop_reason", "max_rounds", "max_minutes", "brief", "state", "state_until", "concluded_at"],
    (tables.discussion_conclusions || []).map(row => [sessions.get(row.session_id), room_id, row.stop_reason, row.max_rounds, row.max_minutes,
      remap_text(row.brief, messages), remap_text(row.state, messages), remap_until(row.state_until, messages), row.concluded_at])));
  for (const [table, fields] of [["session_state", ["phase", "revision", "held_since"]],
    ["session_limits", ["max_rounds", "max_minutes", "execution_minutes", "started_at", "stop_reason", "revision"]],
    ["session_round_budgets", ["base", "cap", "extra"]], ["session_pauses", ["paused_at", "paused_seconds"]],
    ["session_options", ["named_followup"]]]) {
    const columns = ["session_id", ...fields];
    statements.push(...insert_rows(table, columns, (tables[table] || []).map(row => [sessions.get(row.session_id),
      ...fields.map(field => field === "held_since" ? remap_until(row[field], messages) : row[field])])));
  }
  statements.push(...(tables.session_state || []).map(row => ["UPDATE session_state SET read_until=? WHERE session_id=?",
    [remap_until(row.read_until, messages), sessions.get(row.session_id)]]));
  statements.push(...insert_rows("session_requests",
    ["id", "session_id", "round", "position", "member_id", "purpose", "question", "status", "member_request_id", "submission_id", "read_until", "created_at"],
    (tables.session_requests || []).map(row => [requests.get(row.id), sessions.get(row.session_id), row.round, row.position, members.get(row.member_id),
      row.purpose, remap_text(row.question, messages), ["queued", "open"].includes(row.status) ? "cancelled" : row.status,
      member_requests.get(row.member_request_id) ?? null, row.submission_id, row.read_until == null ? null : remap_until(row.read_until, messages), row.created_at])));
  statements.push(...insert_rows("task_message_sources",
    ["message_id", "session_id", "session_request_id", "cause_kind", "cause_message_id", "cause_request_id"],
    (tables.task_message_sources || []).map(row => [messages.get(row.message_id), sessions.get(row.session_id), requests.get(row.session_request_id),
      row.cause_kind, messages.get(row.cause_message_id) ?? null, member_requests.get(row.cause_request_id) ?? null])));
  return statements;
}

/** Recreate a backup under the importer's control credential in one D1 batch, or skip an existing room. */
async function import_room(database, backup, control_token) {
  const control_hash = await runtime_hash(control_token);
  if (!control_hash) throw new HttpError(400, "导入须提供 32–256 字符的房间控制凭据");
  const { tables, room } = backup_tables(backup);
  const skipped = { id: room.id, title: room.title, skipped: true };
  if (await database.prepare("SELECT 1 FROM rooms WHERE id=?").bind(room.id).first()) return skipped;
  const bases = await database.prepare(`SELECT ${IMPORT_RENUMBERED.map(table => `(SELECT COALESCE(MAX(id),0) FROM ${table}) AS ${table}`).join(",")}`).first();
  const maps = import_maps(tables, bases);
  let rows;
  try {
    rows = [...import_room_rows(tables, room, maps, control_hash), ...import_history_rows(tables, room.id, maps),
      ...import_setting_rows(tables, room.id, maps, Math.floor(Date.now() / 1000)), ...import_record_rows(tables, room.id, maps),
      ...import_session_rows(tables, room.id, maps),
      ["UPDATE room_modes SET mode='free' WHERE room_id=?", [room.id]], ["DELETE FROM turn_relay WHERE room_id=?", [room.id]]];
  } catch (error) { throw new HttpError(400, `备份内容不完整，未导入：${error.message}`); }
  const statements = rows.map(([sql, values]) => database.prepare(sql).bind(...values.map(value => value === undefined ? null : value)));
  // The numbering is only valid while no other write has taken those IDs; a conflict rolls the whole batch back.
  const condition = `NOT EXISTS(SELECT 1 FROM rooms WHERE id=?) AND ${IMPORT_RENUMBERED.map(table => `(SELECT COALESCE(MAX(id),0) FROM ${table})=?`).join(" AND ")}`;
  try { await checked_batch(database, condition, [room.id, ...IMPORT_RENUMBERED.map(table => bases[table])], statements); }
  catch (error) {
    if (await database.prepare("SELECT 1 FROM rooms WHERE id=?").bind(room.id).first()) return skipped;
    if (error instanceof HttpError) throw new HttpError(409, "导入期间本站有新写入，请重试导入");
    throw new HttpError(400, `备份内容与本站数据冲突，未导入：${error.message}`);
  }
  return { id: room.id, title: room.title, imported: true, attachments: Object.fromEntries(maps.attachments) };
}

/** Store an imported attachment's original bytes once the owner's upload matches its record. */
async function import_attachment(database, bucket, room_id, attachment_id, token, data) {
  if (!bucket) throw new HttpError(503, "附件存储未配置；请绑定 ATTACHMENTS R2 存储桶");
  const hashed = await runtime_hash(token);
  if (!hashed || !await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?").bind(room_id, hashed).first()) {
    throw new HttpError(403, "需要本房间的控制凭据；没有凭据只能阅读");
  }
  const file = await get_attachment(database, room_id, attachment_id);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (data.length !== file.size || sha256 !== file.sha256) throw new HttpError(400, "附件内容与备份记录不一致");
  const key = `rooms/${room_id}/${attachment_id}`;
  if (!await bucket.head(key)) await bucket.put(key, data, { httpMetadata: { contentType: file.content_type } });
  return { attachment: file };
}

/** Confirm a room exists without loading its full view; for polled endpoints that only need the 404. */
async function require_room_id(database, room_id) {
  if (!await database.prepare("SELECT 1 FROM rooms WHERE id=?").bind(room_id).first()) throw new HttpError(404, "房间不存在");
}

/** Count formal expert opinions; the program-controlled round budget is measured in these. */
async function opinion_count(database, room_id, experts) {
  const names = Object.keys(experts || {});
  if (!names.length) return 0;
  return (await database.prepare(`SELECT COUNT(*) AS count FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id
    WHERE room_id=? AND COALESCE(details.kind,'opinion')='opinion' AND author IN (${names.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)`).bind(room_id, ...names).first()).count;
}

/** Read a room with its actual history count and latest message ID. */
async function require_room(database, room_id, token = "") {
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
  result.host_brief = await database.prepare("SELECT text,until,updated_at FROM room_briefs WHERE room_id=?").bind(room_id).first();
  result.rounds = await discussion_rounds(database, room_id, result.experts);
  result.completed_rounds = result.rounds.filter((item) => item.completed).length;
  result.round_budget = await database.prepare("SELECT base,cap,extra FROM round_budgets WHERE room_id=?").bind(room_id).first() ?? null;
  if (result.round_budget) result.opinion_count = await opinion_count(database, room_id, result.experts);
  result.session = await database.prepare("SELECT id,goal,status,started_message_id,ended_message_id,created_at FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first() ?? null;
  const live_session = await latest_session(database, room_id);
  if (live_session) result.session = { id: live_session.id, goal: live_session.goal, status: live_session.status,
    started_message_id: live_session.started_message_id, ended_message_id: live_session.ended_message_id, created_at: live_session.created_at,
    phase: live_session.phase, read_until: live_session.read_until, held_since: live_session.held_since };
  const session_limits = await session_limits_view(database, room_id);
  if (session_limits) result.limits = session_limits;
  result.discussions = (await database.prepare(DISCUSSIONS_SELECT).bind(room_id).all()).results;
  const legacy_round_groups = result.round_budget
    ? await budget_round_groups(database, room_id, result.experts, result.round_budget.base, result.session)
    : result.rounds;
  result.round_groups = legacy_round_groups.map(group => ({ ...group, key: `legacy-round-${group.number}`,
    speakers: group.speakers ?? [], participants: Object.keys(result.experts).length }));
  result.runtime = await runtime_view(database, room_id);
  result.limits = limits_view(await database.prepare(LIMITS_SQL).bind(room_id).first(), result);
  if (session_limits) result.limits = session_limits;
  result.mode = await room_mode(database, room_id);
  if (result.mode === "free" && !result.session) result.round_groups = [];
  else result.round_groups = await merge_round_groups(database, room_id, result.round_groups);
  if (result.mode !== "free") result.asks = await asks_view(database, room_id);
  result.members = (await database.prepare(`SELECT m.id,m.name,m.adapter,m.role,m.status,m.access,m.session_mode,COALESCE(src.source,'') AS manual_source,COALESCE(s.session_id,'') AS reported_session,COALESCE(s.client,'') AS reported_client,
    COALESCE(r.registered_at,'') AS registered_at
    FROM room_members AS m LEFT JOIN member_manual_sources AS src ON src.member_id=m.id LEFT JOIN member_sessions AS s ON s.member_id=m.id
    LEFT JOIN member_registrations AS r ON r.member_id=m.id AND r.token_hash=m.token_hash WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id`).bind(room_id).all()).results;
  const option = await database.prepare("SELECT named_followup FROM discussion_options WHERE room_id=?").bind(room_id).first();
  // Rooms created before the option keep the host's named follow-ups.
  result.named_followup = option ? Boolean(option.named_followup) : true;
  result.scheduler_decisions = (await database.prepare(`${DECISION_SELECT} WHERE d.room_id=? ORDER BY d.id DESC LIMIT ?`)
    .bind(room_id, RECENT_DECISIONS).all()).results.reverse();
  const details = new Map((await database.prepare("SELECT decision_id,detail FROM scheduler_decision_details WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)")
    .bind(room_id).all()).results.map((row) => [row.decision_id, JSON.parse(row.detail)]));
  for (const decision of result.scheduler_decisions) decision.detail = details.get(decision.id) ?? null;
  result.scheduler_routing = (await database.prepare("SELECT message_id FROM scheduler_routing WHERE room_id=? AND created_at>? ORDER BY message_id")
    .bind(room_id, Math.floor(Date.now() / 1000) - ROUTING_VISIBLE_SECONDS).all()).results.map((row) => row.message_id);
  result.host_arrangements = await host_arrangements(database, room_id, result.scheduler_decisions);
  result.cancelled_turns = await cancelled_turns(database, room_id);
  result.parent_room = await database.prepare("SELECT rooms.id,rooms.title FROM room_links JOIN rooms ON rooms.id=room_links.parent_id WHERE room_links.room_id=?")
    .bind(room_id).first();
  if (result.mode === "free") {
    result.linked_rooms = (await database.prepare(`SELECT rooms.id,rooms.title,COALESCE(topic_settings.phase,'preparing') AS phase
      FROM room_links JOIN rooms ON rooms.id=room_links.room_id LEFT JOIN topic_settings ON topic_settings.room_id=rooms.id
      WHERE room_links.parent_id=? ORDER BY room_links.created_at`).bind(room_id).all()).results;
    // Free rooms have no host hand-off: user messages go straight to the named members.
    result.held_since = 0;
    result.free = await free_view(database, room_id, token);
  }
  result.descriptions = await member_descriptions(database, room_id);
  result.labels = await member_labels(database, room_id);
  result.withdrawals = await message_withdrawals(database, room_id);
  result.speaking_order = await speaking_order(database, result);
  const read_limit = await initial_session_read_limit(database, room_id, token);
  if (read_limit !== null) {
    if (result.state_until > read_limit) result.state_text = "";
    if (result.host_brief?.until > read_limit) result.host_brief = null;
  }
  return result;
}

/**
 * Each plan the host created (turns saved in one batch), anchored after the latest answer before it.
 * The opening plan has no answer to follow and is anchored at 0. Invitation turns are not plans, and a plan the smart scheduler applied is already shown by its own decision.
 */
async function host_arrangements(database, room_id, decisions) {
  const plans = [];
  let latest_answer = 0;
  const rows = (await database.prepare("SELECT id,expert,question,answer_id,created_at,submission_id FROM discussion_turns WHERE room_id=? ORDER BY id").bind(room_id).all()).results;
  for (const row of rows) {
    if (!row.submission_id.startsWith("invite:")) {
      if (plans.length && plans.at(-1).created_at === row.created_at) plans.at(-1).turns.push({ expert: row.expert, question: row.question });
      else plans.push({ id: `legacy-plan-${row.id}`, key: `legacy-plan-${row.id}`, display_id: row.id,
        after_message_id: latest_answer, created_at: row.created_at, turns: [{ expert: row.expert, question: row.question }] });
    }
    latest_answer = Math.max(latest_answer, row.answer_id || 0);
  }
  plans.push(...await session_host_arrangements(database, room_id));
  const applied = new Set(decisions.filter((item) => item.applied).map((item) => item.after_message_id));
  return plans.filter((plan) => !applied.has(plan.after_message_id))
    .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.after_message_id - right.after_message_id || String(left.id).localeCompare(String(right.id)))
    .slice(-RECENT_DECISIONS);
}

/** Last ordinary transcript message before a hidden task; stable across later messages. */
async function visible_anchor_before(database, room_id, message_id) {
  if (!message_id) return 0;
  return (await database.prepare(`SELECT COALESCE(MAX(m.id),0) AS id FROM messages m WHERE m.room_id=? AND m.id<?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)`).bind(room_id, message_id).first()).id;
}

/** Request-based host plans in the same grouped shape as legacy turn plans. */
async function session_host_arrangements(database, room_id) {
  const result = [];
  const sessions = (await database.prepare("SELECT id FROM discussion_sessions WHERE room_id=? ORDER BY id").bind(room_id).all()).results;
  for (const session of sessions) {
    const rows = (await database.prepare(`SELECT q.id,q.round,q.position,q.member_id,q.question,q.created_at,q.submission_id,
      q.member_request_id,m.name AS expert,r.message_id AS task_message_id FROM session_requests q JOIN room_members m ON m.id=q.member_id
      LEFT JOIN member_requests r ON r.id=q.member_request_id
      WHERE q.session_id=? AND q.purpose='discuss' AND q.submission_id NOT LIKE 'invite:%' ORDER BY q.created_at,q.id`)
      .bind(session.id).all()).results;
    const submissions = new Set(rows.map(row => row.submission_id));
    const batches = new Map();
    for (const row of rows) {
      const match = row.submission_id.match(/^(.*)-q\d+$/);
      const base = match && submissions.has(match[1]) ? match[1] : row.submission_id;
      const key = `${base}\u0000${row.created_at}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(row);
    }
    for (const batch of batches.values()) {
      const first = batch[0];
      const host_task = first.task_message_id ? await database.prepare(`SELECT t.message_id FROM task_message_sources t
        JOIN session_requests h ON h.id=t.session_request_id WHERE h.session_id=? AND h.purpose='discuss_host' AND t.message_id<?
        ORDER BY t.message_id DESC LIMIT 1`).bind(session.id, first.task_message_id).first() : null;
      const anchor_message = host_task?.message_id ?? first.task_message_id ?? 0;
      result.push({ id: `session-${session.id}-plan-${first.id}`, key: `session-${session.id}-plan-${first.id}`, display_id: first.id,
        after_message_id: await visible_anchor_before(database, room_id, anchor_message), created_at: first.created_at,
        turns: batch.map(row => ({ expert: row.expert, question: row.question, round: row.round })) });
    }
  }
  return result;
}

/**
 * Assignments that ended without an answer, anchored where their wake card first appeared:
 * the later of the previous turn's answer and the latest message at creation time.
 */
async function cancelled_turns(database, room_id) {
  const rows = (await database.prepare(`SELECT id,expert,question,status,answer_id,notified_at,created_at,
    (SELECT COALESCE(MAX(messages.id),0) FROM messages WHERE messages.room_id=discussion_turns.room_id AND messages.created_at<=discussion_turns.created_at) AS created_after
    FROM discussion_turns WHERE room_id=? ORDER BY id`).bind(room_id).all()).results;
  const cancelled = [];
  let latest_answer = 0;
  for (const row of rows) {
    if (row.status === "cancelled" && row.notified_at && !row.answer_id) cancelled.push({ id: `legacy-turn-${row.id}`, key: `legacy-turn-${row.id}`, created_at: row.created_at,
      display_id: row.id, expert: row.expert, question: row.question, status: row.status,
      after_message_id: Math.max(latest_answer, row.created_after) });
    latest_answer = Math.max(latest_answer, row.answer_id || 0);
  }
  cancelled.push(...await session_cancelled_turns(database, room_id));
  return cancelled.sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? ""))
    || left.after_message_id - right.after_message_id || String(left.id).localeCompare(String(right.id))).slice(-RECENT_DECISIONS);
}

/** Only assignments that were opened, have no answer and do not already have an execution failure card. */
async function session_cancelled_turns(database, room_id) {
  const rows = (await database.prepare(`SELECT q.id,q.session_id,q.question,q.status,q.created_at,m.name AS expert,r.message_id AS task_message_id,r.execution_id
    FROM session_requests q JOIN room_members m ON m.id=q.member_id JOIN member_requests r ON r.id=q.member_request_id
    WHERE q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?) AND q.purpose='discuss'
      AND q.status IN ('cancelled','skipped') AND q.member_request_id IS NOT NULL AND r.answer_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM member_executions e WHERE e.id=r.execution_id AND e.status='failed') ORDER BY q.id`)
    .bind(room_id).all()).results;
  return Promise.all(rows.map(async row => ({ id: `session-${row.session_id}-request-${row.id}`, key: `session-${row.session_id}-request-${row.id}`, display_id: row.id,
    expert: row.expert, question: row.question, status: row.status, created_at: row.created_at, execution_id: row.execution_id,
    after_message_id: await visible_anchor_before(database, room_id, row.task_message_id) })));
}

/** Combine legacy and all request-based rounds in transcript order. */
async function merge_round_groups(database, room_id, legacy_groups) {
  const sessions = (await database.prepare("SELECT id,started_message_id,ended_message_id FROM discussion_sessions WHERE room_id=? ORDER BY id").bind(room_id).all()).results;
  const groups = [...legacy_groups];
  for (const session of sessions) groups.push(...await session_round_groups(database, room_id, session));
  return groups.sort((left, right) => left.start_id - right.start_id || left.key.localeCompare(right.key));
}

/** Group request-based chat answers by their stored discussion round. */
async function session_round_groups(database, room_id, session) {
  const rows = (await database.prepare(`SELECT q.round,q.status,q.member_id,m.name AS expert,m.role,r.answer_id
    FROM session_requests q JOIN room_members m ON m.id=q.member_id LEFT JOIN member_requests r ON r.id=q.member_request_id
    WHERE q.session_id=? AND q.purpose='discuss' AND r.answer_id IS NOT NULL ORDER BY q.round,q.position,q.id`).bind(session.id).all()).results;
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.round) ?? { number: row.round, speakers: [], opinions: 0, completed: false, host_scheduled: false };
    if (row.answer_id) { group.opinions++; if (!group.speakers.includes(row.expert)) group.speakers.push(row.expert); }
    group.host_scheduled ||= row.role === 'host';
    groups.set(row.round, group);
  }
  if (!groups.size) return [];
  const active_experts = (await database.prepare(`SELECT COUNT(*) AS count FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
    WHERE m.room_id=? AND m.status='active' AND m.role<>'host' AND (m.access<>'manual' OR src.source='web'
      OR EXISTS(SELECT 1 FROM member_registrations reg WHERE reg.member_id=m.id AND reg.token_hash=m.token_hash))`).bind(room_id).first()).count;
  let previous_answer = 0;
  const result = [];
  for (const [number, group] of [...groups].sort(([left], [right]) => left - right)) {
    const denominator = active_experts + Number(group.host_scheduled);
    group.completed = denominator > 0 && group.opinions >= denominator;
    group.start_id = Math.max(session.started_message_id || 0, previous_answer) + 1;
    previous_answer = (await database.prepare(`SELECT COALESCE(MAX(r.answer_id),0) AS id FROM session_requests q
      JOIN member_requests r ON r.id=q.member_request_id WHERE q.session_id=? AND q.purpose='discuss' AND q.round=?`)
      .bind(session.id, number).first()).id;
    const { host_scheduled, ...visible } = group;
    result.push({ ...visible, session_id: session.id, key: `session-${session.id}-round-${number}`,
      end_id: session.ended_message_id || null, participants: denominator });
  }
  return result;
}

/** Group complete history metadata until every configured expert has spoken. */
async function discussion_rounds(database, room_id, experts) {
  const participants = Object.keys(experts);
  if (!participants.length) return [];
  const rows = await database.prepare(`SELECT messages.id,messages.author,
    COALESCE(details.kind,'opinion') AS kind FROM messages
    LEFT JOIN message_details AS details ON details.message_id=messages.id
    WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)
    ORDER BY messages.id`).bind(room_id).all();
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

/**
 * Group history by the round budget's rule: every expert-count opinions form a round, and a new segment (base) starts a new one.
 * Only messages of the latest discussion are grouped, numbered from 1; free collaboration before or after it has no rounds.
 * `rounds` stays speaker-based because scheduling needs who still owes a turn; this view only labels history.
 */
async function budget_round_groups(database, room_id, experts, base, session) {
  const participants = Object.keys(experts);
  if (!participants.length || !session) return [];
  const first = session.started_message_id;
  const last = session.ended_message_id || Infinity;
  const rows = await database.prepare(`SELECT messages.id,messages.author,
    COALESCE(details.kind,'opinion') AS kind FROM messages
    LEFT JOIN message_details AS details ON details.message_id=messages.id
    WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)
    ORDER BY messages.id`).bind(room_id).all();
  const groups = [];
  let next_start = null;
  let seen = 0;
  for (const message of rows.results) {
    const opinion = message.kind === "opinion" && participants.includes(message.author);
    // base counts every opinion in the room, so opinions outside the discussion still advance seen.
    if (opinion) seen += 1;
    if (message.id <= first || message.id > last) continue;
    next_start ??= message.id;
    if (!opinion) continue;
    if (!groups.length || groups.at(-1).completed) groups.push({ number: groups.length + 1, start_id: next_start, opinions: 0, completed: false });
    const current = groups.at(-1);
    current.opinions += 1;
    current.completed = current.opinions >= participants.length || seen === base;
    if (current.completed) next_start = null;
  }
  return groups;
}

/** Describe pending work using the expert's configured participation mode. */
function turn_status_label(turn, room) {
  if (turn.status === "pending") return { cli: "待处理（本地 CLI）", online: "待联系（在线专家）" }[room.experts[turn.expert]] || "待处理";
  return TURN_STATUSES[turn.status];
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
    experts: Object.fromEntries(PARTICIPANTS.slice(1).filter(name => name !== "Grok").map((name) => [name, name === "Codex" ? "cli" : "online"])) };
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
    Object.keys(experts).length > MAX_ROOM_AGENTS || Object.entries(experts).some(([name, mode]) => !is_ai(name) || !["cli", "online"].includes(mode))) {
    throw new HttpError(400, "专家需为有效 AI 身份，参与方式为 cli 或 online");
  }
  if (result.host !== "用户" && experts[result.host] !== "cli") throw new HttpError(400, "AI 主持人必须是可读可写的本地 CLI 参与者");
  if (!Object.hasOwn(PHASES, result.phase)) throw new HttpError(400, "话题阶段无效");
  if (Object.hasOwn(payload, "limits")) {
    result.limits = limit_values(payload.limits, current.limits);
    const changed = current.limits && Object.keys(LIMIT_DEFAULTS).some(key => result.limits[key] !== current.limits[key]);
    if (changed && !["preparing", "paused"].includes(current.phase)) throw new HttpError(400, "请先暂停讨论，再修改上限参数");
    result.save_limits = !current.limits || changed;
    result.reset_stop = !current.limits || Object.keys(LIMIT_DEFAULTS).some(key => key !== "execution_minutes" && result.limits[key] !== current.limits[key]);
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
/** What a host must clear before concluding: unhandled user input, a stale state, queued turns; revision changes with any of them. */
async function conclusion_view(database, room) {
  const session = await latest_session(database, room.id);
  if (session) {
    const last_answer = (await database.prepare(`SELECT COALESCE(MAX(r.answer_id),0) AS id FROM session_requests q
      JOIN member_requests r ON r.id=q.member_request_id WHERE q.session_id=? AND q.purpose='discuss' AND q.status='answered'`)
      .bind(session.id).first()).id;
    const open = (await database.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='open'")
      .bind(session.id).first()).count;
    const queued = (await database.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='queued'")
      .bind(session.id).first()).count;
    const blockers = [];
    if (session.held_since) blockers.push('有未处理的用户留言或设置变更');
    if (room.state_until < last_answer) blockers.push(`状态整理至 #${room.state_until}，未覆盖最新回答 #${last_answer}；先更新 state 与简报`);
    if (open) blockers.push('仍有正在执行的专家发言');
    const state = [session.id, session.state_revision, session.held_since, room.latest_id, room.state_until, last_answer, open, queued];
    return { latest_id: room.latest_id, last_opinion_id: last_answer, state_until: room.state_until, held_since: session.held_since,
      queued, blockers, ready: !blockers.length, revision: (await digest_hex(JSON.stringify(state))).slice(0, 16) };
  }
  const names = Object.keys(room.experts);
  const last_opinion = names.length ? (await database.prepare(`SELECT COALESCE(MAX(messages.id),0) AS id FROM messages
    LEFT JOIN message_details AS details ON details.message_id=messages.id
    WHERE room_id=? AND COALESCE(details.kind,'opinion')='opinion' AND author IN (${names.map(() => "?").join(",")})`).bind(room.id, ...names).first()).id : 0;
  const blockers = [];
  if (room.held_since) blockers.push("有未处理的用户留言或设置变更");
  if (room.state_until < last_opinion) blockers.push(`状态整理至 #${room.state_until}，未覆盖最新发言 #${last_opinion}；先更新 state 与简报`);
  if (room.queued_turns.length) blockers.push(QUEUED_BLOCKER);
  const state = JSON.stringify([room.latest_id, room.state_until, room.held_since, room.queued_turns.length]);
  return { latest_id: room.latest_id, last_opinion_id: last_opinion, state_until: room.state_until, held_since: room.held_since,
    queued: room.queued_turns.length, blockers, ready: !blockers.length, revision: (await digest_hex(state)).slice(0, 12) };
}

const QUEUED_BLOCKER = "仍有排队的发言安排";

/** A host concludes only against the latest conclusion state with nothing blocking; the user is not bound by this.
 * Declaring the goal done or forcing the wrap-up skips queued turns itself, so they do not block those. */
async function require_conclusion_ready(database, room, payload, allow_queued = false) {
  if (payload.actor === "用户") return;
  const view = await conclusion_view(database, room);
  if (allow_queued) view.blockers = view.blockers.filter((item) => item !== QUEUED_BLOCKER);
  if (payload.conclusion === undefined || payload.conclusion === null) throw new HttpError(400, "收束前须先读取收束状态（room conclusion），并带上其 revision");
  if (payload.conclusion !== view.revision) throw new HttpError(409, "房间状态已变化，请重新读取 room conclusion 后再收束");
  if (view.blockers.length) throw new HttpError(400, `暂不能收束：${view.blockers.join("；")}`);
}

async function update_topic(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const active_session = await latest_session(database, room_id);
  if (room.mode === "free" && Object.hasOwn(payload, "phase")) throw new HttpError(400, "自由协作房间不接受 phase 字段");
  if (active_session && Object.hasOwn(payload, "limits")) throw new HttpError(400, "讨论会话进行中，不能通过 topic 修改上限");
  const settings = topic_values(payload, room);
  const changed = Object.keys({ ...settings.experts, ...room.experts }).some(name => settings.experts[name] !== room.experts[name]);
  if (active_session) {
    if (settings.host !== room.host || changed) throw new HttpError(400, "讨论会话进行中请在进度看板邀请、暂离或移除专家");
    await database.batch([
      database.prepare("UPDATE rooms SET title=?,goal=? WHERE id=?").bind(settings.title, settings.goal, room_id),
      database.prepare("UPDATE topic_settings SET background=?,boundaries=?,focus=? WHERE room_id=?")
        .bind(settings.background, settings.boundaries, settings.focus, room_id),
      database.prepare("INSERT INTO room_user_requests (room_id,text) VALUES (?,?) ON CONFLICT(room_id) DO UPDATE SET text=excluded.text")
        .bind(room_id, settings.user_request || ""),
    ]);
    return require_room(database, room_id);
  }
  if (room.archived && !["paused", "concluded"].includes(settings.phase)) throw new HttpError(400, "请先恢复已存档房间，再调整讨论阶段");
  const turn = room.current_turn;
  if (turn && ["pending", "notified"].includes(turn.status) && (settings.phase === "concluded" || !settings.experts[turn.expert])) {
    throw new HttpError(400, "请先完成或取消当前发言安排");
  }
  if (settings.phase === "concluded" && room.phase !== "concluded") await require_conclusion_ready(database, room, payload);
  if (room.phase === "concluded" && settings.phase !== "concluded" && payload.actor !== "用户") throw new HttpError(400, "已收束的讨论只有用户能重新开启");
  if (changed && room.runtime?.status === "running") throw new HttpError(400, "讨论运行中请在进度看板邀请、暂离或移除专家");
  const plain = database;
  if (settings.save_limits) database = guarded_database(database,
    "EXISTS(SELECT 1 FROM topic_settings JOIN discussion_limits USING(room_id) WHERE room_id=? AND phase IN ('preparing','paused') AND revision=?)",
    [room_id, room.limits.revision]);
  try {
    await database.batch([
      database.prepare("UPDATE rooms SET title=?,goal=? WHERE id=?").bind(settings.title, settings.goal, room_id),
      ...await discussion_member_statements(database, room_id, payload, settings),
      ...limit_statements(database, room_id, settings),
      ...topic_statements(database, room_id, settings),
    ]);
  } catch (error) {
    if (String(error).includes("open_turn")) throw new HttpError(400, "请先完成或取消当前发言安排");
    if (String(error).includes("topic_archived")) throw new HttpError(400, "请先恢复已存档房间，再调整讨论阶段");
    throw error;
  }
  if (settings.phase === "concluded" && room.phase !== "concluded" && room.mode !== "free" && !room.archived) {
    const held = await held_user_messages(plain, { ...room, host: settings.host });
    await plain.batch(return_to_free_statements(plain, room_id));
    await route_held_messages(plain, room_id, held);
  }
  return require_room(database, room_id);
}

async function session_revision(database, room_id) {
  const session = await database.prepare("SELECT id,status FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first();
  const latest_visible_id = (await database.prepare(`SELECT COALESCE(MAX(m.id),0) AS id FROM messages m
    WHERE m.room_id=? AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)`).bind(room_id).first()).id;
  const state = session ? await database.prepare(`SELECT s.id,s.status,st.phase,st.read_until,st.held_since,st.revision,
    l.max_rounds,l.max_minutes,l.execution_minutes,l.started_at,l.stop_reason,l.revision AS limits_revision,
    (SELECT COUNT(*) FROM session_requests q WHERE q.session_id=s.id AND q.status='answered') AS answered,
    (SELECT group_concat(id||':'||member_id||':'||status,',') FROM session_requests q WHERE q.session_id=s.id ORDER BY id) AS requests
    FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    JOIN session_limits l ON l.session_id=s.id WHERE s.id=?`).bind(session.id).first() : null;
  const members = (await database.prepare(`SELECT m.id,m.name,m.status,m.access,m.role,COALESCE(src.source,'') AS manual_source,
    EXISTS(SELECT 1 FROM member_registrations r WHERE r.member_id=m.id AND r.token_hash=m.token_hash) AS registered
    FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
    WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id`).bind(room_id).all()).results;
  return (await digest_hex(JSON.stringify([session?.id ?? 0, session?.status ?? '', latest_visible_id, state, members]))).slice(0, 16);
}

async function require_session_revision(database, room_id, payload) {
  if (payload.revision === undefined || payload.revision === null || payload.revision === "") throw new HttpError(400, "先读取 discussion 获取最新 revision 再提交");
  if (payload.revision !== await session_revision(database, room_id)) throw new HttpError(409, "讨论状态已变化，请重新读取 discussion");
}

function stable_json(value) {
  if (Array.isArray(value)) return `[${value.map(stable_json).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable_json(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function start_request_json(payload) {
  const request = Object.fromEntries(["revision", "goal", "limits", "named_followup"]
    .filter(key => Object.hasOwn(payload, key)).map(key => [key, payload[key]]));
  return stable_json(request);
}

async function start_submission_result(database, room_id, submission_id, request_json) {
  const existing = await database.prepare(`SELECT s.id,s.goal,s.status,s.started_message_id,s.ended_message_id,s.created_at,b.request_json
    FROM session_start_submissions b JOIN discussion_sessions s ON s.id=b.session_id
    WHERE b.room_id=? AND b.submission_id=?`).bind(room_id, submission_id).first();
  if (!existing) return null;
  if (existing.request_json !== request_json) throw new HttpError(409, "该 submission_id 已用于不同的讨论启动内容");
  const { request_json: _request_json, ...session } = existing;
  return { session: { ...session, start_submission_id: submission_id }, revision: await session_revision(database, room_id), duplicate: true };
}

async function session_view(database, room_id) {
  const active = await latest_session(database, room_id);
  if (active && await finish_session_if_limited(database, active, room_id)) await release_session_messages(database, room_id, active);
  const revision = await session_revision(database, room_id);
  const session = await database.prepare(`SELECT s.id,s.goal,s.status,s.started_message_id,s.ended_message_id,s.created_at,
    st.phase,st.read_until,st.held_since,st.revision,(SELECT COUNT(*) FROM session_requests q
      WHERE q.session_id=s.id AND q.purpose='discuss' AND q.status='answered') AS answered,
    COALESCE((SELECT named_followup FROM session_options o WHERE o.session_id=s.id),0) AS named_followup,
    l.max_rounds,l.max_minutes,l.execution_minutes,l.started_at,l.stop_reason,l.revision AS limits_revision,
    p.paused_at,p.paused_seconds FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    JOIN session_limits l ON l.session_id=s.id JOIN session_pauses p ON p.session_id=s.id
    WHERE s.room_id=? AND s.status IN ('active','paused') ORDER BY s.id DESC LIMIT 1`).bind(room_id).first();
  if (!session) return { session: null, revision };
  const start_submission = await database.prepare("SELECT submission_id FROM session_start_submissions WHERE session_id=?").bind(session.id).first();
  const limits = await session_limits_view(database, room_id);
  return { session: { ...session, start_submission_id: start_submission?.submission_id ?? null,
    named_followup: Boolean(session.named_followup), limits: { max_rounds: session.max_rounds, max_minutes: session.max_minutes,
    execution_minutes: session.execution_minutes, started_at: session.started_at, stop_reason: session.stop_reason,
    revision: session.limits_revision, ...limits }, pause: { paused_at: session.paused_at, paused_seconds: session.paused_seconds } }, revision };
}

async function session_limits_view(database, room_id) {
  const session = await database.prepare(`SELECT s.id,s.status,l.*,p.paused_at,p.paused_seconds,b.base,b.cap,b.extra
    FROM discussion_sessions s JOIN session_limits l ON l.session_id=s.id
    JOIN session_pauses p ON p.session_id=s.id JOIN session_round_budgets b ON b.session_id=s.id
    WHERE s.room_id=? ORDER BY s.id DESC LIMIT 1`).bind(room_id).first();
  if (!session) return null;
  const now = Math.floor(Date.now() / 1000);
  const concluded_at = session.status === 'concluded'
    ? await database.prepare("SELECT CAST(strftime('%s',concluded_at) AS INTEGER) AS at FROM discussion_conclusions WHERE session_id=?").bind(session.id).first()
    : null;
  const end = concluded_at?.at || now;
  const idle = session.paused_seconds + (session.paused_at ? Math.max(0, end - session.paused_at) : 0);
  const deadline = session.started_at && session.max_minutes ? session.started_at + session.max_minutes * 60 + idle : 0;
  const rounds = (await database.prepare(`SELECT q.round,COUNT(*) AS answered,
      MAX(CASE WHEN m.role='host' THEN 1 ELSE 0 END) AS host_scheduled
    FROM session_requests q JOIN room_members m ON m.id=q.member_id
    WHERE q.session_id=? AND q.purpose='discuss' AND q.status='answered' GROUP BY q.round ORDER BY q.round`).bind(session.id).all()).results;
  const active_count = (await database.prepare(`SELECT COUNT(*) AS count FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
    WHERE m.room_id=? AND m.status='active' AND m.role<>'host' AND (m.access<>'manual' OR src.source='web'
      OR EXISTS(SELECT 1 FROM member_registrations r WHERE r.member_id=m.id AND r.token_hash=m.token_hash))`).bind(room_id).first()).count;
  const score = rounds.reduce((total, row) => {
    const divisor = active_count + row.host_scheduled;
    return total + (divisor ? row.answered / divisor : 0);
  }, 0);
  const completed_rounds = Math.floor(score + Number.EPSILON);
  const round_cap = session.cap || session.max_rounds;
  const reason = ['time_limit', 'round_limit'].includes(session.stop_reason) ? session.stop_reason
    : deadline && end >= deadline ? 'time_limit' : round_cap && completed_rounds >= round_cap ? 'round_limit' : '';
  const answered = (await database.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='answered'").bind(session.id).first()).count;
  return { deadline, reached: Boolean(reason), reason, completed_rounds, segment_rounds: completed_rounds,
    round_cap, extra_rounds: session.extra, answered, elapsed_seconds: Math.max(0, end - session.started_at - idle),
    remaining_seconds: deadline ? Math.max(0, deadline - end) : null };
}

async function update_session_limits(database, room_id, token, payload) {
  const action = payload.action;
  if (action === 'done') return conclude_session_by_host(database, room_id, token, payload);
  if (action === 'check') {
    if (payload.actor === '用户') await require_free_owner(database, room_id, token);
    else {
      const actor = await require_free_member(database, room_id, token, payload.actor);
      if (actor.role !== 'host') throw new HttpError(403, '只有当前主持人可以检查讨论上限');
    }
    const session = await latest_session(database, room_id);
    if (session && await finish_session_if_limited(database, session, room_id)) await release_session_messages(database, room_id, session);
    return require_room(database, room_id);
  }
  if (action === 'reopen') throw new HttpError(400, '新讨论会话请通过 discussion 接口重新开启');
  const owner_hash = await require_free_owner(database, room_id, token);
  if (action !== undefined) throw new HttpError(400, 'action 须为 check 或 done');
  const session = await latest_session(database, room_id);
  if (!session) throw new HttpError(409, '房间没有进行中的讨论会话');
  await require_session_revision(database, room_id, payload);
  if (session.status !== 'paused') throw new HttpError(400, '请先暂停讨论，再修改上限参数');
  const values = Object.fromEntries(Object.entries(payload).filter(([key]) => !['revision', 'action', 'actor'].includes(key)));
  if (!Object.keys(values).length) throw new HttpError(400, '至少提供一项讨论上限字段');
  const current = { max_rounds: session.max_rounds, max_minutes: session.max_minutes, execution_minutes: session.execution_minutes };
  const limits = limit_values(values, current);
  await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    WHERE s.id=? AND s.status='paused' AND st.revision=?) AND EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)`,
    [session.id, session.state_revision, room_id, owner_hash], [
      database.prepare('UPDATE session_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,revision=revision+1 WHERE session_id=?')
        .bind(limits.max_rounds, limits.max_minutes, limits.execution_minutes, session.id),
      database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id),
    ]);
  const latest = await latest_session(database, room_id);
  if (latest && await finish_session_if_limited(database, latest, room_id)) await release_session_messages(database, room_id, latest);
  return session_view(database, room_id);
}

async function conclude_session_by_host(database, room_id, token, payload) {
  const host = await require_free_member(database, room_id, token, payload.actor);
  if (host.role !== 'host') throw new HttpError(403, '只有当前主持人可以结束讨论');
  const session = await latest_session(database, room_id);
  if (!session || session.status !== 'active') throw new HttpError(409, '讨论未处于进行状态');
  const room = await require_room(database, room_id);
  const conclusion = await conclusion_view(database, room);
  if (payload.conclusion === undefined || payload.conclusion === null) throw new HttpError(400, '收束前须先读取收束状态（room conclusion），并带上其 revision');
  if (payload.conclusion !== conclusion.revision) throw new HttpError(409, '房间状态已变化，请重新读取 room conclusion 后再收束');
  if (conclusion.blockers.length) throw new HttpError(400, `暂不能收束：${conclusion.blockers.join('；')}`);
  const latest = room.latest_id;
  const stamp = new Date().toISOString();
  const state = (await database.prepare('SELECT state_text,state_until FROM rooms WHERE id=?').bind(room_id).first());
  const brief = await database.prepare('SELECT text,until FROM room_briefs WHERE room_id=?').bind(room_id).first();
  await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions WHERE id=? AND status='active')
    AND EXISTS(SELECT 1 FROM session_state WHERE session_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND role='host' AND status='active' AND token_hash=?)
    AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=? AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE message_id=messages.id)),0)=?`,
    [session.id, session.id, session.state_revision, host.id, host.token_hash, room_id, latest], [
      database.prepare(`INSERT OR REPLACE INTO discussion_conclusions(session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
        SELECT ?,?,?,?, ?,?,?,?,?`).bind(session.id, room_id, 'goal_done', session.max_rounds, session.max_minutes,
          brief && brief.until > session.started_message_id ? brief.text : '', state.state_until > session.started_message_id ? state.state_text : '',
          state.state_until > session.started_message_id ? state.state_until : 0, stamp),
      database.prepare("UPDATE discussion_sessions SET status='concluded',ended_message_id=? WHERE id=?").bind(latest, session.id),
      database.prepare("UPDATE session_limits SET stop_reason='goal_done',revision=revision+1 WHERE session_id=?").bind(session.id),
      database.prepare("UPDATE session_requests SET status='cancelled' WHERE session_id=? AND status IN ('open','queued')").bind(session.id),
      database.prepare("INSERT OR REPLACE INTO request_cancel_reasons(request_id,reason) SELECT id,'user_stop' FROM member_requests WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')").bind(session.id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')").bind(session.id),
      database.prepare("UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='goal_done' WHERE id IN (SELECT execution_id FROM member_requests WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled')) AND status IN ('dispatched','started')").bind(session.id),
      database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id),
    ]);
  await release_session_messages(database, room_id, session);
  return require_room(database, room_id);
}

async function latest_session(database, room_id) {
  const session = await database.prepare(`SELECT s.*,st.phase,st.read_until,st.held_since,st.revision AS state_revision,
    l.max_rounds,l.max_minutes,l.execution_minutes,l.started_at,l.stop_reason,l.revision AS limits_revision,
    p.paused_at,p.paused_seconds FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    JOIN session_limits l ON l.session_id=s.id JOIN session_pauses p ON p.session_id=s.id
    WHERE s.room_id=? AND s.status IN ('active','paused') ORDER BY s.id DESC LIMIT 1`).bind(room_id).first();
  return session;
}

async function has_session_request_model(database, room_id) {
  return Boolean(await database.prepare(`SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    WHERE s.room_id=? LIMIT 1`).bind(room_id).first());
}

async function reject_legacy_session_write(database, room_id) {
  if (await has_session_request_model(database, room_id)) throw new HttpError(409, "该房间已使用讨论会话请求接口；旧讨论运行接口仅保留历史读取");
}

async function add_task_request(database, session, member_id, purpose, submission_id, question, cause_kind, cause_message_id = null, cause_request_id = null, host_guard = null) {
  const member = await database.prepare("SELECT name FROM room_members WHERE id=?").bind(member_id).first();
  const timestamp = new Date().toISOString();
  const statements = [
    database.prepare("UPDATE session_requests SET status='open' WHERE id=? AND status='queued'").bind(session.request_id),
    database.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
      SELECT ?, '系统任务', ?, 'system', ?, ? WHERE EXISTS(SELECT 1 FROM session_requests WHERE id=? AND status='open')`)
      .bind(session.room_id, question, submission_id, timestamp, session.request_id),
    database.prepare(`INSERT INTO member_requests(room_id,member_id,message_id,status,created_at,purpose,created_by)
      SELECT ?,?,id,'pending',unixepoch(),?,'host' FROM messages WHERE room_id=? AND submission_id=?`)
      .bind(session.room_id, member_id, purpose, session.room_id, submission_id),
    database.prepare(`UPDATE session_requests SET member_request_id=(SELECT id FROM member_requests WHERE room_id=?
      AND message_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)) WHERE id=? AND status='open'`)
      .bind(session.room_id, session.room_id, submission_id, session.request_id),
    database.prepare(`INSERT INTO task_message_sources(message_id,session_id,session_request_id,cause_kind,cause_message_id,cause_request_id)
      SELECT m.id,?,q.id,?,?,? FROM messages m JOIN session_requests q ON q.id=? WHERE m.room_id=? AND m.submission_id=?`)
      .bind(session.id, cause_kind, cause_message_id, cause_request_id, session.request_id, session.room_id, submission_id),
  ];
  const host_condition = host_guard ? `AND EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      WHERE s.id=? AND s.status='active' AND st.revision=? )
      AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND token_hash=? AND role='host' AND status='active')
      AND (SELECT COUNT(*) FROM room_members WHERE room_id=? AND status='active')=?` : "";
  await checked_batch(database, `EXISTS(SELECT 1 FROM session_requests WHERE id=? AND status IN ('open','queued') AND member_id=?)
    AND EXISTS(SELECT 1 FROM discussion_sessions WHERE id=? AND status='active')
    AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active')
    AND NOT EXISTS(SELECT 1 FROM messages WHERE room_id=? AND submission_id=?) ${host_condition}`,
    [session.request_id, member_id, session.id, member_id, session.room_id, submission_id,
      ...(host_guard ? [session.id, host_guard.state_revision, host_guard.host_id, host_guard.token_hash, session.room_id, host_guard.active_count] : [])], statements);
  const request = await database.prepare("SELECT id FROM member_requests WHERE room_id=? AND message_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)")
    .bind(session.room_id, session.room_id, submission_id).first();
  return { message_id: (await database.prepare("SELECT id FROM messages WHERE room_id=? AND submission_id=?").bind(session.room_id, submission_id).first()).id,
    member_id, member: member.name, request_id: request.id };
}

async function create_session_task(database, session_id, member_id, purpose, question, cause_kind, cause_message_id = null, cause_request_id = null) {
  const session = await database.prepare(`SELECT s.room_id,st.read_until FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id WHERE s.id=?`).bind(session_id).first();
  if (cause_message_id !== null || cause_request_id !== null) {
    const prior = await database.prepare(`SELECT q.id FROM session_requests q JOIN task_message_sources t ON t.session_request_id=q.id
      WHERE q.session_id=? AND q.member_id=? AND q.purpose=? AND t.cause_kind=?
      AND t.cause_message_id IS ? AND t.cause_request_id IS ? LIMIT 1`).bind(session_id, member_id, purpose, cause_kind, cause_message_id, cause_request_id).first();
    if (prior) return prior.id;
  }
  const causal_id = cause_message_id ?? cause_request_id ?? crypto.randomUUID();
  const submission_id = `session-task-${session_id}-${cause_kind}-${causal_id}`;
  const timestamp = new Date().toISOString();
  const statements = [
    database.prepare(`INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
      VALUES(?,0,0,?,?,?,'open',?,?,?)`).bind(session_id, member_id, purpose, question, submission_id, null, timestamp),
    database.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
      SELECT ?, '系统任务', ?, 'system', ?, ? WHERE EXISTS(SELECT 1 FROM session_requests WHERE session_id=? AND submission_id=?)`)
      .bind(session.room_id, question, submission_id, timestamp, session_id, submission_id),
    database.prepare(`INSERT INTO member_requests(room_id,member_id,message_id,status,created_at,purpose,created_by)
      SELECT ?,?,id,'pending',unixepoch(),?,'host' FROM messages WHERE room_id=? AND submission_id=?`)
      .bind(session.room_id, member_id, purpose, session.room_id, submission_id),
    database.prepare(`UPDATE session_requests SET member_request_id=(SELECT id FROM member_requests WHERE room_id=? AND message_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?))
      WHERE session_id=? AND submission_id=?`).bind(session.room_id, session.room_id, submission_id, session_id, submission_id),
    database.prepare(`INSERT INTO task_message_sources(message_id,session_id,session_request_id,cause_kind,cause_message_id,cause_request_id)
      SELECT m.id,q.session_id,q.id,?,?,? FROM messages m JOIN session_requests q ON q.session_id=? AND q.submission_id=?
      WHERE m.room_id=? AND m.submission_id=?`).bind(cause_kind, cause_message_id, cause_request_id,
        session_id, submission_id, session.room_id, submission_id),
  ];
  statements.push(database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session_id));
  try {
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions WHERE id=? AND status='active')
      AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active')
      AND NOT EXISTS(SELECT 1 FROM messages WHERE room_id=? AND submission_id=?)`,
      [session_id, member_id, session.room_id, submission_id], statements);
  } catch (error) {
    const prior = await database.prepare("SELECT id FROM session_requests WHERE session_id=? AND submission_id=?").bind(session_id, submission_id).first();
    if (prior) return prior.id;
    throw error;
  }
  return (await database.prepare("SELECT id FROM session_requests WHERE session_id=? AND submission_id=?").bind(session_id, submission_id).first()).id;
}

async function session_roster(database, room_id) {
  const session = await latest_session(database, room_id);
  if (!session) throw new HttpError(409, "房间没有进行中的讨论");
  const room = await require_room(database, room_id);
  const requests = (await database.prepare("SELECT round,member_id,status,purpose FROM session_requests WHERE session_id=? ORDER BY id").bind(session.id).all()).results;
  const open_rounds = requests.filter(row => row.purpose === "discuss" && ["open", "queued"].includes(row.status)).map(row => row.round);
  const round = open_rounds.length ? Math.min(...open_rounds) : Math.max(1, ...requests.filter(row => row.purpose === "discuss").map(row => row.round));
  const spoken = new Set(requests.filter(row => row.round === round && row.purpose === "discuss" && row.status === "answered").map(row => row.member_id));
  const members = room.members.filter(member => member.status === "active");
  const experts = members.map(member => ({ id: member.id, name: member.name, host: member.role === "host",
    mode: room.experts[member.name] ?? "cli", spoken: spoken.has(member.id),
    registered: member.access !== "manual" || member.manual_source === "web" || Boolean(member.registered_at) }));
  const unregistered = experts.filter(item => !item.registered).map(item => item.name);
  const waiting = experts.filter(item => !item.host && !item.spoken && item.registered).map(item => item.name);
  const latest_visible = await database.prepare(`SELECT COALESCE(MAX(m.id),0) AS id FROM messages m WHERE m.room_id=?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)`).bind(room_id).first();
  const revision = (await digest_hex(JSON.stringify([session.id, session.status, session.state_revision, session.phase,
    session.held_since, session.read_until, latest_visible.id, requests, experts]))).slice(0, 16);
  return { session_id: session.id, round, experts, waiting, unregistered, revision };
}

async function require_session_host(database, room_id, payload, token) {
  const member = await require_free_member(database, room_id, token);
  if (member.role !== "host" || ![member.name, "用户"].includes(payload.actor)) throw new HttpError(403, "討論安排須使用當前主持人成員憑證");
  return member;
}

async function session_turns(database, room_id, params) {
  const session = await database.prepare("SELECT id FROM discussion_sessions WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first();
  if (!session) return { turns: [], page: Math.max(1, integer(params.page ?? 1)), total: 0, pages: 1 };
  const page = Math.max(1, integer(params.page ?? 1));
  const where = ["session_id=?", "purpose='discuss'"];
  const values = [session.id];
  if (params.submission_id !== undefined) { where.push("submission_id=?"); values.push(submission_value(params.submission_id)); }
  const result = await database.batch([
    database.prepare(`SELECT COUNT(*) AS total FROM session_requests WHERE ${where.join(" AND ")}`).bind(...values),
    database.prepare(`SELECT q.*,m.name AS expert FROM session_requests q JOIN room_members m ON m.id=q.member_id
      WHERE ${where.join(" AND ")} ORDER BY q.round,q.position,q.id LIMIT ? OFFSET ?`).bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = result[0].results[0].total;
  return { turns: result[1].results, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

async function cancel_session_plan(database, room_id, plan_id, payload, token) {
  const room = await require_room(database, room_id);
  const owner_hash = await runtime_hash(token);
  const is_owner = owner_hash && await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?")
    .bind(room_id, owner_hash).first();
  const host = is_owner ? null : await require_free_member(database, room_id, token);
  if (host && (host.role !== "host" || ![host.name, "用户"].includes(payload.actor))) {
    throw new HttpError(403, "只有房主或当前主持人可以取消安排");
  }
  const plan = await database.prepare("SELECT * FROM session_requests WHERE id=? AND purpose='discuss' AND session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)")
    .bind(integer(plan_id), room_id).first();
  if (!plan) throw new HttpError(404, "讨论安排不存在");
  if (!["open", "queued"].includes(plan.status)) throw new HttpError(409, "讨论安排已结束");
  const actor_guard = is_owner
    ? { sql: "EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)", values: [room_id, owner_hash] }
    : { sql: "EXISTS(SELECT 1 FROM room_members WHERE id=? AND room_id=? AND token_hash=? AND status='active' AND role='host')",
      values: [host.id, room_id, host.token_hash] };
  await checked_batch(database, `EXISTS(SELECT 1 FROM session_requests WHERE id=? AND purpose='discuss' AND status IN ('open','queued')
      AND session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)) AND ${actor_guard.sql}`,
  [plan.id, room_id, ...actor_guard.values], [
    database.prepare("UPDATE session_requests SET status='cancelled' WHERE id=?").bind(plan.id),
    database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT ?, 'user_stop' WHERE EXISTS(SELECT 1 FROM member_requests WHERE id=? AND status IN ('pending','delivering'))")
      .bind(plan.member_request_id, plan.member_request_id),
    database.prepare("UPDATE member_requests SET status='cancelled' WHERE id=? AND status IN ('pending','delivering')").bind(plan.member_request_id),
    database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='discussion_plan_cancelled'
      WHERE id IN (SELECT execution_id FROM member_requests WHERE id=?) AND status IN ('dispatched','started')`).bind(plan.member_request_id),
    database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(plan.session_id),
  ]);
  return { ...plan, status: "cancelled" };
}

async function create_session_plan(database, room_id, payload, token) {
  const session = await latest_session(database, room_id);
  if (!session || session.status !== "active") throw new HttpError(409, "讨论未处于进行状态");
  const room = await require_room(database, room_id);
  const host_member = await require_session_host(database, room_id, payload, token);
  const roster = await session_roster(database, room_id);
  const raw = payload.turns ?? [{ expert: payload.expert, question: payload.question }];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PLAN_TURNS) throw new HttpError(400, `整轮安排需要 1–${MAX_PLAN_TURNS} 项`);
  const submission = submission_value(payload.submission_id);
  const plan = raw.map((item, index) => {
    const values = message_values({ author: item?.expert, text: item?.question, submission_id: submission });
    const member = roster.experts.find(entry => entry.name === values.author);
    if (!member || !member.registered || text_length(values.text) > MAX_QUESTION_LENGTH) throw new HttpError(400, "请选择已注册的参与专家，待回应问题最多 1000 字");
    return { ...values, member_id: member.id, submission_id: index ? `${submission}-q${index + 1}` : submission };
  });
  if (raw.length > 1) {
    const missing = roster.waiting.filter(name => !plan.some(item => item.author === name));
    if (missing.length) throw new HttpError(400, `整轮安排缺少本轮待发言专家：${missing.join("、")}`);
  }
  const existing = await Promise.all(plan.map(item => database.prepare("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?")
    .bind(session.id, item.submission_id).first()));
  if (existing.some((row, index) => !row || row.member_id !== plan[index].member_id || row.question !== plan[index].text)) {
    if (existing.some(Boolean)) throw new HttpError(409, "该安排编号已用于不同成员或问题");
  } else if (existing.every(Boolean)) return { turn: existing[0], queued: existing.slice(1), duplicate: true };
  if (existing.some(Boolean)) throw new HttpError(409, "整轮安排编号已部分存在，需使用新 submission_id");
  if (payload.roster === undefined || payload.roster === null) throw new HttpError(400, "安排前须先读取 turns/roster 并提交 revision");
  if (payload.roster !== roster.revision) throw new HttpError(409, "专家或队列状态已变化，请重新读取 turns/roster");
  const last_round = await database.prepare("SELECT COALESCE(MAX(round),0) AS round FROM session_requests WHERE session_id=? AND purpose='discuss'").bind(session.id).first();
  const prior_round = await database.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=?").bind(session.id, last_round.round).first();
  let current_round = Math.max(1, last_round.round + (last_round.round > 0 && prior_round.count > 0 && roster.waiting.length === 0 ? 1 : 0));
  const spoken = new Set(current_round > last_round.round ? [] : roster.experts.filter(item => item.spoken).map(item => item.name));
  let position = 0;
  for (const item of plan) {
    if (spoken.has(item.author)) { current_round += 1; spoken.clear(); position = 0; }
    item.round = current_round;
    item.position = position++;
    spoken.add(item.author);
  }
  const now = new Date().toISOString();
  const task_submission = `session-task-${session.id}-plan-${submission}`;
  const host_work = (await database.prepare(`SELECT DISTINCT r.id AS request_id,r.execution_id,r.status AS request_status,e.status AS execution_status
    FROM session_requests q JOIN member_requests r ON r.id=q.member_request_id
    LEFT JOIN member_executions e ON e.id=r.execution_id WHERE q.session_id=? AND q.purpose='discuss_host' AND q.member_id=?
      AND q.status='open' AND r.status IN ('pending','delivering')`).bind(session.id, host_member.id).all()).results;
  const host_executions = [...new Set(host_work.filter(row => row.request_status === 'delivering'
    && ['dispatched', 'started'].includes(row.execution_status)).map(row => row.execution_id))];
  const completed_host_work = host_executions.length
    ? host_work.filter(row => host_executions.includes(row.execution_id))
    : host_work.filter(row => row.request_status === 'pending');
  const completed_host_ids = [...new Set(completed_host_work.map(row => row.request_id))];
  const statements = plan.map((item, index) => database.prepare(`INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
    VALUES(?,?,?,?, 'discuss',?,?,?, ?,?)`).bind(session.id, item.round, item.position, item.member_id, item.text,
    index === 0 ? "open" : "queued", item.submission_id,
    session.phase === "initial" && item.round === roster.round ? session.read_until : null, now));
  statements.push(
    database.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
      SELECT ?, '系统任务', ?, 'system', ?, ? WHERE EXISTS(SELECT 1 FROM session_requests WHERE session_id=? AND submission_id=?)`)
      .bind(room_id, plan[0].text, task_submission, now, session.id, plan[0].submission_id),
    database.prepare(`INSERT INTO member_requests(room_id,member_id,message_id,status,created_at,purpose,created_by)
      SELECT ?,?,id,'pending',unixepoch(),'discuss','host' FROM messages WHERE room_id=? AND submission_id=?`)
      .bind(room_id, plan[0].member_id, room_id, task_submission),
    database.prepare(`UPDATE session_requests SET member_request_id=(SELECT id FROM member_requests WHERE room_id=?
      AND message_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)) WHERE session_id=? AND submission_id=?`)
      .bind(room_id, room_id, task_submission, session.id, plan[0].submission_id),
    database.prepare(`INSERT INTO task_message_sources(message_id,session_id,session_request_id,cause_kind)
      SELECT m.id,q.session_id,q.id,'scheduled_speaker' FROM messages m JOIN session_requests q ON q.session_id=? AND q.submission_id=?
      WHERE m.room_id=? AND m.submission_id=?`).bind(session.id, plan[0].submission_id, room_id, task_submission),
    ...(completed_host_ids.length ? [
      database.prepare("UPDATE member_requests SET status='completed' WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('pending','delivering')")
        .bind(JSON.stringify(completed_host_ids)),
      ...(host_executions.length ? [database.prepare("UPDATE member_executions SET status='completed',finished_at=unixepoch(),result='plan:'||? WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('dispatched','started')")
        .bind(submission, JSON.stringify(host_executions))] : []),
      database.prepare("UPDATE session_requests SET status='answered' WHERE member_request_id IN (SELECT value FROM json_each(?)) AND status='open'")
        .bind(JSON.stringify(completed_host_ids)),
    ] : []),
  );
  const expected_active = room.members.filter(member => member.status === "active").length;
  try {
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      WHERE s.id=? AND s.status='active' AND st.revision=?)
      AND (SELECT COUNT(*) FROM room_members WHERE room_id=? AND status='active')=?
      AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND token_hash=? AND role='host' AND status='active')
      AND NOT EXISTS(SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='open')
      AND NOT EXISTS(SELECT 1 FROM messages WHERE room_id=? AND submission_id=?)`,
      [session.id, session.state_revision, room_id, expected_active, host_member.id, host_member.token_hash, session.id, room_id, task_submission], statements);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "讨论、成员或队列状态已变化，请重新读取后安排");
    throw error;
  }
  const rows = await Promise.all(plan.map(item => database.prepare("SELECT * FROM session_requests WHERE session_id=? AND submission_id=?")
    .bind(session.id, item.submission_id).first()));
  const first = rows[0];
  return { turn: first, queued: rows.slice(1), duplicate: false };
}

async function issue_session_plan(database, session, plan, cause_request_id = null) {
  const member = await database.prepare("SELECT name,status FROM room_members WHERE id=?").bind(plan.member_id).first();
  if (!member || member.status !== "active") {
    await checked_batch(database, `EXISTS(SELECT 1 FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id
      WHERE q.id=? AND q.session_id=? AND q.status='queued' AND s.status='active')
      AND NOT EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active')`, [plan.id, session.id, plan.member_id], [
      database.prepare("UPDATE session_requests SET status='skipped' WHERE id=? AND status='queued'").bind(plan.id),
      database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
    ]);
    return null;
  }
  const req = await add_task_request(database, { id: session.id, room_id: session.room_id, request_id: plan.id }, plan.member_id,
    "discuss", `session-task-${session.id}-plan-${plan.id}`, plan.question, "scheduled_speaker", null, cause_request_id);
  return { ...plan, status: "open", member_request_id: req.request_id, expert: member.name };
}

async function finish_session_if_limited(database, session, room_id) {
  const status = await database.prepare(`SELECT s.status,st.phase,st.revision AS state_revision,l.revision AS limits_revision,l.max_rounds,l.max_minutes,l.started_at,
    p.paused_seconds+CASE WHEN p.paused_at>0 THEN MAX(0,unixepoch()-p.paused_at) ELSE 0 END AS idle,
    (SELECT COUNT(*) FROM session_requests q WHERE q.session_id=s.id AND q.purpose='discuss' AND q.status='answered') AS answered
    FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id JOIN session_limits l ON l.session_id=s.id
    JOIN session_pauses p ON p.session_id=s.id WHERE s.id=?`).bind(session.id).first();
  if (!status || status.status !== "active") return false;
  const room = await require_room(database, room_id);
  const denominator = room.members.filter(member => member.status === "active" && member.role !== "host" && member.name in room.experts
    && (member.access !== "manual" || member.registered_at || member.manual_source === "web")).length;
  const round_counts = (await database.prepare(`SELECT q.round,SUM(CASE WHEN q.status='answered' THEN 1 ELSE 0 END) AS answered,
      MAX(CASE WHEN m.role='host' THEN 1 ELSE 0 END) AS host_scheduled
    FROM session_requests q JOIN room_members m ON m.id=q.member_id WHERE q.session_id=? AND q.purpose='discuss'
    GROUP BY q.round`).bind(session.id).all()).results;
  const round_score = round_counts.reduce((score, round) => {
    const divisor = denominator + round.host_scheduled;
    return score + (divisor > 0 ? round.answered / divisor : 0);
  }, 0);
  const completed_rounds = Math.floor(round_score + Number.EPSILON);
  const reached_rounds = status.max_rounds > 0 && completed_rounds >= status.max_rounds;
  const reached_time = status.max_minutes > 0 && status.started_at > 0 && Math.floor(Date.now() / 1000) - status.started_at - status.idle >= status.max_minutes * 60;
  if (!reached_rounds && !reached_time) return false;
  const reason = reached_time ? "time_limit" : "round_limit";
  const latest = (await database.prepare(`SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE room_id=?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE message_id=messages.id)`).bind(room_id).first()).id;
  const state = await database.prepare("SELECT state_text,state_until FROM rooms WHERE id=?").bind(room_id).first();
  const brief = await database.prepare("SELECT text,until FROM room_briefs WHERE room_id=?").bind(room_id).first();
  const concluded_at = new Date().toISOString();
  const statements = [
    database.prepare(`INSERT OR REPLACE INTO discussion_conclusions(session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(session.id, room_id, reason, status.max_rounds, status.max_minutes,
        brief && brief.until > session.started_message_id ? brief.text : "",
        state.state_until > session.started_message_id ? state.state_text : "",
        state.state_until > session.started_message_id ? state.state_until : 0, concluded_at),
    database.prepare("UPDATE discussion_sessions SET status='concluded',ended_message_id=? WHERE id=?").bind(latest, session.id),
    database.prepare("UPDATE session_limits SET stop_reason=?,revision=revision+1 WHERE session_id=?").bind(reason, session.id),
    database.prepare("UPDATE session_requests SET status='cancelled' WHERE session_id=? AND status IN ('open','queued')").bind(session.id),
    database.prepare(`INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'user_stop' FROM member_requests
      WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')`).bind(session.id),
    database.prepare("UPDATE member_requests SET status='cancelled' WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')").bind(session.id),
    database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='discussion_limit_reached'
      WHERE id IN (SELECT execution_id FROM member_requests WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled'))
      AND status IN ('dispatched','started')`).bind(session.id),
    database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
  ];
  try {
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      JOIN session_limits l ON l.session_id=s.id WHERE s.id=? AND s.status='active' AND st.revision=? AND l.revision=?
      AND (SELECT COUNT(*) FROM session_requests q WHERE q.session_id=s.id AND q.purpose='discuss' AND q.status='answered')=?)`,
      [session.id, status.state_revision, status.limits_revision, status.answered], statements);
  } catch (error) {
    if (error instanceof HttpError && error.status === 403) return false;
    throw error;
  }
  return true;
}

async function advance_session_answer(database, room_id, message_id) {
  const completed = (await database.prepare(`SELECT r.id AS member_request_id,r.purpose,q.id AS plan_id,q.session_id,q.status AS plan_status,
    q.round,q.member_id,q.question,q.submission_id FROM member_requests r JOIN session_requests q ON q.member_request_id=r.id
    WHERE r.room_id=? AND r.answer_id=? AND r.status='completed' AND r.purpose='discuss' AND q.status='answered'`).bind(room_id, message_id).all()).results;
  for (const request of completed) {
    const session = await latest_session(database, room_id);
    if (!session || session.id !== request.session_id) continue;
    if (await finish_session_if_limited(database, session, room_id)) {
      await release_session_messages(database, room_id, session);
      continue;
    }
    let next = await database.prepare("SELECT * FROM session_requests WHERE session_id=? AND status='queued' ORDER BY round,position,id LIMIT 1")
      .bind(session.id).first();
    while (next) {
      if (await issue_session_plan(database, session, next, request.member_request_id)) break;
      next = await database.prepare("SELECT * FROM session_requests WHERE session_id=? AND status='queued' ORDER BY round,position,id LIMIT 1")
        .bind(session.id).first();
    }
    if (next) continue;
    const roster = await session_roster(database, room_id);
    if (session.phase === "initial" && roster.waiting.length === 0) {
      try {
        await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
          WHERE s.id=? AND s.status='active' AND st.phase='initial' AND st.revision=?)`,
          [session.id, session.state_revision], [database.prepare("UPDATE session_state SET phase='discussing',revision=revision+1 WHERE session_id=? AND phase='initial'").bind(session.id)]);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 403)) throw error;
      }
    }
    const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
    if (host) await create_session_task(database, session.id, host.id, "discuss_host", "本次安排已完成。读取最新讨论状态和余下专家，继续安排下一位或收束。",
      "round_complete", null, request.member_request_id);
  }
}

async function reconcile_failed_session_requests(database, room_id) {
  const session = await latest_session(database, room_id);
  if (!session || session.status !== "active") return;
  const failures = (await database.prepare(`SELECT q.id AS plan_id,q.member_id,q.member_request_id,m.name,r.execution_id,e.result
    FROM session_requests q JOIN member_requests r ON r.id=q.member_request_id JOIN room_members m ON m.id=q.member_id
    LEFT JOIN member_executions e ON e.id=r.execution_id
    WHERE q.session_id=? AND q.purpose='discuss' AND q.status='open' AND r.status='failed' ORDER BY q.id`).bind(session.id).all()).results;
  if (!failures.length) return;
  const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
  if (!host) return;
  for (const failure of failures) {
    const why = String(failure.result || "送达重试已用尽").slice(0, 400);
    await create_session_task(database, session.id, host.id, "discuss_host",
      `${failure.name} 的讨论发言送达失败（请求 ${failure.member_request_id}）：${why}。请决定跳过或重新安排。`,
      "request_failed", null, failure.member_request_id);
    await checked_batch(database, `EXISTS(SELECT 1 FROM session_requests q JOIN member_requests r ON r.id=q.member_request_id
      WHERE q.id=? AND q.status='open' AND r.status='failed')`, [failure.plan_id], [
      database.prepare("UPDATE session_requests SET status='failed' WHERE id=? AND status='open'").bind(failure.plan_id),
      database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
    ]);
  }
}

async function release_session_messages(database, room_id, session) {
  if (!session.held_since) return;
  const held = (await database.prepare(`SELECT m.id,m.text FROM messages m WHERE m.room_id=? AND m.author='用户' AND m.id>=?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id) ORDER BY m.id`).bind(room_id, session.held_since).all()).results;
  const statements = [];
  for (const message of held) {
    const recipients = await free_recipients(database, room_id, { author: "用户", text: message.text });
    statements.push(...recipients.map(recipient => database.prepare(`INSERT OR IGNORE INTO member_requests
      (room_id,member_id,message_id,chain_id,purpose,created_by,created_at) VALUES (?,?,?,?,?,'user',unixepoch())`)
      .bind(room_id, recipient.id, message.id, message.id, recipient.purpose)));
  }
  await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    WHERE s.id=? AND s.status='concluded' AND st.held_since=? AND st.revision=?)`,
    [session.id, session.held_since, session.state_revision], statements);
}

async function continue_session_plan(database, room_id, payload, token) {
  const session = await latest_session(database, room_id);
  if (!session || session.status !== "active") throw new HttpError(409, "讨论未处于进行状态");
  const room = await require_room(database, room_id);
  const host = await require_session_host(database, room_id, payload, token);
  const roster = await session_roster(database, room_id);
  if (payload.revision === undefined || payload.revision === null) throw new HttpError(400, "继续安排前须先读取 turns/roster 并提交 revision");
  if (payload.revision !== roster.revision) throw new HttpError(409, "专家或队列状态已变化，请重新读取 turns/roster");
  const next = await database.prepare("SELECT * FROM session_requests WHERE session_id=? AND status='queued' ORDER BY round,position,id LIMIT 1").bind(session.id).first();
  if (!next) return { turn: null, queued: [] };
  const member = await database.prepare("SELECT name,status FROM room_members WHERE id=?").bind(next.member_id).first();
  if (!member || member.status !== "active") throw new HttpError(409, "排队成员已不可用，请重新安排");
  const req = await add_task_request(database, { id: session.id, room_id, request_id: next.id }, next.member_id,
    "discuss", `session-task-${session.id}-plan-${next.id}`, next.question, "scheduled_speaker", null, null,
    { host_id: host.id, token_hash: host.token_hash, state_revision: session.state_revision,
      active_count: room.members.filter(item => item.status === "active").length });
  return { turn: { ...next, status: "open", member_request_id: req.request_id, expert: member.name }, queued: [] };
}

async function discussion_control(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const owner_hash = await runtime_hash(token);
  const action = payload.action;
  if (!["start", "pause", "resume", "end"].includes(action)) throw new HttpError(400, "action 须为 start、pause、resume 或 end");
  let request_json = "";
  if (action === "start") {
    if (payload.submission_id !== undefined && (typeof payload.submission_id !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(payload.submission_id))) {
      throw new HttpError(400, "submission_id 须为 8–100 位字母、数字、下划线或短横线");
    }
    if (payload.submission_id) {
      request_json = start_request_json(payload);
      const duplicate = await start_submission_result(database, room_id, payload.submission_id, request_json);
      if (duplicate) return duplicate;
    }
  }
  await require_session_revision(database, room_id, payload);
  const room = await require_room(database, room_id);
  const now = Math.floor(Date.now() / 1000);
  if (action === "start") {
    if (room.mode !== "free" || room.archived) throw new HttpError(409, "房间当前不能开启讨论");
    const host = await database.prepare("SELECT id,name,access FROM room_members WHERE room_id=? AND role='host' AND status='active' ORDER BY id LIMIT 1").bind(room_id).first();
    if (!host || host.access !== "runner") throw new HttpError(400, "开启讨论需要一位由本机托管的 AI 主持人");
    const limits = limit_values(payload.limits ?? {}, LIMIT_DEFAULTS);
    const goal = String(payload.goal ?? room.goal).trim();
    if (!goal || text_length(goal) > 1000) throw new HttpError(400, "讨论目标不能为空且最多 1000 字");
    if (payload.named_followup !== undefined && typeof payload.named_followup !== "boolean") throw new HttpError(400, "named_followup 须为布尔值");
    const base = room.opinion_count ?? await opinion_count(database, room_id, room.experts);
    const created_at = new Date().toISOString();
    const task_submission = `session-task-${room_id}-start-${crypto.randomUUID()}`;
    const statements = [
      database.prepare(`INSERT INTO discussion_sessions(room_id,goal,status,started_message_id,created_at) VALUES(?,?,'active',?,?)`)
        .bind(room_id, goal, room.latest_id, created_at),
      database.prepare(`INSERT INTO session_state(session_id,phase,revision,read_until,held_since)
        SELECT id,'initial',1,?,0 FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`).bind(room.latest_id, room_id),
      database.prepare(`INSERT INTO session_limits(session_id,max_rounds,max_minutes,execution_minutes,started_at,revision)
        SELECT id,?,?,?,?,1 FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`)
        .bind(limits.max_rounds, limits.max_minutes, limits.execution_minutes, now, room_id),
      database.prepare(`INSERT INTO session_round_budgets(session_id,base,cap,extra)
        SELECT id,?,0,0 FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`).bind(base, room_id),
      database.prepare(`INSERT INTO session_pauses(session_id,paused_at,paused_seconds)
        SELECT id,0,0 FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`).bind(room_id),
      database.prepare(`INSERT INTO session_options(session_id,named_followup)
        SELECT id,? FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`).bind(Number(Boolean(payload.named_followup)), room_id),
      database.prepare("UPDATE rooms SET goal=? WHERE id=?").bind(goal, room_id),
      database.prepare(`INSERT INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
        SELECT id,0,0,?,'discuss_host','讨论已开启。读取房间状态和消息，决定并安排首轮发言。','open',?,NULL,?
        FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`).bind(host.id, task_submission, created_at, room_id),
      database.prepare(`INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
        SELECT ?, '系统任务','讨论已开启。读取房间状态和消息，决定并安排首轮发言。','system',?,?
        WHERE EXISTS(SELECT 1 FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id WHERE s.room_id=? AND q.submission_id=?)`)
        .bind(room_id, task_submission, created_at, room_id, task_submission),
      database.prepare(`INSERT INTO member_requests(room_id,member_id,message_id,status,created_at,purpose,created_by)
        SELECT ?,?,id,'pending',unixepoch(),'discuss_host','host' FROM messages WHERE room_id=? AND submission_id=?`)
        .bind(room_id, host.id, room_id, task_submission),
      database.prepare(`UPDATE session_requests SET member_request_id=(SELECT id FROM member_requests WHERE room_id=? AND message_id=
        (SELECT id FROM messages WHERE room_id=? AND submission_id=?)) WHERE submission_id=?`)
        .bind(room_id, room_id, task_submission, task_submission),
      database.prepare(`INSERT INTO task_message_sources(message_id,session_id,session_request_id,cause_kind)
        SELECT m.id,q.session_id,q.id,'session_started' FROM messages m JOIN session_requests q ON q.submission_id=?
        WHERE m.room_id=? AND m.submission_id=?`).bind(task_submission, room_id, task_submission),
      ...(payload.submission_id ? [database.prepare(`INSERT INTO session_start_submissions(room_id,submission_id,session_id,request_json)
        SELECT ?,?,id,? FROM discussion_sessions WHERE room_id=? AND status='active' ORDER BY id DESC LIMIT 1`)
        .bind(room_id, payload.submission_id, request_json, room_id)] : []),
    ];
    try {
      await checked_batch(database, `NOT EXISTS(SELECT 1 FROM discussion_sessions WHERE room_id=? AND status IN ('active','paused'))
        AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND COALESCE((SELECT archived FROM room_directory WHERE room_id=?),0)=0
          AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=? AND NOT EXISTS
            (SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)),0)=?)
        AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND room_id=? AND role='host' AND status='active' AND access='runner')`,
        [room_id, room_id, room_id, room_id, room.latest_id, host.id, room_id], statements);
    } catch (error) {
      if (payload.submission_id) {
        const duplicate = await start_submission_result(database, room_id, payload.submission_id, request_json);
        if (duplicate) return duplicate;
      }
      if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "房间状态已变化，请重新读取后开启讨论");
      throw error;
    }
    return { ...(await session_view(database, room_id)), duplicate: false };
  }
  const session = await latest_session(database, room_id);
  if (!session) throw new HttpError(409, "房间没有进行中的讨论");
  if (action === "pause") {
    if (session.status === "paused") return session_view(database, room_id);
    const statements = [
      database.prepare("UPDATE discussion_sessions SET status='paused' WHERE id=?").bind(session.id),
      database.prepare("UPDATE session_pauses SET paused_at=? WHERE session_id=?").bind(now, session.id),
      database.prepare("UPDATE session_requests SET status='cancelled' WHERE session_id=? AND status IN ('open','queued')").bind(session.id),
      database.prepare(`INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'user_stop' FROM member_requests
        WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')`).bind(session.id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')").bind(session.id),
      database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='discussion_paused'
        WHERE id IN (SELECT execution_id FROM member_requests WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled'))
        AND status IN ('dispatched','started')`).bind(session.id),
      database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
    ];
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      WHERE s.id=? AND s.status='active' AND st.revision=?) AND EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)`,
      [session.id, session.state_revision, room_id, owner_hash], statements).catch(error => {
        if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "讨论状态已变化，请重新读取");
        throw error;
      });
  } else if (action === "resume") {
    if (session.status !== "paused") throw new HttpError(409, "讨论未暂停");
    const statements = [
      database.prepare("UPDATE discussion_sessions SET status='active' WHERE id=?").bind(session.id),
      database.prepare("UPDATE session_pauses SET paused_seconds=paused_seconds+MAX(0,?-paused_at),paused_at=0 WHERE session_id=?").bind(now, session.id),
      database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
    ];
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      WHERE s.id=? AND s.status='paused' AND st.revision=?) AND EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)`,
      [session.id, session.state_revision, room_id, owner_hash], statements).catch(error => {
        if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "讨论状态已变化，请重新读取");
        throw error;
      });
    const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
    if (host) await create_session_task(database, session.id, host.id, "discuss_host", "讨论已恢复。读取最新状态并继续安排。", "member_change");
  } else {
    const statements = [
      database.prepare(`INSERT OR REPLACE INTO discussion_conclusions(session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
        SELECT s.id,s.room_id,'user_stop',l.max_rounds,l.max_minutes,
          CASE WHEN b.until>s.started_message_id THEN b.text ELSE '' END,
          CASE WHEN r.state_until>s.started_message_id THEN r.state_text ELSE '' END,
          CASE WHEN r.state_until>s.started_message_id THEN r.state_until ELSE 0 END,?
        FROM discussion_sessions s JOIN session_limits l ON l.session_id=s.id JOIN rooms r ON r.id=s.room_id
        LEFT JOIN room_briefs b ON b.room_id=s.room_id WHERE s.id=?`).bind(new Date().toISOString(), session.id),
      database.prepare(`UPDATE discussion_sessions SET status='concluded',ended_message_id=(SELECT COALESCE(MAX(id),0) FROM messages m
        WHERE m.room_id=? AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)) WHERE id=?`).bind(room_id, session.id),
      database.prepare("UPDATE session_limits SET stop_reason='user_stop',revision=revision+1 WHERE session_id=?").bind(session.id),
      database.prepare("UPDATE session_requests SET status='cancelled' WHERE session_id=? AND status IN ('open','queued')").bind(session.id),
      database.prepare(`INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'user_stop' FROM member_requests
        WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')`).bind(session.id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled') AND status IN ('pending','delivering')").bind(session.id),
      database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='discussion_ended'
        WHERE id IN (SELECT execution_id FROM member_requests WHERE id IN (SELECT member_request_id FROM session_requests WHERE session_id=? AND status='cancelled'))
        AND status IN ('dispatched','started')`).bind(session.id),
      database.prepare("UPDATE session_state SET revision=revision+1 WHERE session_id=?").bind(session.id),
    ];
    await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
      WHERE s.id=? AND s.status=? AND st.revision=?) AND EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)`,
      [session.id, session.status, session.state_revision, room_id, owner_hash], statements).catch(error => {
        if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "讨论状态已变化，请重新读取");
        throw error;
      });
    await release_session_messages(database, room_id, session);
  }
  return session_view(database, room_id);
}

/** End the discussion in place: stop its run and turns and switch back to free collaboration. */
function return_to_free_statements(database, room_id) {
  return [
    database.prepare(`UPDATE discussion_runtime SET status='stopped',generation=generation+1,revision=revision+1
      WHERE room_id=? AND status IN ('running','ready','paused')`).bind(room_id),
    database.prepare("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND status IN ('pending','notified')").bind(room_id),
    database.prepare("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND status='queued'").bind(room_id),
    database.prepare("UPDATE topic_settings SET phase='concluded' WHERE room_id=?").bind(room_id),
    database.prepare("UPDATE room_modes SET mode='free' WHERE room_id=?").bind(room_id),
    database.prepare("UPDATE turn_relay SET held_since=0 WHERE room_id=?").bind(room_id),
  ];
}

/** The user's messages a discussion's host never answered: held, after the host's last message and not asked of anyone. */
async function held_user_messages(database, room) {
  const { results } = await database.prepare(`SELECT m.id FROM messages m JOIN turn_relay t ON t.room_id=m.room_id AND t.held_since>0
    WHERE m.room_id=? AND m.author='用户' AND m.id>=t.held_since
    AND m.id>COALESCE((SELECT MAX(id) FROM messages WHERE room_id=? AND author=?),0)
    AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=m.id) ORDER BY m.id`).bind(room.id, room.id, room.host).all();
  return results.map(row => row.id);
}

/** Once the room is free again, hand the held messages to the free room's recipients, as if just sent. */
async function route_held_messages(database, room_id, message_ids) {
  if (!message_ids.length) return;
  const recipients = await free_recipients(database, room_id, {});
  const statements = message_ids.flatMap(message_id => recipients.map(recipient => database.prepare(`INSERT OR IGNORE INTO member_requests
    (room_id,member_id,message_id,chain_id,purpose,created_by,created_at) VALUES (?,?,?,?,?,'user',unixepoch())`)
    .bind(room_id, recipient.id, message_id, message_id, recipient.purpose)));
  if (statements.length) await database.batch(statements);
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
  if (!["free", "brainstorm", undefined].includes(payload.mode)) throw new HttpError(400, "房间模式须为 free 或 brainstorm");
  const free = true;
  const members = await free_member_values(payload.members);
  payload = { ...payload, mode: "free", phase: "discussing", experts: Object.fromEntries(members.map(member => [member.name, member.manual_source === "web" ? "online" : "cli"])) };
  const settings = topic_values(payload);
  const automatic = payload.runtime_mode === "automatic";
  const hashed = await runtime_hash(control_token);
  if (!["manual", "automatic"].includes(payload.runtime_mode ?? "manual") || !hashed) throw new HttpError(400, "建房须提供有效的运行模式和房主控制凭据");
  if (members.some(member => member.token_hash === hashed)) throw new HttpError(400, "成员凭证不能与房主控制凭据相同");
  if (free && (automatic || !hashed)) throw new HttpError(400, "自由房间须提供房间控制凭据，且不使用讨论运行模式");
  const named_followup = payload.named_followup ?? false;
  if (typeof named_followup !== "boolean") throw new HttpError(400, "named_followup 须为布尔值");
  const parent_id = payload.parent_room_id ?? null;
  if (parent_id !== null && (free || typeof parent_id !== "string" || await room_mode(database, parent_id) !== "free")) {
    throw new HttpError(400, "只有从自由协作房间发起的讨论房间可以关联来源房间");
  }
  const identifier = Object.hasOwn(payload, "submission_id") ? submission_value(payload.submission_id) : null;
  const folder_id = payload.folder_id ?? null;
  if (folder_id !== null && typeof folder_id !== "string") throw new HttpError(400, "文件夹编号必须是文本或 null");
  const request_text = creation_request(settings) + (automatic ? ":automatic" : "")
    + `:access:${hashed}:${JSON.stringify(members.map(member => [member.name, member.adapter, member.access, member.manual_source, member.session_mode, member.token_hash]))}`
    + (free ? ":free" : named_followup ? ":named_followup" : "")
    + (parent_id === null ? "" : `:parent:${parent_id}`)
    + (folder_id === null ? "" : `:folder:${JSON.stringify(folder_id)}`);
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
  statements.push(database.prepare("INSERT INTO room_modes (room_id,mode,control_hash) VALUES (?,?,?)").bind(room_id, free ? "free" : "brainstorm", hashed),
    ...members.flatMap(member => free_member_statements(database, room_id, member)),
    database.prepare("UPDATE room_members SET role='host' WHERE room_id=? AND name=?").bind(room_id, settings.host),
    ...(free ? free_participant_statements(database, room_id)
      : [database.prepare("INSERT INTO discussion_options (room_id,named_followup) VALUES (?,?)").bind(room_id, Number(named_followup)),
        database.prepare("INSERT INTO round_budgets (room_id) VALUES (?)").bind(room_id)]));
  if (parent_id !== null) statements.push(database.prepare("INSERT INTO room_links (room_id,parent_id,created_at) VALUES (?,?,?)").bind(room_id, parent_id, new Date().toISOString()));
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
/**
 * The site revision and each named room's revision, so an idle room is read in full only after it changed; mirrors
 * backend/server.py. A room that does not exist is left out.
 */
async function room_revisions(database, params) {
  const ids = String(params.rooms ?? "").split(",").filter(Boolean).slice(0, MAX_REVISION_ROOMS);
  const site = (await database.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM room_revisions").first()).revision;
  const rows = ids.length ? (await database.prepare(`SELECT rooms.id,COALESCE(room_revisions.revision,0) AS revision FROM rooms
    LEFT JOIN room_revisions ON room_revisions.room_id=rooms.id WHERE rooms.id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all()).results : [];
  return { site, rooms: Object.fromEntries(rows.map(row => [row.id, row.revision])) };
}

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
  // Deleting checks only the title and host; the full room view alone can use up the Worker's CPU limit.
  const room = action === "delete" ? await database.prepare(`SELECT rooms.title, COALESCE(topic_settings.host,'用户') AS host FROM rooms
    LEFT JOIN topic_settings ON topic_settings.room_id=rooms.id WHERE rooms.id=?`).bind(room_id).first() : await require_room(database, room_id);
  if (!room) throw new HttpError(404, "房间不存在");
  require_host(room, payload);
  const statements = [];
  if (action === "move") {
    const rooms = (await query_rooms(database, {})).rooms.map((item) => item.id).filter((id) => id !== room_id);
    const before = payload.before_id ?? null;
    if (before !== null && !rooms.includes(before)) throw new HttpError(400, "目标房间不存在或与当前房间相同");
    rooms.splice(before ? rooms.indexOf(before) : rooms.length, 0, room_id);
    statements.push(...rooms.map((id, index) => database.prepare("UPDATE room_directory SET position=? WHERE room_id=?").bind(index + 1, id)));
  } else if (action === "folder") {
    const folder_id = payload.folder_id ?? null;
    if (folder_id !== null && (typeof folder_id !== "string" || !(await database.prepare("SELECT 1 FROM topic_folders WHERE id=?").bind(folder_id).first()))) {
      throw new HttpError(400, "文件夹不存在");
    }
    statements.push(database.prepare("UPDATE room_folder_assignments SET folder_id=? WHERE room_id=?").bind(folder_id, room_id));
  } else if (action === "rename") {
    // The title is display-only, so renaming never touches phase, turns or members.
    const title = String(payload.title ?? "").trim();
    if (!title || text_length(title) > 80) throw new HttpError(400, "title 内容为空或超过 80 字");
    statements.push(database.prepare("UPDATE rooms SET title=? WHERE id=?").bind(title, room_id));
  } else if (["archive", "restore"].includes(action)) {
    if (action === "archive" && room.phase !== "concluded") statements.push(...topic_statements(database, room_id, { ...room, phase: "paused" }));
    // An archived room is read-only: nothing it still owes may be delivered or answered later.
    if (action === "archive" && room.mode === "free") statements.push(...free_stop_room_statements(database, room_id, "房间已归档", "archived"));
    statements.push(database.prepare("UPDATE room_directory SET archived=? WHERE room_id=?").bind(Number(action === "archive"), room_id));
  } else if (action === "delete") {
    if (payload.confirm_title !== room.title) throw new HttpError(400, "请输入完整房间名称确认删除");
    const queries = [
      "DELETE FROM task_message_sources WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)",
      "DELETE FROM session_requests WHERE session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)",
      "DELETE FROM discussion_sessions WHERE room_id=?",
      "DELETE FROM member_recommendations WHERE room_id=?", "DELETE FROM free_queue WHERE room_id=?", "DELETE FROM speaking_orders WHERE room_id=?", "DELETE FROM member_requests WHERE room_id=?", "DELETE FROM member_descriptions WHERE room_id=?", "DELETE FROM member_labels WHERE room_id=?", "DELETE FROM execution_notes WHERE room_id=?", "DELETE FROM execution_denials WHERE room_id=?", "DELETE FROM execution_segments WHERE room_id=?", "DELETE FROM member_executions WHERE room_id=?", "DELETE FROM member_sessions WHERE room_id=?", "DELETE FROM member_registrations WHERE room_id=?",
      "DELETE FROM room_members WHERE room_id=?", "DELETE FROM room_modes WHERE room_id=?",
      "DELETE FROM free_batches WHERE room_id=?", "DELETE FROM free_chains WHERE room_id=?", "DELETE FROM free_handoffs WHERE room_id=?", "DELETE FROM free_settings WHERE room_id=?", "DELETE FROM free_round_limits WHERE room_id=?", "DELETE FROM free_chain_holds WHERE room_id=?", "DELETE FROM room_links WHERE room_id=?",
      "DELETE FROM discussion_options WHERE room_id=?",
      "DELETE FROM round_budgets WHERE room_id=?", "DELETE FROM discussion_conclusions WHERE room_id=?", "DELETE FROM discussion_sessions WHERE room_id=?",
      "DELETE FROM scheduler_feedback WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)",
      "DELETE FROM scheduler_decision_context WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)",
      "DELETE FROM scheduler_decision_inputs WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)",
      "DELETE FROM scheduler_decision_details WHERE decision_id IN (SELECT id FROM scheduler_decisions WHERE room_id=?)", "DELETE FROM scheduler_decisions WHERE room_id=?", "DELETE FROM scheduler_routing WHERE room_id=?",
      "DELETE FROM message_withdrawals WHERE message_id IN (SELECT id FROM messages WHERE room_id=?)", "DELETE FROM room_rewinds WHERE room_id=?",
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
  if (action === "delete" && !results.at(-1).meta.changes) throw new HttpError(400, "房间名称已变化，请重新确认删除");
  return action === "delete" ? { deleted: true, id: room_id } : require_room(database, room_id);
}

/** Normalize and validate a message before either URL or JSON publication. */
function message_values(payload) {
  const author = String(payload.author ?? "").trim();
  const text = String(payload.text ?? "").trim();
  const submission_id = submission_value(payload.submission_id);
  const reply_to = payload.reply_to ? integer(payload.reply_to) : null;
  if (!is_participant(author) && author !== "web") throw new HttpError(400, "请选择有效的发言者");
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
  if (!is_participant(params.actor)) throw new HttpError(400, "上传附件须声明有效的 actor");
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
async function attach_message_files(database, all_messages) {
  // The owner retracted these before anyone handled them: only the page that retracted one keeps its text.
  for (const message of all_messages.filter(item => item.withdrawn === "retracted")) Object.assign(message, { text: "", summary: "", attachments: [], suggestions: [] });
  const messages = all_messages.filter(item => item.withdrawn !== "retracted");
  if (!messages.length) return all_messages;
  const rows = await database.prepare(`SELECT * FROM attachments WHERE message_id IN (${messages.map(() => "?").join(",")}) ORDER BY position,id`)
    .bind(...messages.map(message => message.id)).all();
  for (const message of messages) message.attachments = rows.results.filter(file => file.message_id === message.id).map(attachment_view);
  const suggestions = (await database.prepare(`SELECT s.message_id,s.member_id,m.name AS member,m.status,
    r.id AS request_id,r.status AS request_status FROM member_suggestions s JOIN room_members m ON m.id=s.member_id
    LEFT JOIN member_requests r ON r.message_id=s.message_id AND r.member_id=s.member_id
    WHERE s.message_id IN (${messages.map(() => "?").join(",")}) ORDER BY s.member_id`)
    .bind(...messages.map(message => message.id)).all()).results;
  for (const message of messages) message.suggestions = suggestions.filter(item => item.message_id === message.id)
    .map(({ message_id, ...item }) => item);
  return all_messages;
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
async function store_attachment(database, bucket, room_id, metadata, data, member_id = null) {
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const expected = { ...metadata, size: data.length, sha256, content_type: attachment_content_type(data) };
  const previous = await database.prepare("SELECT * FROM attachments WHERE room_id=? AND submission_id=?").bind(room_id, metadata.submission_id).first();
  if (previous) { check_attachment_retry(previous, expected); return { attachment: attachment_view(previous), duplicate: true }; }
  const id = crypto.randomUUID().replaceAll("-", ""), key = `rooms/${room_id}/${id}`;
  try {
    await bucket.put(key, data, { httpMetadata: { contentType: expected.content_type } });
    const statements = [
      database.prepare(`INSERT INTO attachments (id,room_id,file_name,actor,submission_id,size,sha256,content_type,created_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
        .bind(id, room_id, expected.file_name, expected.actor, expected.submission_id, expected.size, sha256, expected.content_type, new Date().toISOString()),
      database.prepare("SELECT * FROM attachments WHERE room_id=? AND submission_id=?").bind(room_id, metadata.submission_id),
    ];
    const results = member_id === null ? await database.batch(statements) : await checked_batch(database,
      "EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active' AND room_id=?)", [member_id, room_id], statements);
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
  const submitted_by = payload.submitted_by ?? (["cli", "api"].includes(payload.source) ? author : "用户");
  if (!["opinion", "moderation"].includes(kind) || !is_participant(submitted_by)) throw new HttpError(400, "发言职责或提交者无效");
  if (!["用户", room.host, author].includes(submitted_by)) throw new HttpError(400, "只有用户或主持人可以代发其他专家的观点");
  if (kind === "moderation" && (author !== room.host || !["用户", room.host].includes(submitted_by))) throw new HttpError(400, "主持发言必须保留当前主持人署名");
  if (submitted_by === author && ["cli", "api"].includes(payload.source) && author !== "用户" && room.experts[author] !== "cli") throw new HttpError(400, "当前专家配置为在线只读，请由用户或主持人代发");
  const source = submitted_by === room.host && submitted_by !== author && submitted_by !== "用户" ? "host_proxy" :
    (["cli", "api"].includes(payload.source) && submitted_by === author ? payload.source : (author === "用户" ? "user" : "proxy"));
  return { kind, submitted_by, source, turn_id: payload.turn_id ? integer(payload.turn_id) : null };
}

/** Preserve a supplied summary and distinguish its writer from the answer's author. */
function message_summary(payload, message) {
  const summary = String(payload.summary ?? "").trim();
  if (text_length(summary) > MAX_SUMMARY_LENGTH) throw new HttpError(400, `回答摘要最多 ${MAX_SUMMARY_LENGTH} 字`);
  const summary_by = summary ? (payload.summary_by ?? message.submitted_by) : "";
  if (summary && (!["opinion", "chat"].includes(message.kind) || ![message.author, message.submitted_by].includes(summary_by))) {
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
function message_statements(database, room_id, message, hashed, asked = []) {
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
      WHERE m.room_id=? AND m.submission_id=? AND m.source IN ('cli','api') AND d.submitted_by=m.author
        AND e.status='started' AND e.token_hash=? AND t.dispatched_at>0
      ON CONFLICT(message_id) DO NOTHING`).bind(room_id, submission_id, hashed),
    database.prepare(`UPDATE discussion_turns SET status='answered',answer_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)
      WHERE id=? AND status IN ('pending','notified') AND EXISTS
      (SELECT 1 FROM messages JOIN message_details ON messages.id=message_details.message_id
      WHERE messages.room_id=? AND messages.submission_id=? AND message_details.turn_id=discussion_turns.id)`)
      .bind(room_id, submission_id, turn_id, room_id, submission_id),
    // The user's direct questions to members: requests outside the discussion's turns, rounds and limits.
    ...asked.map(member_id => database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
      SELECT ?,?,id,id,'ask','user',unixepoch() FROM messages WHERE room_id=? AND submission_id=? AND author='用户'`).bind(room_id, member_id, room_id, submission_id)),
    database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, submission_id),
  ];
}

/** A running discussion already wakes its host for every user message, so a question to the host needs no request of its own. */
async function discussion_host_handles(database, room) {
  return !["paused", "concluded"].includes(room.phase)
    && Boolean(await database.prepare("SELECT 1 FROM discussion_runtime WHERE room_id=? AND status='running'").bind(room.id).first());
}

/** Validate the user's direct questions to members of a discussion before the message is stored. */
async function checked_asks(database, room, payload) {
  if (payload.to === undefined || payload.to === null) return [];
  const active = await free_active_members(database, room.id);
  const ids = free_named(active, payload.to);
  const hosted = await discussion_host_handles(database, room);
  return ids.filter(id => !(hosted && active[room.host]?.id === id));
}

/** A discussion message that closes the user's direct question: it names an execution or the requests it answers. */
function answers_direct_question(payload) {
  return Number.isInteger(payload.execution_id) || (Array.isArray(payload.request_ids) && payload.request_ids.length > 0);
}

/** Atomically append a message, preserving idempotency under concurrent retries. */
async function append_message(database, room_id, payload, token = "", free_actor = null) {
  const values = message_values(payload);
  const room = await require_room(database, room_id);
  if (room.mode === "free" || free_actor !== null) {
    const previous = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
    // An exact retry of a discussion message saved before the discussion ended keeps its original result.
    if (previous && !["chat", "moderation"].includes(previous.kind) && previous.author === values.author && previous.text === values.text) {
      await attach_message_files(database, [previous]);
      return { message: previous, duplicate: true };
    }
    return append_free_message(database, room, payload, free_actor);
  }
  const expected = { ...values, ...message_details(room, { ...payload, author: values.author }), attachment_ids: attachment_ids(payload) };
  // An expert's opinion answers the arrangement open for that expert; naming it with turn_id is optional.
  const implied_turn = expected.author !== "用户" && expected.kind === "opinion" && !expected.turn_id;
  Object.assign(expected, message_summary(payload, expected));
  const previous = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
  if (previous) { await attach_message_files(database, [previous]); check_retry(previous, implied_turn ? { ...expected, turn_id: previous.turn_id } : expected); return { message: previous, duplicate: true }; }
  if (implied_turn) {
    const open_turn = await database.prepare("SELECT id FROM discussion_turns WHERE room_id=? AND expert=? AND status IN ('pending','notified')").bind(room_id, expected.author).first();
    if (!open_turn) throw new HttpError(400, "专家观点只能回答为你安排的发言；当前没有轮到你的有效安排");
    expected.turn_id = open_turn.id;
  }
  if (expected.author !== "用户" && expected.kind === "opinion") database = guard_limits(database, room);
  if (["paused", "concluded"].includes(room.phase) && expected.kind === "opinion" && (expected.author !== "用户" || room.archived)) throw new HttpError(400, "话题已暂停或收束；恢复阶段后才能提交新观点");
  await check_message_references(database, room_id, expected);
  await check_message_attachments(database, room_id, expected);
  const asked = expected.author === "用户" ? await checked_asks(database, room, payload) : [];
  let results;
  try { results = await database.batch(message_statements(database, room_id, expected, token ? await runtime_hash(token) : "", asked)); }
  catch (error) {
    if (String(error).includes("UNIQUE constraint")) {
      const saved = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
      if (saved) { await attach_message_files(database, [saved]); check_retry(saved, expected); return { message: saved, duplicate: true }; }
    }
    if (String(error).includes("attachment_unavailable")) throw new HttpError(409, "附件已用于其他消息，或不属于本次实际提交者");
    if (String(error).includes("floor_turn_required")) throw new HttpError(400, "专家观点必须关联当前有效的 turn_id");
    if (String(error).includes("topic_inactive")) throw new HttpError(400, "话题已暂停或收束，请重新读取阶段");
    if (String(error).includes("UNIQUE constraint") || String(error).includes("turn_unavailable")) throw new HttpError(409, "该发言安排已有回答或已取消，请重新读取核对");
    throw error;
  }
  const message = results.at(-1).results[0];
  await attach_message_files(database, [message]);
  check_retry(message, expected);
  await record_reported_session(database, room_id, token, payload);
  return { message, duplicate: results[0].results.length === 0 };
}

const SESSION_ID_PATTERN = /^[0-9A-Za-z_-]{8,128}$/;

/** Keep the software session a manual member posted from, so the local service can take the member over. */
async function record_reported_session(database, room_id, token, payload) {
  const { session_id, session_client } = payload;
  if (!["claude", "codex", "antigravity"].includes(session_client) || typeof session_id !== "string" || !SESSION_ID_PATTERN.test(session_id) || !token) return;
  const member = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND access='manual' AND adapter IN ('manual','')")
    .bind(room_id, await runtime_hash(token)).first();
  if (member) {
    await database.prepare(`INSERT INTO member_sessions (member_id,room_id,session_id,client) VALUES (?,?,?,?)
      ON CONFLICT(member_id) DO UPDATE SET session_id=excluded.session_id,client=excluded.client`).bind(member.id, room_id, session_id, session_client).run();
  }
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
/** Who is present and who still owes a turn in the open round; its revision changes whenever either changes. */
async function roster_view(room) {
  const last = room.rounds.at(-1);
  const spoken = new Set(last && !last.completed ? last.speakers : []);
  const unregistered = unregistered_experts(room);
  // Experts follow the room's speaking order, so a round plan can take the user's preferred order from the roster.
  const rank = new Map(room.speaking_order.items.map((item, index) => [item.name, index]));
  const place = (name) => rank.get(name) ?? rank.size;
  const experts = Object.entries(room.experts).sort(([left], [right]) => place(left) - place(right))
    .map(([name, mode]) => ({ name, mode, host: name === room.host, spoken: spoken.has(name), registered: !unregistered.includes(name) }));
  const state = JSON.stringify([Object.keys(room.experts).sort(), [...spoken].sort(), [...unregistered].sort()]);
  return { experts, unregistered, waiting: experts.filter((item) => !item.spoken && !item.host && item.registered).map((item) => item.name), revision: (await digest_hex(state)).slice(0, 12) };
}

/** Manual experts that have not registered from their own session; they cannot be scheduled until they do. */
function unregistered_experts(room) {
  return room.members.filter((member) => member.adapter === "manual" && member.status === "active" && !member.registered_at && member.name in room.experts).map((member) => member.name);
}

/** Reject scheduling an expert that has not registered yet; it joins the round queue by itself once it registers. */
function require_registered(room, names) {
  const pending = unregistered_experts(room);
  const missing = [...new Set(names)].filter((name) => pending.includes(name));
  if (missing.length) throw new HttpError(400, `以下手动专家尚未注册，不能安排发言：${missing.join("、")}；它在自己的会话中注册后会自动加入本轮队列，也可先让其暂离`);
}

/** A multi-turn plan is only accepted against the latest roster and must schedule everyone still waiting in the round. */
async function require_round_coverage(room, plan, payload) {
  if (plan.length < 2) return;
  const roster = await roster_view(room);
  if (payload.roster === undefined || payload.roster === null) throw new HttpError(400, "整轮安排前须先获取最新专家状态（turn roster），并在计划中带上其 revision");
  if (payload.roster !== roster.revision) throw new HttpError(409, "专家状态已变化，请重新获取 turn roster 后再安排");
  const planned = new Set(plan.map((item) => item.expert));
  const missing = roster.waiting.filter((name) => !planned.has(name));
  if (missing.length) throw new HttpError(400, `整轮安排缺少本轮尚未发言的专家：${missing.join("、")}；本轮不需要其发言时先让其暂离，再重新获取 turn roster`);
}

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
  require_registered(room, plan.map((item) => item.expert));
  await require_round_coverage(room, plan, payload);
  if (["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，请先调整阶段");
  const created_at = new Date().toISOString();
  let results;
  try {
    results = await database.batch(plan.map((item, index) => database.prepare(`INSERT INTO discussion_turns (room_id,expert,question,status,submission_id,created_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
      .bind(room_id, item.expert, item.question, index === 0 ? "pending" : "queued", item.submission_id, created_at)));
  } catch (error) {
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
  require_registered(room, [room.queued_turns[0].expert]);
  const turn_id = room.queued_turns[0].id;
  const [result] = await database.batch([database.prepare(`UPDATE discussion_turns SET status='pending' WHERE id=? AND status='queued'
    AND NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=? AND status IN ('pending','notified'))`).bind(turn_id, room_id)]);
  if (!result.meta.changes) throw new HttpError(409, "安排已变化，请重新读取");
  return { turn: await get_turn(database, room_id, turn_id), queued: room.queued_turns.slice(1) };
}

/** Record explicit delivery confirmation or cancellation without external I/O. */
async function update_turn(database, room_id, turn_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const turn = await get_turn(database, room_id, turn_id);
  const { status } = payload;
  if (!["notified", "cancelled"].includes(status)) throw new HttpError(400, "安排状态仅可显式改为 notified 或 cancelled");
  if (turn.status === status || (status === "cancelled" && turn.status === "skipped")) return turn;
  if (status === "notified" && ["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，不能继续通知");
  if (!["pending", "notified"].includes(turn.status)) throw new HttpError(409, "该发言安排已结束");
  await database.prepare(`UPDATE discussion_turns SET status=?,notified_at=? WHERE id=? AND status IN ('pending','notified')
    AND (?='cancelled' OR NOT EXISTS (SELECT 1 FROM topic_settings WHERE room_id=discussion_turns.room_id AND phase IN ('paused','concluded')))`)
    .bind(status, status === "notified" ? new Date().toISOString() : turn.notified_at, turn.id, status).run();
  const updated = await get_turn(database, room_id, turn_id);
  if (updated.status !== status) throw new HttpError(409, "话题阶段或发言安排已变化，请重新读取核对");
  return updated;
}

/** Build exact and incremental filters without expanding the read scope. */
function message_filters(room_id, params) {
  const clauses = ["room_id=?", "NOT EXISTS (SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)"];
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
    if (!["opinion", "moderation", "receipt", "chat"].includes(params.kind)) throw new HttpError(400, "发言职责无效");
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
  if (Object.hasOwn(params, "_max_id")) { clauses.push("messages.id<=?"); values.push(integer(params._max_id)); }
  if (params.withdrawn !== INCLUDE_WITHDRAWN) clauses.push("withdrawn.message_id IS NULL");
  return { where: clauses.join(" AND "), values };
}

/** Return one page, advancing incremental cursors only through returned rows. */
async function discussion_read_boundary(database, room_id, params, token) {
  if (params.execution_id !== undefined && params.request_id !== undefined) throw new HttpError(400, "execution_id 与 request_id 不能同时提供");
  let request;
  if (params.execution_id === undefined && params.request_id === undefined) {
    const member = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND token_hash=? AND status='active'")
      .bind(room_id, await runtime_hash(token)).first();
    if (!member) return initial_session_read_limit(database, room_id, token);
    request = await database.prepare(`SELECT r.* FROM member_requests r JOIN session_requests q ON q.member_request_id=r.id
      JOIN discussion_sessions s ON s.id=q.session_id WHERE r.room_id=? AND r.member_id=? AND r.purpose='discuss'
      AND r.status IN ('pending','delivering') AND q.status='open' AND s.status='active' ORDER BY q.round,q.position,q.id LIMIT 1`)
      .bind(room_id, member.id).first();
    if (!request) return initial_session_read_limit(database, room_id, token);
  } else {
    const member = await require_free_member(database, room_id, token);
    if (params.request_id !== undefined) {
      request = await database.prepare("SELECT * FROM member_requests WHERE room_id=? AND id=? AND member_id=?")
        .bind(room_id, integer(params.request_id), member.id).first();
    } else {
      const execution = await database.prepare("SELECT * FROM member_executions WHERE room_id=? AND id=? AND member_id=?")
        .bind(room_id, integer(params.execution_id), member.id).first();
      if (execution) request = await database.prepare("SELECT * FROM member_requests WHERE room_id=? AND execution_id=? AND member_id=? ORDER BY id LIMIT 1")
        .bind(room_id, execution.id, member.id).first();
    }
  }
  if (!request) throw new HttpError(403, "请求或执行不属于当前成员");
  if (params.execution_id !== undefined || request.execution_id !== null) {
    const execution_id = params.execution_id === undefined ? request.execution_id : integer(params.execution_id);
    const execution = await database.prepare("SELECT status,lease_until FROM member_executions WHERE room_id=? AND id=? AND member_id=?")
      .bind(room_id, execution_id, request.member_id).first();
    if (!execution || !["dispatched", "started"].includes(execution.status) || execution.lease_until <= Math.floor(Date.now() / 1000)) {
      throw new HttpError(409, "直接提问执行已结束或失效，请重新读取当前请求");
    }
  }
  const plan = await database.prepare(`SELECT q.read_until,q.status AS request_status,q.purpose,s.status AS session_status
    FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id WHERE q.member_request_id=?`).bind(request.id).first();
  if (!plan) {
    if (request.purpose === "ask" && ["pending", "delivering"].includes(request.status)) return null;
    if (request.purpose === "ask") throw new HttpError(409, "直接提问已结束或失效，请重新读取当前请求");
    return initial_session_read_limit(database, room_id, token);
  }
  if (plan.purpose !== "discuss") return null;
  if (plan.session_status !== "active" || plan.request_status !== "open" || !["pending", "delivering"].includes(request.status)) {
    throw new HttpError(409, "讨论请求已暂停、过期或结束，请重新读取当前安排");
  }
  return plan.read_until;
}

/** Anonymous and unassigned readers in an initial session share its frozen start boundary. */
async function initial_session_read_limit(database, room_id, token = "") {
  const session = await database.prepare(`SELECT st.read_until FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
    WHERE s.room_id=? AND s.status IN ('active','paused') AND st.phase='initial' ORDER BY s.id DESC LIMIT 1`).bind(room_id).first();
  if (!session) return null;
  const token_hash = await runtime_hash(token);
  if (token_hash && (await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?").bind(room_id, token_hash).first()
    || await database.prepare("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND role='host'").bind(room_id, token_hash).first())) return null;
  return session.read_until;
}

async function query_messages(database, room_id, params, token = "") {
  await require_room_id(database, room_id);
  const page = Math.max(1, integer(params.page ?? 1));
  const max_id = await discussion_read_boundary(database, room_id, params, token);
  const filtered = max_id === null ? params : { ...params, _max_id: max_id };
  const { where, values } = message_filters(room_id, filtered);
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
async function get_message(database, room_id, message_id, params = {}, token = "") {
  const max_id = await discussion_read_boundary(database, room_id, params, token);
  if (max_id !== null && integer(message_id) > max_id) throw new HttpError(404, "消息不存在");
  const message = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND messages.id=?
    AND NOT EXISTS (SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)`)
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
  const saved_brief = await database.prepare("SELECT until FROM room_briefs WHERE room_id=?").bind(room_id).first();
  if (Object.hasOwn(payload, "brief") && saved_brief && until < saved_brief.until) throw new HttpError(400, `简报已整理至 #${saved_brief.until}，截止编号不能回退；请先读取最新状态`);
  const statements = [database.prepare("UPDATE rooms SET state_text=?,state_until=? WHERE id=?").bind(text, until, room_id)];
  const session = await latest_session(database, room_id);
  if (session?.held_since && until >= session.held_since) statements.push(database.prepare("UPDATE session_state SET held_since=0,revision=revision+1 WHERE session_id=? AND held_since=?").bind(session.id, session.held_since));
  if (Object.hasOwn(payload, "brief")) statements.push(database.prepare(`INSERT INTO room_briefs (room_id,text,until,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(room_id) DO UPDATE SET text=excluded.text,until=excluded.until,updated_at=excluded.updated_at`).bind(room_id, brief, until, new Date().toISOString()));
  await database.batch(statements);
  return require_room(database, room_id);
}

/** Read the host's brief explicitly without adding it to independent-entry overviews. */
function state_reading_text(room, read_limit = null) {
  const brief = read_limit !== null && room.host_brief?.until > read_limit ? null : room.host_brief;
  const state_allowed = read_limit === null || room.state_until <= read_limit;
  const overview = brief?.text ? `主持简报（整理至 #${brief.until}，${brief.updated_at}）\n${brief.text}` : "主持简报：尚未更新";
  return `${overview}\n\n主持人维护的状态（整理至 #${room.state_until}）\n\n${state_allowed ? room.state_text || "尚未整理" : "该状态超出当前独立阅读范围。"}`;
}

/** Render a message with its provenance and original reply reference. */
function message_text(message) {
  const reply = message.reply_to ? ` · 回复 #${message.reply_to}` : "";
  const role = { moderation: "主持发言", receipt: "运行回执", chat: "协作消息" }[message.kind] || "专家观点";
  const summary = message.summary ? `\n回答摘要（${message.summary_by}）：\n${message.summary}\n\n完整正文：\n` : "\n";
  const attachments = (message.attachments ?? []).map(file => `\n附件：${file.file_name}（${file.size} 字节；ID: ${file.id}）\n${file.download_url}`).join("");
  const turn_link = message.turn_id ? `；旧安排详情：/r/${message.room_id}/turns/${message.turn_id}?legacy=1` : "";
  return `#${message.id} · ${message.author} · ${message.created_at}${reply}\n职责：${role}；来源：${message.source}；提交者：${message.submitted_by ?? "用户"}；安排：${message.turn_id || "无"}${turn_link}${summary}${message.text}${attachments}`;
}

/** Expose an overview; supporting context is available only through chosen links. */
async function room_text(database, room_id, params) {
  const room = await require_room(database, room_id);
  const base = `/r/${room_id}`;
  const content = [`# ${room.title}`, `目标：${room.goal}`,
    `主持人：${room.host}；阶段：${PHASES[room.phase]}；当前焦点：${room.focus || "尚未填写"}`,
    `当前记录截止 #${room.latest_id}；共 ${room.message_count} 条；已完成 ${room.completed_rounds} 轮讨论（所有参与专家各发言一次）。`];
  const limits = room.limits;
  content.push(`讨论上限：${limits.max_rounds || '不限'} 轮；总时长 ${limits.max_minutes || '不限'} 分钟；单次自动执行 ${limits.execution_minutes ? `${limits.execution_minutes} 分钟` : "不限时长"}；到限后讨论结束，房间回到自由协作。到限：${limits.reached}。`);
  if (room.mode === "free") {
    const members = room.free.members.map(item => `${item.name}（已读至 #${item.read_until}，待投递 ${item.pending}）`).join("；");
    content.push(`自由协作房间：无发言权、安排与轮次。成员：${members || "无"}。用户的消息点名成员后生成请求；成员回答须带本次执行编号，执行结束、被打断或过期后的回答会被拒绝，不能改作普通发言。`);
    content.push("", "## 读取", `完整历史（分页）：${base}/messages?page=1`, `单条原文：${base}/messages/消息编号`, ...participation_text(params, true));
    return content.join("\n\n");
  }
  const turn = room.current_turn;
  content.push("没有发言权：被安排的专家直接回答自己的安排；用户本人和任何人的 @ 直接提问可随时发出。");
  if (room.phase === "initial") content.push("本阶段先独立形成详细观点：仅阅读目标、背景、边界和自己的已有讨论；暂不阅读他人观点或主持总结。提交后再交叉阅读。这是参与约定，不是权限隔离。");
  if (room.archived) content.push("房间已存档，记录仍可查阅；先恢复房间，再由用户明确恢复讨论阶段。");
  if (["paused", "concluded"].includes(room.phase)) content.push("停止处理发言安排，取消本讨论自己的后台任务并核对实际状态；不要因旧通知恢复讨论。");
  if (turn) content.push(`当前安排 #${turn.id}：${turn.expert} · ${turn_status_label(turn, room)}`, `待回应问题：${turn.question}`, `安排详情：${base}/turns/${turn.id}`);
  if (room.queued_turns.length) content.push(`本轮排队：${room.queued_turns.map((item) => `#${item.id} ${item.expert}`).join(" → ")}`);
  if (room.held_since) content.push(`用户自 #${room.held_since} 起有待主持人处理的操作；当前回答完成后交给主持人，不自动接力。`);
  content.push("## 按需展开", "请自主选择需要的材料，不必读取全部历史。", `背景、边界与参与专家：${base}/brief`,
    `共识与分歧（整理至 #${room.state_until}）：${base}/state`);
  if (params.participant) content.push(`与 @${params.participant} 相关的观点：${base}/search?mention=${params.participant}&page=1`);
  content.push("", "## 读取与检索", `完整历史（分页）：${base}/messages?page=1`,
    `单条原文：${base}/messages/消息编号`, `检索：${base}/search?q=关键词&page=1`,
    `按作者检索：${base}/search?author=Claude`, `发言安排历史：${base}/turns?page=1`);
  content.push(...participation_text(params));
  return content.join("\n\n");
}

/** Local AIs follow the skills; web AIs read this short guide in place of them. */
function participation_text(params, free = false) {
  const footer = "参与方式按运行环境区分；主持人可以兼任专家；作者、职责与来源尚未认证。";
  if (params.mode === "cli") return ["", "## 本地 AI", "本地 AI 请调用 discuss-participant（主持人另调用 discuss-host），用 codiscuss 命令读写；"
    + "字段与写入规则以 codiscuss room protocol 为准，不直接调用网站接口。", footer];
  return ["", "## 在线 AI · 只读参与",
    "你是只读成员：读取议题、状态和与你相关的原文，在自己的聊天窗口回答；回答由用户代发留档。",
    "先回答真正的问题，给出理由、证据、适用条件与不确定性；区分事实、推断和建议，引用原文编号，不编造他人的回答。"
      + "讨论初始阶段先独立判断，暂不读他人观点；深入讨论先理解对方主张及其最有力的依据，再说明同意、分歧或需要补的证据。"
      + "可以坚持有依据的少数意见，也可因新证据修改判断并说明变化。",
    "输出：完整正文；回答较长时先给 1–3 句摘要。",
    "不要操作网页表单、调用写入接口或生成发布链接。读取失败时如实报告，由用户提供复制的材料。",
    ...(free ? ["自由协作：只回应点名给你的消息（编号见阅读通知），按时间顺序处理，后面的消息可以修正前面的。"] : []), footer];
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
  const association = turn.session_id ? `关联请求：${turn.member_request_id || '尚未派发'}` : `历史安排：${turn.id}`;
  return `安排 #${turn.id} · ${turn.expert} · ${turn_status_label(turn, room)}\n待回应问题：${turn.question}\n话题入口：/r/${room_id}?participant=${turn.expert}\n${association}${answer}\n本地成员凭自己的请求或执行保存完整回答，较长回答可附摘要；旧安排仅供历史阅读。`;
}

/** Describe CLI host operations separately from topic material. */
function protocol_text(room) {
  if (room.mode !== "free") return "# 旧讨论历史\n\n旧讨论已只读保留；如需继续，由用户在协作房间开启新讨论。";
  const base = `/api/rooms/${room.id}`;
  return [
    "# 协作房间参与协议",
    "当前主持人：HOST。讨论是房间内的会话；自由协作请求与讨论请求共用成员执行。",
    "先用 room view 读取成员、职责、free.requests、session 与阶段，再按需读取原文。任务中的 purpose=discuss 表示讨论发言，discuss_host 表示主持任务，ask 表示直接提问；内部任务来源不是普通发言。",
    "用户管理和讨论开关使用房主凭据；本地成员使用本人的 --access-file，不借用其他身份。凭据私下交付，不公开 token。API 参与者遵循相同请求与执行约束，source=api；本地 CLI 使用 source=cli。",
    "runner 成员等待本机接入程序交付任务，用 execution view 核对本次执行和请求，再以 message post --as 本人 --kind chat --execution 本次编号 --access-file FILE 回答。执行失效后保留草稿，不能去掉编号改作普通发言；认领、续租与后续投递由接入程序处理。",
    "manual 本地成员首次用 member register 注册，会话 ID 由 CLI 自动取得；回答用 --request 请求编号，不编造执行编号。讨论不使用原生定时；原会话不能托管时由用户触发。网页成员只读，用户或当前主持人在核对真实回答后以本人身份、--author 原专家和 --request 关联请求代发。",
    "自由协作中的 host 可用 --to 点名成员，route 表示未点名的用户请求，handoff 表示派出任务已结束；链上 AI 派活受房间预算限制。普通成员的 --to 或正文 @ 只保存回应建议，不直接唤醒；不点名自己、不扩大授权。",
    "讨论中的用户 @ 直接提问独立排队，不计讨论轮次、不与讨论发言合并。initial 阶段先独立判断；服务端按讨论请求的 read_until 限制读取。直接提问和主持任务不继承该阅读限制。",
        "主持安排前先 turn roster 读取在场专家、waiting、unregistered 和 revision，再 turn create --roster revision；单项和多项都要带凭据，多项计划须覆盖本轮 waiting。继续排队同样先读 roster，再 turn continue --roster revision。状态或新消息变化后旧凭据被拒绝，重新读取再判断；每个回答保存后由程序推进下一项。",
    "计划或收束成功即完成本次主持执行，无需再提交回答回执。主持说明使用 kind=moderation，不替代专家回答，也不会完成主持执行；主持人作为专家发言须回答自己的 discuss 请求。",
    "讨论状态读取 GET BASE/discussion；房主先读取 revision，再 POST 同路径提交 start、pause、resume 或 end。CLI 对应 run view/start/pause/resume/stop。开启可携带 submission_id，原编号与原内容重试返回原会话，已结束的会话不会因重试恢复。",
    "room limits 返回轮次、时长和进度；到限立即结束讨论并回到自由协作，不再唤醒主持人总结。暂停不计时，并作废讨论请求和执行；恢复生成新任务，旧执行不得继续写。",
    "原会话送达失败可等待 60 秒后自动重试，最多 3 次；重试用尽只失败该请求，并交回主持人判断跳过、重排或暂停，不自动暂停整场。结果不明的写入不作为新提交重发。",
    "保存 state 与主持简报时，until 只覆盖实际已读原文。主动收束前先保存有依据的总结与状态，再 room conclusion 获取 blockers 和 revision，无阻碍后用 room limits --done --conclusion revision；有未处理内容或状态变化时拒绝收束。",
    "message list --after 按 next_after/has_more 增量读取；message view 核对原文；历史可筛选 opinion/moderation/chat。内部任务不出现在普通消息列表、搜索和统计中，也没有普通发言的撤回或编辑入口。",
    "附件用 attachment upload/download，最多 10 个、单个 20 MiB；自动成员在完成执行前上传。回答正文最多 32000 个 Unicode 字符，摘要最多 1000 字，较长回答才附摘要，完整原文不截断。",
    "每次新内容使用新 submission_id，同次重试沿用编号、原文、凭据和执行/请求关联。按 submission_id 查询持久结果；读取失败不表示未写入，不能换身份或编号绕过拒绝。"
].join("\n\n").replace("HOST", room.host).replace("BASE", base);
}

/** Route the existing JSON API without changing frontend callers. */
// Generated on first use (Workers forbid randomness at global scope) and never leaves this isolate.
let owner_proxy_prefix = "";

/** An in-isolate stand-in for a room's control credential, so an administrator session writes as its owner. */
function owner_proxy_token(control_hash) {
  owner_proxy_prefix ||= `${crypto.randomUUID()}:`;
  return owner_proxy_prefix + control_hash;
}

/** Hash bounded bearer capabilities; raw values are never persisted. */
async function runtime_hash(token) {
  if (owner_proxy_prefix && typeof token === "string" && token.startsWith(owner_proxy_prefix)) return token.slice(owner_proxy_prefix.length);
  if (typeof token !== "string" || token.length < 32 || token.length > 256) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Validate the same bounded settings as the SQLite backend. */
function limit_values(payload, current = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).some(key => !Object.hasOwn(LIMIT_DEFAULTS, key) && !LEGACY_LIMIT_FIELDS.includes(key))) throw new HttpError(400, "limits 仅接受讨论上限配置字段");
  if ((payload.on_limit ?? "pause") !== "pause") throw new HttpError(400, "到限后只会暂停；需要总结时请主持人在暂停后按你的要求写出");
  const result = Object.fromEntries(Object.entries(LIMIT_DEFAULTS).map(([key, value]) => [key, current[key] ?? value]));
  Object.assign(result, Object.fromEntries(Object.entries(payload).filter(([key]) => Object.hasOwn(LIMIT_DEFAULTS, key))));
  for (const [key, minimum, maximum] of [["max_rounds", 0, 100], ["max_minutes", 0, 1440], ["execution_minutes", 0, 60]]) {
    if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new HttpError(400, `${key} 须为 ${minimum}–${maximum} 的整数`);
  }
  return result;
}

/** Prepare settings updates without restarting the discussion clock. */
function limit_statements(database, room_id, settings) {
  return settings.save_limits ? [database.prepare(`UPDATE discussion_limits SET max_rounds=?,max_minutes=?,execution_minutes=?,
    stop_reason=CASE WHEN ? THEN '' ELSE stop_reason END,revision=revision+1 WHERE room_id=?`)
    .bind(...Object.keys(LIMIT_DEFAULTS).map(key => settings.limits[key]), Number(settings.reset_stop), room_id)] : [];
}

/** Derive public progress; reads never perform lifecycle mutations. */
function limits_view(row, room) {
  const now = Math.floor(Date.now() / 1000);
  const idle = row.idle_seconds || 0;
  let deadline = row.started_at && row.max_minutes ? row.started_at + row.max_minutes * 60 + idle : 0;
  if (room.runtime?.deadline && (room.runtime.status === "running" || row.stop_reason)) deadline = Math.min(deadline || room.runtime.deadline, room.runtime.deadline);
  // A budgeted room counts rounds from the budget base; a legacy room counts whole-roster rounds from the start.
  const budget = room.round_budget;
  const experts = Object.keys(room.experts || {}).length;
  const segment_rounds = budget ? (experts ? Math.floor(Math.max(0, room.opinion_count - budget.base) / experts) : 0) : room.completed_rounds;
  const round_cap = budget ? budget.cap || row.max_rounds : row.max_rounds;
  const reason = deadline && now >= deadline ? "time_limit" : round_cap && segment_rounds >= round_cap ? "round_limit" : "";
  return { ...row, deadline, reason, reached: Boolean(reason),
    completed_rounds: room.completed_rounds, segment_rounds, round_cap, extra_rounds: budget?.extra ?? 0, remaining_seconds: deadline ? Math.max(0, deadline - now) : null,
    elapsed_seconds: row.started_at ? Math.max(0, now - row.started_at - idle) : 0 };
}

/** Fence new expert work against concurrent answers, settings and the clock. */
function guard_limits(database, room) {
  if (room.limits.reached) throw new HttpError(409, "已达到讨论上限；请检查上限，讨论随之结束并回到自由协作");
  return guarded_database(database, `EXISTS(SELECT 1 FROM discussion_limits WHERE room_id=? AND revision=?)
    AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=?),0)=? AND (?=0 OR unixepoch()<?)
    AND EXISTS(SELECT 1 FROM topic_settings WHERE room_id=? AND json(experts)=json(?))`,
    [room.id, room.limits.revision, room.id, room.latest_id, room.limits.deadline, room.limits.deadline, room.id, JSON.stringify(room.experts)]);
}

/** User-only: reopen a concluded discussion that has not returned to free collaboration. */
async function reopen_limits(database, room_id, payload) {
  const room = await require_room(database, room_id);
  if (payload.actor !== "用户") throw new HttpError(400, "仅用户可以重启已收束的讨论");
  if (room.archived) throw new HttpError(400, "请先恢复已存档房间");
  if (room.mode === "free") throw new HttpError(400, "房间已回到自由协作；需要讨论时请重新开启讨论");
  if (!room.round_budget) throw new HttpError(400, "该房间沿用旧轮次计数，不支持重启");
  if (room.phase !== "concluded") throw new HttpError(400, "仅已收束的讨论可以重启");
  const fence = "EXISTS(SELECT 1 FROM discussion_limits WHERE room_id=? AND revision=?) AND EXISTS(SELECT 1 FROM topic_settings WHERE room_id=? AND phase='concluded')";
  const rounds = payload.max_rounds ?? room.limits.max_rounds;
  if (!Number.isInteger(rounds) || rounds < 0 || rounds > 100) throw new HttpError(400, "轮次须为 0–100 的整数，0 表示不限");
  const count = await opinion_count(database, room_id, room.experts);
  const limits = limit_values({ max_rounds: rounds, max_minutes: payload.max_minutes ?? room.limits.max_minutes }, room.limits);
  await checked_batch(database, fence, [room_id, room.limits.revision, room_id], [
    database.prepare("UPDATE round_budgets SET base=?,cap=0,extra=0 WHERE room_id=?").bind(count, room_id),
    database.prepare("UPDATE discussion_limits SET max_rounds=?,max_minutes=?,started_at=0,stop_reason='',revision=revision+1 WHERE room_id=?")
      .bind(limits.max_rounds, limits.max_minutes, room_id),
    database.prepare("UPDATE discussion_pauses SET paused_seconds=0,paused_at=0 WHERE room_id=?").bind(room_id),
    database.prepare("UPDATE topic_settings SET phase='paused' WHERE room_id=?").bind(room_id)]);
  return require_room(database, room_id);
}

/** End the discussion at a reached boundary (or once the host declares the goal done); the room returns to free collaboration. */
async function check_limits(database, room_id, payload) {
  const action = payload.action ?? "check";
  if (!["check", "done", "reopen"].includes(action)) throw new HttpError(400, "action 须为 check/done/reopen");
  if (action === "reopen") return reopen_limits(database, room_id, payload);
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const limits = room.limits;
  const done = action === "done";
  const inactive = room.mode === "free" || ["paused", "concluded"].includes(room.phase) || room.archived || (done && room.phase === "preparing");
  if ((!limits.reached && !done) || inactive) return room;
  if (done) await require_conclusion_ready(database, room, payload, true);
  const reason = done ? "goal_done" : limits.reason || "user_stop";
  const held = await held_user_messages(database, room);
  // The run's generation moves on, so the old execution is superseded; unnamed messages now go to the host as usual.
  await checked_batch(database, `EXISTS(SELECT 1 FROM discussion_limits WHERE room_id=? AND revision=?)
    AND EXISTS(SELECT 1 FROM topic_settings WHERE room_id=? AND phase=? AND host=? AND json(experts)=json(?))
    AND COALESCE((SELECT MAX(id) FROM messages WHERE room_id=?),0)=?`,
    [room_id, limits.revision, room_id, room.phase, room.host, JSON.stringify(room.experts), room_id, room.latest_id],
    [database.prepare("UPDATE discussion_limits SET stop_reason=?,revision=revision+1 WHERE room_id=?").bind(reason, room_id),
      ...return_to_free_statements(database, room_id)]);
  await route_held_messages(database, room_id, held);
  return require_room(database, room_id);
}

/** Expose mode and actual lifecycle without exposing capability hashes. */
async function runtime_view(database, room_id) {
  const row = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  if (!row) return { mode: "manual", status: "ready", revision: 0, protected: false };
  const { control_hash, ...visible } = row;
  const latest_execution = await database.prepare("SELECT id,participant,role,status,result FROM discussion_events WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first();
  const participants = await participant_executions(database, room_id);
  const failures = await failed_executions(database, room_id);
  const timings = await execution_timings(database, room_id, row.run_id);
  return { ...visible, latest_execution, participants, failures, timings, protected: true, expired: row.status === "running" && row.deadline > 0 && row.deadline <= Math.floor(Date.now() / 1000) };
}

/** Keep failed attempts readable after a retry, without exposing execution credentials. */
async function failed_executions(database, room_id) {
  const { results } = await database.prepare(`SELECT e.id,e.participant,e.role,e.turn_id,
    e.result,e.created_at,CASE WHEN t.dispatched_at>0 AND t.finished_at>0
    THEN MAX(0,t.finished_at-t.dispatched_at) END AS elapsed_seconds
    FROM discussion_events AS e LEFT JOIN event_timings AS t ON t.event_id=e.id
    WHERE e.room_id=? AND e.status='failed' ORDER BY e.id`).bind(room_id).all();
  return results;
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

/** Use the same message attribution defaults as persisted message details. */
function write_actor(operation, payload) {
  return operation === "messages" ? payload.submitted_by ?? (["cli", "api"].includes(payload.source) ? payload.author : "用户") : payload.actor ?? "用户";
}

/** Limit authenticated participants to their own identity and assigned host duties. */
async function authorize_participant(database, room_id, identity, operation, payload) {
  const actor = write_actor(operation, payload);
  if (actor !== identity.name) throw new HttpError(403, "凭据与实际参与身份不符");
  if (operation === "messages") {
    const online = await database.prepare("SELECT 1 FROM room_members WHERE room_id=? AND name=? AND access='online' AND status='active'").bind(room_id, payload.author ?? "").first();
    if (payload.author !== actor && !(online && ["owner", "host"].includes(identity.role))) throw new HttpError(403, "只能提交本人观点，或由房主、主持人代发在线成员原文");
  } else if (operation !== "attachments" && identity.role !== "owner") {
    if (identity.role !== "host" || !["topic", "state", "turns", "limits"].includes(operation)) throw new HttpError(403, "本成员没有此管理权限");
    if (operation === "topic") {
      if (["host", "experts", "members"].some(field => Object.hasOwn(payload, field))) throw new HttpError(403, "只有房主可以修改成员和主持人");
    }
  }
}

/** Scope ordinary writes to their room owner, manual member or current execution identity. */
async function authorize_database(database, room_id, token, operation, payload) {
  const hashed = await runtime_hash(token);
  const run = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  const owner = hashed && await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?").bind(room_id, hashed).first();
  if (owner) {
    await authorize_participant(database, room_id, { name: "用户", role: "owner" }, operation, payload);
    const proxy = operation === "messages" && payload.author !== "用户";
    return guarded_database(database, "EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)"
      + (proxy ? " AND EXISTS(SELECT 1 FROM room_members WHERE room_id=? AND name=? AND access='online' AND status='active')" : ""),
    [room_id, hashed, ...(proxy ? [room_id, payload.author] : [])]);
  }
  const member = hashed && await database.prepare("SELECT * FROM room_members WHERE room_id=? AND token_hash=? AND status='active' AND access<>'online'").bind(room_id, hashed).first();
  if (member && (!run || run.mode === "manual" || member.access === "manual")) {
    await authorize_participant(database, room_id, member, operation, payload);
    const proxy = operation === "messages" && payload.author !== member.name;
    // A manual member keeps its own credential even while the local service wakes the others.
    const woken_run = member.access !== "manual";
    return guarded_database(database, `EXISTS(SELECT 1 FROM room_members WHERE id=? AND token_hash=? AND status='active' AND role=? AND access<>'online')`
      + (woken_run ? " AND NOT EXISTS(SELECT 1 FROM discussion_runtime WHERE room_id=? AND mode='automatic')" : "")
      + (proxy ? " AND EXISTS(SELECT 1 FROM room_members WHERE room_id=? AND name=? AND access='online' AND status='active')" : ""),
    [member.id, hashed, member.role, ...(woken_run ? [room_id] : []), ...(proxy ? [room_id, payload.author] : [])]);
  }
  throw new HttpError(403, "需要房主或本成员的有效凭据；旧讨论执行凭据已停用");
}

/** Select only public event fields. */
function public_event(event) {
  const fields = ["id", "room_id", "run_id", "generation", "cause", "participant", "role", "turn_id", "status", "session_id", "lease_until", "result", "created_at"];
  return Object.fromEntries(fields.map(key => [key, event[key]]));
}

/** Read a legacy event without allowing it to resume the retired runtime. */
async function legacy_event_view(database, room_id, event_id, token, payload) {
  if (payload.action !== "view") throw new HttpError(400, "旧讨论执行仅保留历史读取");
  const event = await database.prepare("SELECT * FROM discussion_events WHERE room_id=? AND id=?").bind(room_id, event_id).first();
  if (!event) throw new HttpError(404, "执行不存在");
  const run = await database.prepare("SELECT * FROM discussion_runtime WHERE room_id=?").bind(room_id).first();
  const hashed = await runtime_hash(token);
  const controller = hashed && hashed === run?.control_hash;
  if (!controller && (!hashed || hashed !== event.token_hash)) throw new HttpError(403, "执行凭据无效");
  return public_event(event);
}

/** Handle runtime requests without exposing owner or execution hashes. */
async function handle_runtime_api(database, request, parts, params) {
  const room_id = parts[2];
  await require_room_id(database, room_id);
  const token = request.headers.get("X-Discussion-Token") ?? "";
  if (parts.length === 4 && parts[3] === "runtime" && request.method === "GET") return respond(await runtime_view(database, room_id));
  if (parts.length === 5 && parts[3] === "events" && request.method === "POST") return respond(
    await legacy_event_view(database, room_id, integer(parts[4]), token, await read_payload(request)));
  if (parts.length === 4 && parts[3] === "events" && request.method === "GET") {
    const control = await database.prepare("SELECT 1 FROM discussion_runtime WHERE room_id=? AND control_hash=?").bind(room_id, await runtime_hash(token)).first();
    if (!control) throw new HttpError(403, "需要本房间的运行控制凭据");
    const after = Math.max(0, integer(params.after ?? 0));
    const rows = await database.prepare("SELECT * FROM discussion_events WHERE room_id=? AND id>? ORDER BY id LIMIT 100").bind(room_id, after).all();
    const events = rows.results.map(public_event);
    return respond({ events, next_after: events.at(-1)?.id ?? after });
  }
  if (parts.length === 4 && parts[3] === "scheduler-decisions" && request.method === "POST") {
    return respond(await record_scheduler_decision(database, room_id, token, await read_payload(request), await room_mode(database, room_id) === "free"));
  }
  if (parts.length === 4 && parts[3] === "scheduler-routing" && request.method === "POST") {
    return respond(await mark_scheduler_routing(database, room_id, token, await read_payload(request)));
  }
  if (parts.length === 5 && parts[3] === "scheduler-decisions" && request.method === "POST") {
    return respond(await rate_scheduler_decision(database, room_id, integer(parts[4]), token, await read_payload(request)));
  }
  throw new HttpError(404, "地址不存在");
}

/** The owner marks a decision good or bad; rating null withdraws the verdict. */
async function rate_scheduler_decision(database, room_id, decision_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const { rating = null, should_be = "", note = "" } = payload;
  if (!["good", "bad", null].includes(rating)) throw new HttpError(400, "rating 须为 good、bad 或 null");
  if (typeof should_be !== "string" || typeof note !== "string" || should_be.length > MAX_DECISION_MEMBER || note.trim().length > MAX_DECISION_NOTE) {
    throw new HttpError(400, `should_be 须为成员名，note 不超过 ${MAX_DECISION_NOTE} 字`);
  }
  if (!await database.prepare("SELECT 1 FROM scheduler_decisions WHERE id=? AND room_id=?").bind(decision_id, room_id).first()) throw new HttpError(404, "没有这条智能调度决策");
  if (rating === null) await database.prepare("DELETE FROM scheduler_feedback WHERE decision_id=?").bind(decision_id).run();
  else await database.prepare(`INSERT INTO scheduler_feedback (decision_id,rating,should_be,note,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(decision_id) DO UPDATE SET rating=excluded.rating,should_be=excluded.should_be,note=excluded.note,created_at=excluded.created_at`)
    .bind(decision_id, rating, should_be.trim(), note.trim(), new Date().toISOString()).run();
  if (rating === "bad") await save_feedback_case(database, room_id, decision_id, should_be.trim(), note.trim());
  else await database.prepare("DELETE FROM scheduler_feedback_cases WHERE decision_id=?").bind(decision_id).run();
  return { decision_id, feedback: rating, should_be: should_be.trim(), note: note.trim() };
}

/** Copy a bad-rated decision with everything the model saw, so it outlives its room for prompt review. */
async function save_feedback_case(database, room_id, decision_id, should_be, note) {
  const decision = await database.prepare(`${DECISION_SELECT} WHERE d.id=?`).bind(decision_id).first();
  const detail = await database.prepare("SELECT detail FROM scheduler_decision_details WHERE decision_id=?").bind(decision_id).first();
  const input = await database.prepare("SELECT input FROM scheduler_decision_inputs WHERE decision_id=?").bind(decision_id).first();
  const room = await database.prepare("SELECT title FROM rooms WHERE id=?").bind(room_id).first();
  const { kind, after_message_id, label, confidence, applied, provider, created_at } = decision;
  const snapshot = { kind, after_message_id, label, confidence, applied, provider, created_at, context: decision.context ? JSON.parse(decision.context) : null,
    detail: detail ? JSON.parse(detail.detail) : null, input: input ? JSON.parse(input.input) : null };
  await database.prepare(`INSERT OR REPLACE INTO scheduler_feedback_cases (decision_id,room_id,room_title,snapshot,should_be,note,rated_at)
    VALUES (?,?,?,?,?,?,?)`).bind(decision_id, room_id, room.title, JSON.stringify(snapshot), should_be, note, new Date().toISOString()).run();
}

/** Bad-rated decision snapshots after a decision id, oldest first, for the administrator's prompt review. */
async function list_feedback_cases(database, after) {
  const { results } = await database.prepare("SELECT * FROM scheduler_feedback_cases WHERE decision_id>? ORDER BY decision_id LIMIT ?")
    .bind(after, FEEDBACK_CASES_PAGE).all();
  const cases = results.map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
  return { cases, next_after: cases.length === FEEDBACK_CASES_PAGE ? cases.at(-1).decision_id : null };
}

/** The local service marks a message while the decision model is analysing it, and clears the mark when done. */
async function mark_scheduler_routing(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const { message_id, active } = payload;
  if (!Number.isInteger(message_id) || message_id <= 0 || typeof active !== "boolean") throw new HttpError(400, "须提供正整数 message_id 与布尔 active");
  if (active) await database.prepare("INSERT OR REPLACE INTO scheduler_routing (room_id,message_id,created_at) VALUES (?,?,?)").bind(room_id, message_id, Math.floor(Date.now() / 1000)).run();
  else await database.prepare("DELETE FROM scheduler_routing WHERE room_id=? AND message_id=?").bind(room_id, message_id).run();
  return { message_id, active };
}

/** The dispatcher records one smart-scheduling decision so the transcript shows what it did and how sure it was.
 *  A free room has no run control: its local service records with the owner credential. */
async function record_scheduler_decision(database, room_id, token, payload, owner = false) {
  if (owner) await require_free_owner(database, room_id, token);
  else if (!await database.prepare("SELECT 1 FROM discussion_runtime WHERE room_id=? AND control_hash=?").bind(room_id, await runtime_hash(token)).first()) {
    throw new HttpError(403, "需要本房间的运行控制凭据");
  }
  const { kind, label, confidence = null, applied, provider } = payload;
  const after = payload.after_message_id ?? 0;
  if (!["interjection", "round"].includes(kind) || typeof label !== "string" || !label.trim() || label.trim().length > MAX_DECISION_LABEL) {
    throw new HttpError(400, `决策记录须有 kind（interjection/round）与 1–${MAX_DECISION_LABEL} 字的 label`);
  }
  if (confidence !== null && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1))) throw new HttpError(400, "confidence 须为 0–1 或 null");
  if (!["jev", "decisions"].includes(provider) || typeof applied !== "boolean" || !Number.isInteger(after) || after < 0) {
    throw new HttpError(400, "须提供供应商 provider、是否执行 applied 与非负的 after_message_id");
  }
  const { detail } = payload;
  const detail_text = detail === undefined || detail === null ? null : JSON.stringify(detail);
  if (detail_text !== null && (!Array.isArray(detail) || detail.length > 4 || detail_text.length > MAX_DECISION_DETAIL)) {
    throw new HttpError(400, `detail 须为最多 4 项、不超过 ${MAX_DECISION_DETAIL} 字的列表`);
  }
  const { context } = payload;
  const context_text = context === undefined || context === null ? null : JSON.stringify(context);
  if (context_text !== null && (typeof context !== "object" || Array.isArray(context) || context_text.length > MAX_DECISION_CONTEXT)) {
    throw new HttpError(400, `context 须为不超过 ${MAX_DECISION_CONTEXT} 字的对象`);
  }
  const { input } = payload;
  const input_text = input === undefined || input === null ? null : JSON.stringify(input);
  if (input_text !== null && (typeof input !== "object" || Array.isArray(input) || input_text.length > MAX_DECISION_INPUT)) {
    throw new HttpError(400, `input 须为不超过 ${MAX_DECISION_INPUT} 字的对象`);
  }
  const row = await database.prepare(`INSERT INTO scheduler_decisions (room_id,after_message_id,kind,label,confidence,applied,provider,created_at)
    VALUES (?,?,?,?,?,?,?,?) RETURNING *`).bind(room_id, after, kind, label.trim(), confidence, Number(applied), provider, new Date().toISOString()).first();
  if (detail_text !== null) await database.prepare("INSERT INTO scheduler_decision_details (decision_id,detail) VALUES (?,?)").bind(row.id, detail_text).run();
  if (context_text !== null) await database.prepare("INSERT INTO scheduler_decision_context (decision_id,context) VALUES (?,?)").bind(row.id, context_text).run();
  if (input_text !== null) await database.prepare("INSERT INTO scheduler_decision_inputs (decision_id,input) VALUES (?,?)").bind(row.id, input_text).run();
  return row;
}

// Free collaboration rooms: the D1 counterpart of backend/free_room.py. Rooms without a
// room_modes row are brainstorm rooms and never reach this section.
const FREE_EXECUTION_MINUTES = 20;
const FREE_LEASE_SECONDS = 120;
const FREE_RECENT_REQUESTS = 100;
const FREE_RECENT_CHANGES = 50;
const FREE_MAX_CHANGED_FILES = 200;
const FREE_MAX_PATH = 500;
// Refused operations one execution may report, and the length of each field.
const FREE_MAX_DENIALS = 20;
const FREE_MAX_DENIAL_FIELD = 300;
// A manual member's delivery is retried at most this often before the execution fails.
const FREE_MAX_RETRIES = 3;
const FREE_MAX_RETRY_REASON = 500;
// What the runner reported about a waiting retry of one execution, or null.
const FREE_RETRY_SQL = (alias) => `(SELECT json_object('attempt',attempt,'retry_at',retry_at,'reason',reason,'stopped',stopped) FROM execution_retries WHERE execution_id=${alias}.id) AS retry`;
// What a member's software last showed it doing, as reported by the runner with each renewal.
const FREE_ACTIVITY_PHASES = ["", "thinking", "command", "tool", "editing", "writing"];
// Progress notes per execution, their length, and how many one renewal may carry.
const FREE_MAX_EXECUTION_NOTES = 50;
const FREE_MAX_NOTE_LENGTH = 500;
const FREE_MAX_NOTES_PER_RENEW = 10;
// Phase segments the runner reports for the execution timeline: the phases, how many one execution keeps and one report
// carries, a tool name's length, and how long after its end an execution still takes its last report.
const SEGMENT_PHASES = ["thinking", "command", "tool", "editing", "writing"];
const MAX_EXECUTION_SEGMENTS = 400;
const MAX_SEGMENTS_PER_REPORT = 40;
const MAX_SEGMENT_TOOL = 60;
const SEGMENT_GRACE_SECONDS = 600;
// The timeline page reads this many recent executions of each kind; with `after` (?3) only those running or ended since.
// Parameters: ?1 room, ?2 limit, ?3 after (0 reads all). Shared verbatim with the Python service.
const TIMELINE_EXECUTIONS = 100;
const TIMELINE_STATES = { completed: "done", failed: "failed", cancelled: "cancelled" };
const TIMELINE_FREE_IDS = "SELECT id FROM member_executions WHERE room_id=?1 AND (?3=0 OR finished_at=0 OR finished_at>=?3) ORDER BY id DESC LIMIT ?2";
const TIMELINE_DISCUSSION_IDS = `SELECT e.id FROM discussion_events e LEFT JOIN event_timings t ON t.event_id=e.id
    WHERE e.room_id=?1 AND (t.dispatched_at>0 OR e.status='pending') AND (?3=0 OR COALESCE(t.finished_at,0)=0 OR t.finished_at>=?3)
    ORDER BY e.id DESC LIMIT ?2`;
// Besides times: the task an execution took on (its request message, or the discussion turn's question), its result
// (the answer's summary, else the answer's opening), its latest progress note, how many files it changed (NULL when
// unobserved), its last output time (free executions only) and the discussion run it belongs to (discussion only).
const TIMELINE_SQL = `SELECT x.*,(SELECT COALESCE(NULLIF(s.text,''),substr(a.text,1,200)) FROM messages a
        LEFT JOIN message_summaries s ON s.message_id=a.id WHERE a.id=x.answer_id) AS result FROM (
    SELECT 'free' AS source,e.id,m.name AS member,m.role,e.status,
        COALESCE((SELECT MIN(r.created_at) FROM member_requests r WHERE r.execution_id=e.id),e.created_at) AS queued_at,
        e.created_at AS dispatched_at,0 AS started_at,e.finished_at,
        CASE WHEN e.status='failed' THEN e.result ELSE '' END AS reason,
        (SELECT parent.execution_id FROM member_requests r JOIN member_requests parent ON parent.answer_id=r.message_id
            WHERE r.execution_id=e.id AND parent.execution_id IS NOT NULL ORDER BY r.id LIMIT 1) AS parent_id,
        e.activity_at,(SELECT MIN(r.message_id) FROM member_requests r WHERE r.execution_id=e.id
          AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=r.message_id)) AS task_id,
        (SELECT substr(q.text,1,160) FROM messages q WHERE q.id=(SELECT MIN(r.message_id) FROM member_requests r WHERE r.execution_id=e.id
          AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=r.message_id))) AS task,
        (SELECT MAX(r.answer_id) FROM member_requests r WHERE r.execution_id=e.id) AS answer_id,
        (SELECT n.text FROM execution_notes n WHERE n.execution_id=e.id ORDER BY n.seq DESC LIMIT 1) AS last_note,
        CASE WHEN e.changes='' THEN NULL ELSE json_array_length(e.changes) END AS changes,NULL AS run_id
    FROM member_executions e JOIN room_members m ON m.id=e.member_id WHERE e.id IN (${TIMELINE_FREE_IDS})
    UNION ALL SELECT 'discussion',e.id,e.participant,e.role,e.status,CAST(strftime('%s',e.created_at) AS INTEGER),
        COALESCE(t.dispatched_at,0),e.started_at,COALESCE(t.finished_at,0),CASE WHEN e.status='failed' THEN e.result ELSE '' END,NULL,
        0,NULL,(SELECT substr(q.question,1,160) FROM discussion_turns q WHERE q.id=e.turn_id),
        CASE WHEN e.result LIKE 'message:%' THEN CAST(substr(e.result,9) AS INTEGER) END,NULL,NULL,e.run_id
    FROM discussion_events e LEFT JOIN event_timings t ON t.event_id=e.id WHERE e.id IN (${TIMELINE_DISCUSSION_IDS})) x`;
const TIMELINE_SEGMENTS_SQL = `SELECT source,execution_id,phase,tool,start_ms,end_ms FROM execution_segments WHERE room_id=?1 AND (
    (source='free' AND execution_id IN (${TIMELINE_FREE_IDS})) OR (source='discussion' AND execution_id IN (${TIMELINE_DISCUSSION_IDS})))
    ORDER BY source,execution_id,seq`;
// Only the times of progress notes: the texts are read when the reader hovers one.
const TIMELINE_NOTES_SQL = `SELECT execution_id,created_at FROM execution_notes
    WHERE room_id=?1 AND execution_id IN (${TIMELINE_FREE_IDS}) ORDER BY execution_id,seq`;
// A member description is a short note for the scheduler and the host, keyed by the member's name.
const MAX_MEMBER_DESCRIPTION = 500;
// A display label replaces the member's name on screen only; the name stays the member's identity everywhere else.
const MAX_MEMBER_LABEL = 32;
const MAX_MEMBER_NAME = 80;
const FREE_LIVE = "status IN ('dispatched','started')";
// Rounds a host may run from one owner message by default (a round: one host dispatch, its members' answers and the
// hand-back); each owner message starts a chain. Counted in rounds, so a room with more members gets no fewer of them.
const FREE_CHAIN_ROUNDS = 3;
// The most rounds an owner may allow per chain, or add at once when continuing a stopped chain.
const FREE_MAX_CHAIN_ROUNDS = 20;
// A room's round limit: the owner's setting, else the default.
const FREE_ROUND_LIMIT = (room) => `COALESCE((SELECT max_rounds FROM free_round_limits l WHERE l.room_id=${room}), ${FREE_CHAIN_ROUNDS})`;
// Rounds used and allowed in the room's recent chains, for "第 2/3 轮"; parameter: the room.
const FREE_CHAIN_PROGRESS = `SELECT b.chain_id,COUNT(*) AS used,${FREE_ROUND_LIMIT("b.room_id")} + COALESCE((SELECT h.extra_rounds FROM free_chain_holds h
    WHERE h.room_id=b.room_id AND h.chain_id=b.chain_id),0) AS allowed FROM free_batches b WHERE b.room_id=?
    GROUP BY b.chain_id ORDER BY b.chain_id DESC LIMIT 10`;
const FREE_SCHEDULER_PROVIDERS = ["jev", "decisions"];
const FREE_RECOMMEND_SECONDS = 60;
// A click sent just before the hint disappears still counts.
const FREE_RECOMMEND_GRACE_SECONDS = 5;
const FREE_BATCH_DONE = "NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.room_id=b.room_id AND r.batch_id=b.batch_id AND r.status NOT IN ('completed','cancelled','failed'))";
// A finished batch goes back to its host when it had several members or the host asked for its one member back.
const FREE_BATCH_RETURNS = "((SELECT COUNT(*) FROM member_requests q WHERE q.room_id=b.room_id AND q.batch_id=b.batch_id)>=2 OR EXISTS(SELECT 1 FROM free_handoffs h WHERE h.room_id=b.room_id AND h.batch_id=b.batch_id))";
const FREE_BATCH_ANSWERED = "EXISTS(SELECT 1 FROM member_requests r WHERE r.room_id=b.room_id AND r.batch_id=b.batch_id AND r.status='completed')";
// Ordering and filing a channel only rearrange the shared directory, like folder edits, so they need no room credential.
const DIRECTORY_OPERATIONS = ["move", "folder"];
const FREE_OPERATIONS = ["messages", "attachments", "move", "folder", "rename", "archive", "restore", "delete"];
const FREE_MEMBER_FIELDS = ["id", "name", "adapter", "role", "status", "access", "manual_source", "session_mode", "read_until"];
const FREE_EXECUTION_FIELDS = ["id", "member_id", "status", "session_id", "lease_until", "created_at", "finished_at", "result",
  "activity", "activity_at"];
const FREE_RECENT_EXECUTIONS = 100;
// Only free rooms carry these tables; credential hashes are never exported.
const FREE_BACKUP_QUERIES = {
  room_modes: "SELECT room_id,mode FROM room_modes WHERE room_id=?",
  room_members: "SELECT id,room_id,name,adapter,role,status,read_until,created_at,access,session_mode FROM room_members WHERE room_id=? ORDER BY id",
  member_requests: "SELECT id,room_id,member_id,message_id,status,answer_id,created_at,chain_id,batch_id,purpose,created_by,execution_id FROM member_requests WHERE room_id=? ORDER BY id",
  member_suggestions: "SELECT s.* FROM member_suggestions s JOIN messages m ON m.id=s.message_id WHERE m.room_id=? ORDER BY s.message_id,s.member_id",
  member_recommendations: "SELECT * FROM member_recommendations WHERE room_id=? ORDER BY message_id",
};

/** Return 'free' for free rooms; every legacy room is a brainstorm room. */
async function room_mode(database, room_id) {
  return (await database.prepare("SELECT mode FROM room_modes WHERE room_id=?").bind(room_id).first())?.mode ?? "brainstorm";
}

/** Copy only the named fields of a row. */
function pick(row, fields) {
  return row ? Object.fromEntries(fields.map(field => [field, row[field]])) : null;
}

/** Validate one member and hash its client-generated credential. */
async function free_member_value(member) {
  if (!member || typeof member !== "object" || !is_ai(member.name)) throw new HttpError(400, "成员须为有效 AI 身份");
  const token_hash = await runtime_hash(member.token);
  if (!token_hash) throw new HttpError(400, "每位成员须提供 32–256 字符的成员凭证");
  const adapter = member.adapter ?? "";
  if (typeof adapter !== "string" || adapter.length > 40) throw new HttpError(400, "成员适配器名称无效");
  const requested_access = member.access ?? "runner", session_mode = member.session_mode ?? "new";
  const access = requested_access === "online" ? "manual" : requested_access;
  const manual_source = requested_access === "online" ? "web" : (member.manual_source === "web" ? "web" : "");
  if (!["runner", "manual", "online"].includes(access) || !["new", "borrowed"].includes(session_mode)) {
    throw new HttpError(400, "成员接入方式须为 runner/manual/online，会话方式须为 new/borrowed");
  }
  return { name: member.name, adapter, token_hash, access, manual_source, session_mode };
}

/** Validate the initial members of a new free room. */
async function free_member_values(members) {
  if (!Array.isArray(members) || members.length > MAX_ROOM_AGENTS) throw new HttpError(400, "自由房间成员须为列表，且不超过成员上限");
  const result = await Promise.all(members.map(free_member_value));
  if (new Set(result.map(member => member.name)).size !== result.length) throw new HttpError(400, "成员名称不能重复");
  if (new Set(result.map(member => member.token_hash)).size !== result.length) throw new HttpError(400, "每位成员须使用独立凭证");
  return result;
}

/** Online experts stay online; a woken discussion also takes manual experts, but never a manual host. */
function discussion_access_ok(access, capability, automatic, is_host) {
  if (capability === "online") return access === "manual";
  if (!automatic) return access === "manual";
  return access === "runner" || (access === "manual" && !is_host);
}

/** A manual expert of a woken discussion carries adapter "manual", so mode switches never turn it into a woken member. */
function mark_manual(member, automatic) {
  return automatic && member.access === "manual" ? { ...member, adapter: "manual" } : member;
}

/** Bind credentials to the declared participant list and delivery mode. */
async function discussion_members(payload, settings) {
  const members = Object.keys(settings.experts).length ? await free_member_values(payload.members) : [];
  if (members.length !== Object.keys(settings.experts).length || members.some(member => !Object.hasOwn(settings.experts, member.name))) {
    throw new HttpError(400, "成员凭证名单须与参与者名单一致");
  }
  for (const member of members) {
    if (!discussion_access_ok(member.access, settings.experts[member.name], payload.runtime_mode === "automatic", member.name === settings.host)) throw new HttpError(400, "成员接入方式与房间参与能力、任务交付方式不符");
  }
  return members.map(member => mark_manual(member, payload.runtime_mode === "automatic"));
}

/** Preserve unchanged credentials and revoke removed or changed identities atomically. */
async function discussion_member_statements(database, room_id, payload, settings) {
  const rows = (await database.prepare("SELECT * FROM room_members WHERE room_id=? AND status='active'").bind(room_id).all()).results;
  const current = Object.fromEntries(rows.map(row => [row.name, row]));
  const supplied = Object.fromEntries(await Promise.all((payload.members ?? []).map(async member => [member.name, await free_member_value(member)])));
  const run = await runtime_view(database, room_id), statements = [];
  for (const [name, capability] of Object.entries(settings.experts)) {
      if (current[name] && (current[name].access === "online" || current[name].manual_source === "web") === (capability === "online")) {
      if (supplied[name] && supplied[name].token_hash !== current[name].token_hash) throw new HttpError(409, "成员凭证与已登记身份不符；请核对原接入文件");
      continue;
    }
    const member = supplied[name] && mark_manual(supplied[name], run.mode === "automatic");
    if (!member || !discussion_access_ok(member.access, capability, run.mode === "automatic", name === settings.host)) throw new HttpError(400, `新增或改变接入方式的成员 ${name} 须提供独立的新凭证`);
    const reused = await database.prepare("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?")
      .bind(room_id, member.token_hash, room_id, member.token_hash).first();
    if (reused || Object.values(supplied).filter(item => item.token_hash === member.token_hash).length > 1) throw new HttpError(400, "新成员凭证不能复用已有凭证");
    statements.push(database.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?").bind(room_id, name),
      ...free_member_statements(database, room_id, member));
  }
  for (const name of Object.keys(current).filter(name => !Object.hasOwn(settings.experts, name))) statements.push(
    database.prepare("UPDATE room_members SET status='removed' WHERE room_id=? AND name=?").bind(room_id, name));
  statements.push(database.prepare("UPDATE room_members SET role=CASE WHEN name=? THEN 'host' ELSE 'member' END WHERE room_id=?").bind(settings.host, room_id));
  return statements;
}

/** Prepare one member insert that stores only the credential hash. */
function free_member_insert(database, room_id, member) {
  return database.prepare(`INSERT INTO room_members (room_id,name,adapter,token_hash,access,session_mode,created_at)
    VALUES (?,?,?,?,?,?,?)`).bind(room_id, member.name, member.adapter, member.token_hash, member.access, member.session_mode, new Date().toISOString());
}

function free_member_statements(database, room_id, member) {
  return [free_member_insert(database, room_id, member), ...(member.manual_source === "web"
    ? [database.prepare(`INSERT INTO member_manual_sources(member_id,source)
      SELECT id,'web' FROM room_members WHERE room_id=? AND name=? ORDER BY id DESC LIMIT 1`).bind(room_id, member.name)] : [])];
}

/** Keep one active AI host, then mirror non-removed members into the participant list the page already shows.
 * The user is the client of a free room, never its host; a host that left gives up the role and the first
 * active runner member (else manual) takes it. Only a room of online members has no host. */
function free_participant_statements(database, room_id) {
  return [database.prepare("UPDATE room_members SET role='member' WHERE room_id=? AND role='host' AND status<>'active'").bind(room_id),
    database.prepare(`UPDATE room_members SET role='host' WHERE id=(SELECT id FROM room_members WHERE room_id=? AND status='active'
      AND access<>'online' AND NOT EXISTS(SELECT 1 FROM member_manual_sources WHERE member_id=room_members.id)
      ORDER BY access='runner' DESC, id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_id=? AND role='host' AND status='active')`).bind(room_id, room_id),
    database.prepare(`UPDATE topic_settings SET experts=(SELECT COALESCE(json_group_object(name,CASE WHEN access='online' OR source='web' THEN 'online' ELSE 'cli' END),'{}')
    FROM (SELECT m.name,m.access,src.source FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
      WHERE m.room_id=? AND m.status<>'removed' ORDER BY m.id)),
    host=COALESCE((SELECT name FROM room_members WHERE room_id=? AND role='host' AND status='active' LIMIT 1),'用户')
    WHERE room_id=?`).bind(room_id, room_id, room_id)];
}

/** Free rooms always bound one execution; zero in the shared limits means the default. */
async function free_execution_minutes(database, room_id) {
  const session = await latest_session(database, room_id);
  if (session) {
    const session_limit = await database.prepare("SELECT execution_minutes FROM session_limits WHERE session_id=?").bind(session.id).first();
    if (session_limit) return session_limit.execution_minutes || FREE_EXECUTION_MINUTES;
  }
  const row = await database.prepare("SELECT execution_minutes FROM discussion_limits WHERE room_id=?").bind(room_id).first();
  return row?.execution_minutes || FREE_EXECUTION_MINUTES;
}

/** Files changed by executions of different members in one cwd whose time windows overlapped. */
async function free_conflicts(database, room_id, names) {
  const now = Math.floor(Date.now() / 1000);
  const rows = (await database.prepare(`SELECT id,member_id,created_at,finished_at,changes,cwd FROM member_executions
    WHERE room_id=? AND changes<>'' ORDER BY id DESC LIMIT ?`).bind(room_id, FREE_RECENT_CHANGES).all()).results
    .map(row => ({ ...row, files: new Set(JSON.parse(row.changes)), end: row.finished_at || now }));
  const conflicts = [];
  rows.forEach((first, index) => {
    for (const second of rows.slice(index + 1)) {
      if (first.member_id === second.member_id || first.cwd !== second.cwd) continue;
      if (first.created_at > second.end || second.created_at > first.end) continue;
      const files = [...first.files].filter(file => second.files.has(file)).sort();
      if (files.length) conflicts.push({ members: [names[second.member_id] ?? "", names[first.member_id] ?? ""], executions: [second.id, first.id], files });
    }
  });
  return conflicts;
}

/** Bounded public reports with their full request associations, never credential material. */
async function free_recent_executions(database, room_id) {
  const rows = (await database.prepare(`SELECT e.*,
    m.name AS member,
    (SELECT json_group_array(id) FROM member_requests WHERE execution_id=e.id) AS request_ids,
    (SELECT MAX(answer_id) FROM member_requests WHERE execution_id=e.id) AS answer_id,
    (SELECT MIN(message_id) FROM member_requests WHERE execution_id=e.id) AS request_message_id,
    (SELECT COUNT(*) FROM execution_notes WHERE execution_id=e.id) AS note_count,
    (SELECT denials FROM execution_denials WHERE execution_id=e.id) AS denials,${FREE_RETRY_SQL("e")}
    FROM member_executions e JOIN room_members m ON m.id=e.member_id WHERE e.room_id=? ORDER BY e.id DESC LIMIT ?`).bind(room_id, FREE_RECENT_EXECUTIONS).all()).results;
  return Promise.all(rows.map(async row => {
    const requests = (await database.prepare("SELECT id,message_id,status,purpose,answer_id FROM member_requests WHERE execution_id=? ORDER BY id")
      .bind(row.id).all()).results;
    const sourced = await Promise.all(requests.map(async request => ({ ...request, ...await free_request_source(database, request.id, request.message_id) })));
    return { ...pick(row, FREE_EXECUTION_FIELDS), member: row.member, cwd: row.cwd, changes: JSON.parse(row.changes || '[]'),
      changes_recorded: Boolean(row.changes), request_ids: JSON.parse(row.request_ids),
      answer_id: row.answer_id, request_message_id: row.request_message_id, requests: sourced, notes: row.note_count,
      denials: JSON.parse(row.denials || "[]"), retry: JSON.parse(row.retry || "null") };
  }));
}

/** Remove request and answer anchors that follow the initial-session reading boundary. */
function limit_free_execution(execution, read_limit) {
  const source_id = execution.request_message_id ?? execution.message_id;
  const hidden_request = source_id !== undefined && source_id !== null && source_id > read_limit;
  const hidden_answer = execution.answer_id !== undefined && execution.answer_id !== null && execution.answer_id > read_limit;
  return { ...execution, message_id: hidden_request ? null : execution.message_id,
    request_message_id: hidden_request ? null : execution.request_message_id,
    after_message_id: hidden_request ? null : execution.after_message_id,
    answer_id: hidden_answer ? null : execution.answer_id,
    result: (hidden_request && execution.status === "failed") || (hidden_answer && String(execution.result || "").startsWith("message:"))
      ? "" : execution.result,
    changes: hidden_answer ? [] : execution.changes,
    source_question: hidden_request ? "" : execution.source_question,
    source_message_id: execution.source_message_id > read_limit ? null : execution.source_message_id,
    cause_request_id: hidden_request ? null : execution.cause_request_id,
    requests: execution.requests?.map(request => {
      const hidden = request.message_id > read_limit;
      return { ...request, message_id: hidden ? null : request.message_id,
        answer_id: request.answer_id > read_limit ? null : request.answer_id,
        after_message_id: hidden ? null : request.after_message_id,
        source_question: hidden ? "" : request.source_question,
        source_message_id: request.source_message_id > read_limit ? null : request.source_message_id,
        cause_request_id: hidden ? null : request.cause_request_id };
    }) };
}

/** Expose request provenance without exposing its hidden system-task message as a transcript anchor. */
async function free_request_source(database, request_id, message_id) {
  const row = await database.prepare(`SELECT q.id AS session_request_id,q.session_id AS discussion_session_id,q.round,
    q.question AS source_question,t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id,
    CASE WHEN q.id IS NULL THEN r.message_id ELSE COALESCE((SELECT MAX(m.id) FROM messages m
      WHERE m.room_id=r.room_id AND m.id<r.message_id
        AND NOT EXISTS(SELECT 1 FROM task_message_sources hidden WHERE hidden.message_id=m.id)),0) END AS after_message_id
    FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id
    LEFT JOIN task_message_sources t ON t.session_request_id=q.id WHERE r.id=?`).bind(request_id).first();
  return row ? { session_request_id: row.session_request_id, discussion_session_id: row.discussion_session_id, round: row.round,
    source_question: row.source_question ?? "", source_message_id: row.source_message_id, cause_kind: row.cause_kind,
    cause_request_id: row.cause_request_id, after_message_id: row.after_message_id ?? message_id } : {};
}

/** Validate the operations a member's software refused: the tool, what it tried, and the rule that would allow it. */
function free_denied_actions(payload) {
  const denials = payload.denials;
  const valid = item => item && typeof item === "object" && typeof item.tool === "string" && item.tool.length > 0 && item.tool.length <= 40
    && ["detail", "rule"].every(key => typeof (item[key] ?? "") === "string" && (item[key] ?? "").length <= FREE_MAX_DENIAL_FIELD);
  if (!Array.isArray(denials) || !denials.length || denials.length > FREE_MAX_DENIALS || !denials.every(valid)) {
    throw new HttpError(400, `denials 须为 1–${FREE_MAX_DENIALS} 条 {tool, detail, rule}`);
  }
  return denials.map(item => ({ tool: item.tool, detail: item.detail ?? "", rule: item.rule ?? "" }));
}

/** Summarize members, recent requests and execution reports without credentials. */
/** Direct questions of a discussion room: recent requests with their member, for status badges beside messages. */
async function asks_view(database, room_id) {
  const names = Object.fromEntries((await database.prepare("SELECT id,name FROM room_members WHERE room_id=?").bind(room_id).all()).results.map(row => [row.id, row.name]));
  const requests = (await database.prepare(`SELECT id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose,created_by,created_at,
    (SELECT reason FROM request_cancel_reasons c WHERE c.request_id=member_requests.id) AS cancel_reason FROM member_requests
    WHERE room_id=? ORDER BY id DESC LIMIT ?`).bind(room_id, FREE_RECENT_REQUESTS).all()).results
    .map(async row => ({ ...row, member: names[row.member_id] ?? "", ...await free_request_source(database, row.id, row.message_id) }));
  const ordered_requests = (await Promise.all(requests)).reverse();
  return { requests, executions: await free_recent_executions(database, room_id), execution_minutes: await free_execution_minutes(database, room_id) };
}

async function free_view(database, room_id, token = "") {
  const now = Math.floor(Date.now() / 1000);
  const read_limit = await initial_session_read_limit(database, room_id, token);
  const rows = (await database.prepare("SELECT * FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id").bind(room_id).all()).results;
  const members = await Promise.all(rows.map(async row => {
    const latest = await database.prepare(`SELECT e.*,(SELECT MIN(message_id) FROM member_requests WHERE execution_id=e.id) AS request_message_id
      FROM member_executions e WHERE member_id=? ORDER BY id DESC LIMIT 1`).bind(row.id).first();
    let execution = pick(latest, FREE_EXECUTION_FIELDS);
    if (latest && ["dispatched", "started"].includes(latest.status)) {
      execution.stale = latest.lease_until <= now;
      execution.notes = (await database.prepare("SELECT COUNT(*) AS count FROM execution_notes WHERE execution_id=?").bind(latest.id).first()).count;
      execution.retry = await database.prepare("SELECT attempt,retry_at,reason,stopped FROM execution_retries WHERE execution_id=?").bind(latest.id).first() || null;
    }
    if (read_limit !== null && latest) {
      execution = limit_free_execution({ ...execution, request_message_id: latest.request_message_id,
        answer_id: latest?.result?.startsWith("message:") ? Number(latest.result.slice(8)) : null }, read_limit);
      delete execution.request_message_id;
    }
    const pending = (await database.prepare("SELECT COUNT(*) AS count FROM member_requests WHERE member_id=? AND status='pending'").bind(row.id).first()).count;
    const reported = await database.prepare("SELECT session_id,client FROM member_sessions WHERE member_id=?").bind(row.id).first();
    return { ...pick(row, FREE_MEMBER_FIELDS), registered_at: await registered_at(database, row),
      reported_session: reported?.session_id ?? "", reported_client: reported?.client ?? "", execution, pending };
  }));
  const names = Object.fromEntries((await database.prepare("SELECT id,name FROM room_members WHERE room_id=?").bind(room_id).all()).results.map(row => [row.id, row.name]));
  const requests = (await database.prepare(`SELECT id,member_id,message_id,status,execution_id,answer_id,chain_id,batch_id,purpose,created_by,created_at,
    (SELECT reason FROM request_cancel_reasons c WHERE c.request_id=member_requests.id) AS cancel_reason FROM member_requests
    WHERE room_id=? ORDER BY id DESC LIMIT ?`).bind(room_id, FREE_RECENT_REQUESTS).all()).results
    .map(async row => ({ ...row, member: names[row.member_id] ?? "", ...await free_request_source(database, row.id, row.message_id) }));
  const ordered_requests = (await Promise.all(requests)).reverse().map(request => read_limit === null ? request : limit_free_execution(request, read_limit));
  const halted_chains = (await database.prepare("SELECT chain_id,reason FROM free_chains WHERE room_id=? ORDER BY chain_id DESC LIMIT 10").bind(room_id).all()).results;
  // Recommendations shown beside their messages, with seconds left to adopt an open one.
  const recommendations = (await database.prepare(`SELECT rec.*,m.name AS member FROM member_recommendations rec JOIN room_members m ON m.id=rec.member_id
    WHERE rec.room_id=? ORDER BY rec.message_id DESC LIMIT ?`).bind(room_id, FREE_RECENT_REQUESTS).all()).results
    .map(row => ({ ...row, expires_in: Math.max(0, row.expires_at - now) })).reverse();
  const executions = await free_recent_executions(database, room_id);
  return { members, requests: ordered_requests, executions: read_limit === null ? executions : executions.map(row => limit_free_execution(row, read_limit)), execution_minutes: await free_execution_minutes(database, room_id), conflicts: await free_conflicts(database, room_id, names),
    halted_chains, max_rounds: await free_chain_rounds(database, room_id),
    chain_rounds: (await database.prepare(FREE_CHAIN_PROGRESS).bind(room_id).all()).results, recommendations };
}

/** Accept only the room control credential; declared names never grant ownership. */
async function require_free_owner(database, room_id, token) {
  const hashed = await runtime_hash(token);
  if (!hashed || !await database.prepare("SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?").bind(room_id, hashed).first()) {
    throw new HttpError(403, "需要本房间的控制凭据；没有凭据只能阅读");
  }
}

/** Resolve an active member strictly from its own credential. */
async function require_free_member(database, room_id, token, name) {
  const hashed = await runtime_hash(token);
  const row = hashed ? await database.prepare(`SELECT room_members.*,COALESCE(src.source,'') AS manual_source FROM room_members
    LEFT JOIN member_manual_sources src ON src.member_id=room_members.id WHERE room_id=? AND token_hash=? AND status='active'`)
    .bind(room_id, hashed).first() : null;
  if (!row || (name !== undefined && row.name !== name)) throw new HttpError(403, "成员凭证无效、已停用或与发言身份不符");
  return row;
}

/** Decide who writes: "用户" for the owner, or the member row for a member credential. */
async function authorize_free(database, room_id, token, operation, payload) {
  if (!FREE_OPERATIONS.includes(operation)) throw new HttpError(400, "自由房间不使用发言权、安排、阶段或轮次");
  try { await require_free_owner(database, room_id, token); return "用户"; }
  catch (error) { if (!["messages", "attachments"].includes(operation)) throw error; }
  if (operation === "messages" && payload.author === "web" && typeof payload.submitted_by === "string") {
    const host = await require_free_member(database, room_id, token, payload.submitted_by);
    if (host.role !== "host" || host.access === "online" || host.manual_source === "web") throw new HttpError(403, "只有本房间主持人可以代发网页成员回答");
    return host;
  }
  const author = payload.author ?? payload.actor;
  if (author === "用户" || (payload.submitted_by ?? author) !== author) throw new HttpError(403, "需要本房间的控制凭据；成员不能以用户身份或代他人发言");
  return require_free_member(database, room_id, token, author);
}

/** An invited manual member that has not registered counts as absent: it receives no request and is never a target. */
const FREE_REGISTERED = `(room_members.access<>'manual' OR EXISTS(SELECT 1 FROM member_registrations r
  WHERE r.member_id=room_members.id AND r.token_hash=room_members.token_hash)
  OR EXISTS(SELECT 1 FROM member_manual_sources s WHERE s.member_id=room_members.id AND s.source='web'))`;

/** Map active member names to their rows. */
async function free_active_members(database, room_id, registered_only = true) {
  return Object.fromEntries((await database.prepare(`SELECT room_members.*,COALESCE(src.source,'') AS manual_source FROM room_members
    LEFT JOIN member_manual_sources src ON src.member_id=room_members.id
    WHERE room_id=? AND status='active' AND (${FREE_REGISTERED} OR ?=0)`).bind(room_id, registered_only ? 1 : 0).all()).results
    .map(row => [row.name, row]));
}

/** Validate a structured recipient list against the active members. */
function free_named(active, names, exclude) {
  if (!Array.isArray(names) || names.some(name => !Object.hasOwn(active, name) || name === exclude)) {
    throw new HttpError(400, `点名对象须为本房间在场成员${exclude ? "，且不能点名自己" : ""}`);
  }
  return [...new Set(names)].map(name => active[name].id);
}

/**
 * An owner message's recipients as {id, purpose}; unnamed messages go to the AI host when there is one.
 * Naming everyone with order auto leaves the host a group request: the runner has everyone answer at once
 * or one after another; a host the runner does not wake has them all answer at once.
 */
async function free_recipients(database, room_id, payload) {
  // Rooms created while the user could host get their AI host on the next message.
  await database.batch(free_participant_statements(database, room_id));
  const active = await free_active_members(database, room_id);
  const rows = Object.values(active);
  const host = rows.find(row => row.role === "host");
  if (payload.to !== undefined) {
    const named = free_named(active, payload.to);
    if (payload.order === "auto" && named.length > 1 && host?.access === "runner") return [{ id: host.id, purpose: "group" }];
    return named.map(id => ({ id, purpose: "ask" }));
  }
  if (rows.length === 1) return [{ id: rows[0].id, purpose: "ask" }];
  return host ? [{ id: host.id, purpose: "route" }] : [];
}

/** Hand finished batches back to their host once; all-failed batches halt the chain. A hand-back closes the round it
 *  belongs to, so the round limit never holds it back: the last round still gets its summary. */
function free_settle_statements(database, room_id) {
  return [
    database.prepare(`INSERT OR IGNORE INTO free_chains (room_id,chain_id,reason) SELECT b.room_id,b.chain_id,'all_failed'
      FROM free_batches b WHERE b.room_id=? AND b.settled=0 AND ${FREE_BATCH_DONE} AND NOT ${FREE_BATCH_ANSWERED}`).bind(room_id),
    // The hand-off is unique per (dispatch message, host), so repeating this statement never duplicates it.
    database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
      SELECT b.room_id,b.host_id,b.batch_id,b.chain_id,0,'handoff','host',unixepoch()
      FROM free_batches b JOIN room_members m ON m.id=b.host_id AND m.status='active' AND m.role='host'
      WHERE b.room_id=? AND b.settled=0 AND ${FREE_BATCH_DONE} AND ${FREE_BATCH_ANSWERED} AND ${FREE_BATCH_RETURNS}
      AND NOT EXISTS(SELECT 1 FROM free_chains c WHERE c.room_id=b.room_id AND c.chain_id=b.chain_id)`).bind(room_id),
    database.prepare(`UPDATE free_batches AS b SET settled=1 WHERE b.room_id=? AND b.settled=0 AND ${FREE_BATCH_DONE}`).bind(room_id),
    ...free_advance_statements(database, room_id),
  ];
}

// A queued member has been asked once its request for that message exists.
const FREE_QUEUE_ASKED = (row) => `EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=${row}.message_id AND r.member_id=${row}.member_id)`;
// The room's speaking order: saved members by their saved place, the rest after them, the host first, then by joining order.
const SPEAKING_RANK = "(SELECT CAST(key AS INTEGER) FROM json_each((SELECT member_ids FROM speaking_orders WHERE room_id=room_members.room_id)) WHERE value=room_members.id)";
const SPEAKING_ORDER_BY = `${SPEAKING_RANK} IS NULL, ${SPEAKING_RANK}, role<>'host', id`;

/**
 * Ask the next queued member of each message whose previous request ended; members no longer present are skipped.
 * Asked rows stay, so the speaking order can still show who already answered.
 */
function free_advance_statements(database, room_id) {
  return [
    database.prepare(`DELETE FROM free_queue WHERE room_id=? AND NOT ${FREE_QUEUE_ASKED("free_queue")}
      AND NOT EXISTS(SELECT 1 FROM room_members m WHERE m.id=free_queue.member_id AND m.status='active')`).bind(room_id),
    database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
      SELECT q.room_id,q.member_id,q.message_id,q.message_id,0,'ask','user',unixepoch() FROM free_queue q
      WHERE q.room_id=? AND q.id=(SELECT MIN(x.id) FROM free_queue x WHERE x.message_id=q.message_id AND NOT ${FREE_QUEUE_ASKED("x")})
      AND NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=q.message_id AND r.status IN ('pending','delivering'))`).bind(room_id),
  ];
}

/**
 * Who spoke, who speaks now and who is next, shared by free rooms and discussions; only the not-yet-spoken part may be reordered.
 * A free room shows its latest unfinished one-after-another queue, else every member in the room's default order;
 * a discussion shows the open round: speakers so far, the current turn, then this round's queued turns; a plan reaching into
 * later rounds lists them apart in `later` (one name list per round), read-only. The revision changes with any of it.
 */
async function speaking_order(database, room) {
  const active = (await database.prepare(`SELECT id,name FROM room_members WHERE room_id=? AND status='active' ORDER BY ${SPEAKING_ORDER_BY}`).bind(room.id).all()).results;
  const by_id = new Map(active.map((member) => [member.id, member.name]));
  let ordered = active.map((member) => member.name);
  let items = [], kind = "default", target = 0, later = [];
  const session = await latest_session(database, room.id);
  if (session) {
    kind = 'turns';
    const requests = (await database.prepare(`SELECT q.*,m.name FROM session_requests q JOIN room_members m ON m.id=q.member_id
      WHERE q.session_id=? AND q.purpose='discuss' ORDER BY q.round,q.position,q.id`).bind(session.id).all()).results;
    const open_rounds = requests.filter(row => ['open', 'queued'].includes(row.status)).map(row => row.round);
    const round = open_rounds.length ? Math.min(...open_rounds) : Math.max(1, ...requests.map(row => row.round));
    const current = requests.filter(row => row.round === round);
    const speaking = current.find(row => row.status === 'open');
    items = current.filter(row => row.status === 'answered' && row.name !== speaking?.name).map(row => ({ name: row.name, state: 'done' }));
    if (speaking) items.push({ name: speaking.name, state: 'speaking' });
    items.push(...current.filter(row => row.status === 'queued').map(row => ({ name: row.name, state: 'queued' })));
    later = [...new Set(requests.filter(row => row.status === 'queued' && row.round > round).map(row => row.round))]
      .map(later_round => requests.filter(row => row.round === later_round && row.status === 'queued').map(row => row.name));
    ordered = [...active.map(member => member.name), ...Object.keys(room.experts)].filter(name => name !== '用户');
  } else if (room.mode === "free") {
    target = (await database.prepare(`SELECT MAX(q.message_id) AS target FROM free_queue q LEFT JOIN member_requests r ON r.message_id=q.message_id
      AND r.member_id=q.member_id WHERE q.room_id=? AND (r.id IS NULL OR r.status IN ('pending','delivering'))`).bind(room.id).first())?.target || 0;
    if (target) {
      kind = "queue";
      const rows = (await database.prepare(`SELECT q.member_id,r.status FROM free_queue q LEFT JOIN member_requests r
        ON r.message_id=q.message_id AND r.member_id=q.member_id WHERE q.message_id=? ORDER BY q.id`).bind(target).all()).results;
      items = rows.filter((row) => by_id.has(row.member_id)).map((row) => ({ name: by_id.get(row.member_id),
        state: row.status === null ? "queued" : ["pending", "delivering"].includes(row.status) ? "speaking" : "done" }));
    }
  } else {
    kind = "turns";
    const last = room.rounds.at(-1);
    const speaking = ["pending", "notified"].includes(room.current_turn?.status) ? room.current_turn.expert : null;
    items = (last && !last.completed ? last.speakers : []).filter((name) => name !== speaking).map((name) => ({ name, state: "done" }));
    if (speaking) items.push({ name: speaking, state: "speaking" });
    const rounds = split_rounds(room.queued_turns.map((item) => item.expert), items.map((item) => item.name));
    items.push(...rounds[0].map((name) => ({ name, state: "queued" })));
    later = rounds.slice(1);
    // The user may still hold the host seat of an old discussion; only AI participants have a place.
    ordered = [room.host, ...ordered, ...Object.keys(room.experts)].filter((name) => (Object.hasOwn(room.experts, name) || name === room.host) && name !== "用户");
  }
  const listed = new Set(items.map((item) => item.name));
  items.push(...[...new Set(ordered)].filter((name) => !listed.has(name)).map((name) => ({ name, state: "idle" })));
  const movable = kind === "default" ? "idle" : "queued";
  const state = JSON.stringify([kind, target, items.map((item) => [item.name, item.state]), later,
    session ? [session.id, session.state_revision] : null]);
  return { kind, message_id: target, items, later, movable: items.filter((item) => item.state === movable).map((item) => item.name), default: active.map((member) => member.name),
    revision: (await digest_hex(state)).slice(0, 12) };
}

/** Cut a turn queue into rounds: an expert who already spoke in the round being filled starts the next one. */
function split_rounds(names, spoken) {
  const rounds = [[]];
  let seen = new Set(spoken);
  for (const name of names) {
    if (seen.has(name)) { rounds.push([]); seen = new Set(); }
    rounds.at(-1).push(name);
    seen.add(name);
  }
  return rounds;
}

/**
 * Owner reorders the not-yet-spoken part of the speaking order; who already spoke or speaks now stays put.
 * Read the speaking order first and send its revision: a missing revision is refused, a changed one conflicts,
 * and the new order must list exactly the movable members.
 */
async function reorder_speakers(database, room, token, payload) {
  await require_free_owner(database, room.id, token);
  const current = room.speaking_order;
  if (payload.revision === undefined || payload.revision === null) throw new HttpError(400, "调整发言顺序前须先读取最新顺序（speaking-order），并带上其 revision");
  if (payload.revision !== current.revision) throw new HttpError(409, "发言顺序已变化，请重新读取后再调整");
  const order = payload.order, movable = current.movable;
  const given = Array.isArray(order) ? order.map(String) : [];
  const count = (list, name) => list.filter((item) => item === name).length;
  if (!Array.isArray(order) || JSON.stringify([...given].sort()) !== JSON.stringify([...movable].sort())) {
    const missing = [...new Set(movable)].filter((name) => count(given, name) < count(movable, name));
    const extra = [...new Set(given)].filter((name) => count(movable, name) < count(given, name));
    throw new HttpError(400, `新顺序须恰好包含尚未发言的成员${missing.length ? `；缺少：${missing.join("、")}` : ""}${extra.length ? `；多出：${extra.join("、")}` : ""}`);
  }
  const names = new Map((await database.prepare("SELECT id,name FROM room_members WHERE room_id=? AND status='active'").bind(room.id).all()).results.map((row) => [row.name, row.id]));
  if (current.kind === "queue") {
    await database.batch([database.prepare(`DELETE FROM free_queue WHERE message_id=? AND NOT ${FREE_QUEUE_ASKED("free_queue")}`).bind(current.message_id),
      ...order.map((name) => database.prepare("INSERT INTO free_queue (room_id,message_id,member_id) VALUES (?,?,?)").bind(room.id, current.message_id, names.get(name)))]);
  } else if (current.kind === "turns") {
    const session = await latest_session(database, room.id);
    if (session) {
      const round = (await session_roster(database, room.id)).round;
      const open_position = (await database.prepare(`SELECT COALESCE(MAX(position),0) AS position FROM session_requests
        WHERE session_id=? AND purpose='discuss' AND round=? AND status IN ('answered','open')`).bind(session.id, round).first()).position;
      await database.batch([...order.map((name, index) => database.prepare(`UPDATE session_requests SET position=?
        WHERE session_id=? AND purpose='discuss' AND round=? AND status='queued' AND member_id=?`)
        .bind(open_position + index + 1, session.id, round, names.get(name))),
        database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id)]);
      return;
    }
    // Ids keep the relay order, so each turn's content moves to the id at its new place; submission ids are freed first as they are unique.
    // This round's turns lead the queue, so they are its first rows; later rounds keep theirs.
    const rows = (await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND status='queued' ORDER BY id LIMIT ?").bind(room.id, order.length).all()).results;
    const remaining = [...rows];
    const moved = order.map((name) => remaining.splice(remaining.findIndex((row) => row.expert === name), 1)[0]);
    await database.batch([...rows.map((slot) => database.prepare("UPDATE discussion_turns SET submission_id=submission_id||':moving:'||id WHERE id=?").bind(slot.id)),
      ...rows.map((slot, index) => database.prepare("UPDATE discussion_turns SET expert=?,question=?,submission_id=?,created_at=? WHERE id=?")
        .bind(moved[index].expert, moved[index].question, moved[index].submission_id, moved[index].created_at, slot.id))]);
  } else {
    await database.prepare("INSERT OR REPLACE INTO speaking_orders (room_id,member_ids) VALUES (?,?)").bind(room.id, JSON.stringify(order.map((name) => names.get(name)))).run();
  }
}

/** The chain an answer continues: the newest chain among the requests it completes. */
async function free_answered_chain(database, member, payload) {
  const row = member.access === "manual"
    ? await database.prepare("SELECT MAX(chain_id) AS chain FROM member_requests WHERE id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(payload.request_ids ?? [])).first()
    : await database.prepare("SELECT MAX(chain_id) AS chain FROM member_requests WHERE execution_id=?").bind(payload.execution_id).first();
  return row?.chain || 0;
}

/** Rounds a host may run from one owner message in this room. */
async function free_chain_rounds(database, room_id) {
  return (await database.prepare(`SELECT ${FREE_ROUND_LIMIT("?")} AS rounds`).bind(room_id).first()).rounds;
}

/** Rounds a chain may still start: the room's limit plus what the owner added, less the dispatches made; none once halted. */
async function free_rounds_left(database, room_id, chain_id) {
  if (await database.prepare("SELECT 1 FROM free_chains WHERE room_id=? AND chain_id=?").bind(room_id, chain_id).first()) return 0;
  const row = await database.prepare(`SELECT (SELECT COUNT(*) FROM free_batches WHERE room_id=?1 AND chain_id=?2) AS used,
    COALESCE((SELECT extra_rounds FROM free_chain_holds WHERE room_id=?1 AND chain_id=?2),0) AS extra`).bind(room_id, chain_id).first();
  return await free_chain_rounds(database, room_id) + row.extra - row.used;
}

/** Owner sets the room's round limit; it applies to chains still running and to later ones. */
async function set_chain_rounds(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const value = payload.max_rounds;
  if (!Number.isInteger(value) || value < 1 || value > FREE_MAX_CHAIN_ROUNDS) {
    throw new HttpError(400, `max_rounds 须为 1–${FREE_MAX_CHAIN_ROUNDS} 的整数`);
  }
  await database.prepare(`INSERT INTO free_round_limits (room_id,max_rounds) VALUES (?,?)
    ON CONFLICT(room_id) DO UPDATE SET max_rounds=excluded.max_rounds`).bind(room_id, value).run();
  return { max_rounds: value };
}

/**
 * Owner lets a chain the round limit stopped run on: adds rounds and sends the dispatch the limit held back. Bound to
 * one known chain, so it takes no revision; a chain that is not stopped by its limit is refused.
 */
async function free_continue_chain(database, room_id, token, chain_id, payload) {
  await require_free_owner(database, room_id, token);
  const rounds = payload.rounds;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > FREE_MAX_CHAIN_ROUNDS) throw new HttpError(400, `rounds 须为 1–${FREE_MAX_CHAIN_ROUNDS} 的整数`);
  const halted = await database.prepare("SELECT reason FROM free_chains WHERE room_id=? AND chain_id=?").bind(room_id, chain_id).first();
  if (halted?.reason !== "budget") throw new HttpError(409, "这条任务链没有因轮数上限停下，无需继续");
  const host = await database.prepare("SELECT * FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
  if (!host) throw new HttpError(400, "房间没有在场的主持人，无法继续");
  const held = await database.prepare("SELECT message_id,names,handoff FROM free_chain_holds WHERE room_id=? AND chain_id=?").bind(room_id, chain_id).first();
  await checked_batch(database, "EXISTS(SELECT 1 FROM free_chains WHERE room_id=? AND chain_id=? AND reason='budget')", [room_id, chain_id], [
    database.prepare(`INSERT INTO free_chain_holds (room_id,chain_id,extra_rounds) VALUES (?,?,?)
      ON CONFLICT(room_id,chain_id) DO UPDATE SET extra_rounds=extra_rounds+excluded.extra_rounds`).bind(room_id, chain_id, rounds),
    database.prepare("DELETE FROM free_chains WHERE room_id=? AND chain_id=?").bind(room_id, chain_id),
    database.prepare("UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0 WHERE room_id=? AND chain_id=?").bind(room_id, chain_id)]);
  if (held?.message_id) {
    const statements = await free_dispatch_statements(database, room_id, host, JSON.parse(held.names), chain_id, "?", [held.message_id], held.handoff === 1);
    if (statements.length) await database.batch(statements);
  }
  return free_view(database, room_id);
}

/** Statements stopping a chain at its round limit, keeping the dispatch it held back for the owner to send by continuing. */
function free_hold_statements(database, room_id, host, names, chain_id, message_id, key, handoff) {
  return [database.prepare("INSERT OR IGNORE INTO free_chains (room_id,chain_id,reason) VALUES (?,?,'budget')").bind(room_id, chain_id),
    database.prepare(`INSERT INTO free_chain_holds (room_id,chain_id,message_id,host_id,names,handoff) SELECT ?,?,${message_id},?,?,?
      WHERE 1 ON CONFLICT(room_id,chain_id) DO UPDATE SET message_id=excluded.message_id,host_id=excluded.host_id,names=excluded.names,handoff=excluded.handoff`)
      .bind(room_id, chain_id, ...key, host.id, JSON.stringify(names), handoff ? 1 : 0)];
}

/** Statements queuing a host's named members as one batch, one round, or holding the dispatch back at the round limit. */
async function free_dispatch_statements(database, room_id, host, names, chain_id, message_id, key, handoff = false) {
  const member_ids = free_named(await free_active_members(database, room_id), names, host.name);
  if (!member_ids.length || !chain_id) return [];
  if (await free_rounds_left(database, room_id, chain_id) < 1) return free_hold_statements(database, room_id, host, names, chain_id, message_id, key, handoff);
  return [...member_ids.map(member_id => database.prepare(`INSERT INTO member_requests (room_id,member_id,message_id,chain_id,batch_id,purpose,created_by,created_at)
      SELECT ?,?,${message_id},?,${message_id},'ask','host',unixepoch()`).bind(room_id, member_id, ...key, chain_id, ...key)),
    database.prepare(`INSERT INTO free_batches (room_id,batch_id,chain_id,host_id) SELECT ?,${message_id},?,?`).bind(room_id, ...key, chain_id, host.id),
    ...handoff ? [database.prepare(`INSERT INTO free_handoffs (room_id,batch_id) SELECT ?,${message_id}`).bind(room_id, ...key)] : []];
}

/** A host answering only its share of an everyone request answers as a member, so it may not dispatch others. */
function free_check_dispatch(member, payload, purposes) {
  if (member.role === "host" && payload.to?.length && purposes.length && purposes.every(purpose => purpose === "all")) {
    throw new HttpError(400, "这次是请全体成员各自回应，其他成员已收到请求；主持人只回答自己的部分，不能用 --to 派活");
  }
}

/** Check a member's answer before the batch; the batch asserts the same facts atomically. */
async function free_answer_guard(database, room_id, member, payload) {
  const token_check = "EXISTS(SELECT 1 FROM room_members WHERE id=? AND token_hash=? AND status='active')";
  if (payload.to !== undefined) {
    free_named(await free_active_members(database, room_id), payload.to, member.name);
  }
  if (payload.handoff !== undefined && payload.handoff !== false && (payload.handoff !== true || member.role !== "host" || !payload.to?.length)) {
    throw new HttpError(400, "handoff 只能由主持人与 to 一起使用，值为 true");
  }
  if (member.access === "online" || member.manual_source === "web") throw new HttpError(403, "在线成员只读，回答由用户代发");
  if (member.access === "manual") {
    const ids = payload.request_ids ?? [];
    if (payload.execution_id !== undefined || !Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id))) throw new HttpError(400, "手动接入成员用 request_ids 关联请求，不使用执行编号");
    const purposes = [];
    for (const id of ids) {
      const row = await database.prepare("SELECT * FROM member_requests WHERE room_id=? AND id=?").bind(room_id, id).first();
      if (!row || row.member_id !== member.id || row.status !== "pending") throw new HttpError(409, `请求 ${id} 不属于本成员或已处理`);
      purposes.push(row.purpose);
    }
    if (purposes.includes("discuss") && (purposes.length !== 1 || (await database.prepare(`SELECT q.status,s.status AS session_status
      FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id WHERE q.member_request_id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids)).first())?.session_status !== "active")) throw new HttpError(409, "讨论请求已失效，或不能与其他请求合并");
    free_check_dispatch(member, payload, purposes);
    const unique = [...new Set(ids)];
    return { ids: unique, condition: `${token_check} AND (SELECT COUNT(*) FROM member_requests WHERE member_id=? AND status='pending' AND id IN (SELECT value FROM json_each(?)))=?
      AND NOT EXISTS(SELECT 1 FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id
        JOIN session_limits l ON l.session_id=s.id JOIN session_pauses p ON p.session_id=s.id
        WHERE q.member_request_id IN (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss')
          AND (q.status<>'open' OR s.status<>'active' OR (l.max_minutes>0 AND unixepoch()>=l.started_at+l.max_minutes*60+p.paused_seconds)))`,
      values: [member.id, member.token_hash, member.id, JSON.stringify(unique), unique.length, JSON.stringify(unique)] };
  }
  const execution_id = payload.execution_id;
  if (!Number.isSafeInteger(execution_id)) throw new HttpError(400, "成员回答须关联本次执行编号 execution_id");
  const row = await database.prepare("SELECT * FROM member_executions WHERE room_id=? AND id=?").bind(room_id, execution_id).first();
  if (!row || row.member_id !== member.id) throw new HttpError(403, "执行编号不属于本成员");
  if (!["dispatched", "started"].includes(row.status) || row.lease_until <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(409, "本次执行已结束、被打断或已过期；回答不能改作普通发言，请保留草稿");
  }
  free_check_dispatch(member, payload, (await database.prepare("SELECT purpose FROM member_requests WHERE execution_id=? AND status='delivering'")
    .bind(execution_id).all()).results.map(item => item.purpose));
  const purposes = (await database.prepare("SELECT purpose FROM member_requests WHERE execution_id=? AND status='delivering'").bind(execution_id).all()).results.map(item => item.purpose);
  if (purposes.includes("discuss") && purposes.length !== 1) throw new HttpError(409, "讨论请求必须单独执行，不能与直接提问合并");
  return { execution_id, condition: `${token_check} AND EXISTS(SELECT 1 FROM member_executions WHERE id=? AND member_id=? AND ${FREE_LIVE} AND lease_until>unixepoch())
    AND NOT EXISTS(SELECT 1 FROM session_requests q JOIN discussion_sessions s ON s.id=q.session_id
      JOIN session_limits l ON l.session_id=s.id JOIN session_pauses p ON p.session_id=s.id
      WHERE q.member_request_id IN (SELECT id FROM member_requests WHERE execution_id=? AND purpose='discuss')
        AND (q.status<>'open' OR s.status<>'active' OR (l.max_minutes>0 AND unixepoch()>=l.started_at+l.max_minutes*60+p.paused_seconds)))`,
    values: [member.id, member.token_hash, execution_id, member.id, execution_id] };
}

/** Statements ending matching live executions; requests move first, while their execution is still live. */
function free_finish_statements(database, where, values, status, result, request_status, cancel_reason = "") {
  return [
    ...(request_status === "cancelled" && cancel_reason ? [database.prepare(`INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason)
      SELECT id,? FROM member_requests WHERE status='delivering' AND execution_id IN (SELECT id FROM member_executions WHERE ${where} AND ${FREE_LIVE})`).bind(cancel_reason, ...values)] : []),
    database.prepare(`UPDATE member_requests SET status=?,execution_id=CASE WHEN ?='pending' THEN NULL ELSE execution_id END
      WHERE status='delivering' AND execution_id IN (SELECT id FROM member_executions WHERE ${where} AND ${FREE_LIVE})`).bind(request_status, request_status, ...values),
    database.prepare(`UPDATE member_executions SET status=?,finished_at=unixepoch(),result=? WHERE ${where} AND ${FREE_LIVE}`).bind(status, result.slice(0, 500), ...values),
  ];
}

/** Fail executions whose lease lapsed; their requests stay visible as failed, never silently retried. */
async function free_expire_statements(database, room_id) {
  const limit_seconds = (await free_execution_minutes(database, room_id)) * 60;
  return [...free_finish_statements(database, "room_id=? AND lease_until<=unixepoch() AND created_at+?<=lease_until", [room_id, limit_seconds], "failed", "已达到单次执行时限", "failed"),
    ...free_finish_statements(database, "room_id=? AND lease_until<=unixepoch()", [room_id], "failed", "执行租约到期，接入程序未续租", "failed"),
    ...free_settle_statements(database, room_id)];
}

/** Void a member's live execution and every open request, so nothing restarts by itself. */
function free_stop_statements(database, member_id, reason, cancel_reason) {
  return [...free_finish_statements(database, "member_id=?", [member_id], "cancelled", reason, "cancelled", cancel_reason),
    database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,? FROM member_requests WHERE member_id=? AND status='pending'").bind(cancel_reason, member_id),
    database.prepare("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND status='pending'").bind(member_id),
    database.prepare(`UPDATE session_requests SET status='cancelled' WHERE status='open' AND member_request_id IN
      (SELECT id FROM member_requests WHERE member_id=? AND status='cancelled' AND purpose='discuss')`).bind(member_id),
    database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
      (SELECT session_id FROM session_requests WHERE status='cancelled' AND member_request_id IN
        (SELECT id FROM member_requests WHERE member_id=? AND purpose='discuss' AND status='cancelled'))`).bind(member_id)];
}

/** Return the host to any active session whose speaker was interrupted or removed. */
async function reconcile_cancelled_session_requests(database, room_id, member_id) {
  const cancelled = (await database.prepare(`SELECT q.session_id,q.member_request_id,m.name
    FROM session_requests q JOIN member_requests r ON r.id=q.member_request_id JOIN room_members m ON m.id=q.member_id
    JOIN discussion_sessions s ON s.id=q.session_id
    WHERE s.room_id=? AND s.status='active' AND q.status='cancelled' AND q.purpose='discuss'
      AND q.member_id=? AND EXISTS(SELECT 1 FROM request_cancel_reasons c WHERE c.request_id=r.id
        AND c.reason IN ('user_stop','member_away','member_removed')) ORDER BY q.id`).bind(room_id, member_id).all()).results;
  for (const request of cancelled) {
    const session = await latest_session(database, room_id);
    if (!session || session.id !== request.session_id) continue;
    let next = await database.prepare("SELECT * FROM session_requests WHERE session_id=? AND status='queued' ORDER BY round,position,id LIMIT 1")
      .bind(session.id).first();
    while (next) {
      if (await issue_session_plan(database, session, next, request.member_request_id)) break;
      next = await database.prepare("SELECT * FROM session_requests WHERE session_id=? AND status='queued' ORDER BY round,position,id LIMIT 1")
        .bind(session.id).first();
    }
    if (next) continue;
    const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
    if (host) await create_session_task(database, request.session_id, host.id, "discuss_host",
      `${request.name} 的讨论发言已被中断（请求 ${request.member_request_id}）。请读取最新状态，继续安排或收束。`,
      "member_change", null, request.member_request_id);
  }
}

/** Void every live execution and open request of a room, e.g. when it is archived. */
function free_stop_room_statements(database, room_id, reason, cancel_reason) {
  return [...free_finish_statements(database, "room_id=?", [room_id], "cancelled", reason, "cancelled", cancel_reason),
    database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,? FROM member_requests WHERE room_id=? AND status='pending'").bind(cancel_reason, room_id),
    database.prepare("UPDATE member_requests SET status='cancelled' WHERE room_id=? AND status='pending'").bind(room_id),
    ...free_settle_statements(database, room_id)];
}

/** {message_id, purpose} of host requests still open; they need a new host if this one leaves. */
async function free_open_route_messages(database, member_id, pending_only = false) {
  const states = pending_only ? "'pending'" : "'pending','delivering'";
  return (await database.prepare(`SELECT message_id,purpose FROM member_requests WHERE member_id=? AND purpose IN ('route','group') AND status IN (${states}) ORDER BY message_id`)
    .bind(member_id).all()).results;
}

/** Ask the current host to route messages left behind by the previous host. */
function free_hand_over_statements(database, room_id, routes, departed_id = 0) {
  return routes.map(({ message_id, purpose }) => database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
    SELECT room_id,id,?,?,?,'user',unixepoch() FROM room_members WHERE room_id=? AND role='host' AND status='active' AND id<>?`)
    .bind(message_id, message_id, purpose, room_id, departed_id));
}

/** Describe one execution with the requests it carries and the member's read cursor. */
async function free_execution_detail(database, row) {
  const member = await database.prepare("SELECT * FROM room_members WHERE id=?").bind(row.member_id).first();
  const requests = (await database.prepare(`SELECT r.id,r.message_id,r.status,r.purpose,q.id AS session_request_id,q.session_id,
    q.round,q.position,q.read_until,q.question AS source_question,t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id
    FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id
    LEFT JOIN task_message_sources t ON t.session_request_id=q.id WHERE r.execution_id=? ORDER BY r.id`).bind(row.id).all()).results;
  const retry = await database.prepare("SELECT attempt,retry_at,reason,stopped FROM execution_retries WHERE execution_id=?").bind(row.id).first();
  return { ...pick(row, FREE_EXECUTION_FIELDS), member: member.name, read_until: member.read_until, requests,
    rewound_executions: await member_rewinds(database, member), retry: retry || null };
}

/** The room's taken-back messages by id, so the page keeps them in place while AI readers skip them. */
async function message_withdrawals(database, room_id) {
  return (await database.prepare(`SELECT w.message_id,w.kind FROM message_withdrawals w JOIN messages m ON m.id=w.message_id
    WHERE m.room_id=? ORDER BY w.message_id`).bind(room_id).all()).results;
}

/** One visible message of the user in a free room without an open discussion, which a retract or rewind may take back. */
async function owner_message(database, room_id, message_id) {
  const row = await database.prepare(`SELECT * FROM messages WHERE room_id=? AND id=?
    AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE task_message_sources.message_id=messages.id)`).bind(room_id, message_id).first();
  if (!row) throw new HttpError(404, "消息不存在");
  if (row.author !== "用户") throw new HttpError(400, "只能撤回或编辑用户自己的消息");
  if (await room_mode(database, room_id) !== "free") throw new HttpError(400, "只有协作房间的消息可以撤回或编辑");
  if (await database.prepare("SELECT 1 FROM room_directory WHERE room_id=? AND archived=1").bind(room_id).first()) throw new HttpError(400, "房间已存档；恢复后才能撤回或编辑");
  // A discussion's host reads the user's messages itself, with no request that shows whether it began.
  if (await database.prepare("SELECT 1 FROM discussion_sessions WHERE room_id=? AND (status IN ('active','paused') OR started_message_id>=?)").bind(room_id, message_id).first()) {
    throw new HttpError(409, "讨论进行中，或这条消息之后开启过讨论，不能撤回或编辑");
  }
  return row;
}

/**
 * Owner takes back a message no member began to handle: its queued requests end and AI readers no longer see it.
 * Bound to one known message, so it takes no revision; the text comes back so the page can put it in the input again.
 */
async function retract_message(database, room_id, message_id, token) {
  await require_free_owner(database, room_id, token);
  const message = await owner_message(database, room_id, message_id);
  const withdrawn = () => database.prepare("SELECT 1 FROM message_withdrawals WHERE message_id=?").bind(message_id).first();
  if (await withdrawn()) return { message_id, text: message.text, duplicate: true };
  const started = "EXISTS(SELECT 1 FROM member_requests WHERE message_id=? AND status IN ('delivering','completed','failed'))";
  const refused = "已有成员开始处理这条消息，不能撤回；可以编辑这条消息回退到它之前";
  if (await database.prepare(`SELECT ${started} AS started`).bind(message_id).first("started")) throw new HttpError(409, refused);
  try {
    await checked_batch(database, `NOT ${started} AND NOT EXISTS(SELECT 1 FROM message_withdrawals WHERE message_id=?)`, [message_id, message_id], [
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE message_id=? AND status='pending'").bind(message_id),
      database.prepare("DELETE FROM free_queue WHERE message_id=?").bind(message_id),
      database.prepare("INSERT INTO message_withdrawals (message_id,kind,created_at) VALUES (?,'retracted',unixepoch())").bind(message_id),
      ...free_settle_statements(database, room_id)]);
  } catch (error) {
    if (await withdrawn()) return { message_id, text: message.text, duplicate: true };
    if (error instanceof HttpError) throw new HttpError(409, refused);
    throw error;
  }
  return { message_id, text: message.text, duplicate: false };
}

// Software whose session the runner can cut before a taken-back execution; an API member rebuilds its context each time.
const CUTTABLE_ADAPTERS = ["claude", "codex", "codex_cli", "antigravity_cli"];
// Executions a rewind takes back: any touching a message from the rewind point on, and any still running.
const REWOUND_EXECUTIONS = `SELECT e.id,e.member_id FROM member_executions e WHERE e.room_id=? AND (e.status IN ('dispatched','started')
  OR EXISTS(SELECT 1 FROM member_requests r WHERE r.execution_id=e.id AND (r.message_id>=? OR r.answer_id>=?))) ORDER BY e.id`;

/**
 * What rewinding to just before a message takes back, and a revision of the state it was read from; mirrors
 * backend/free_room.py. Each member's session is `cut`, `fresh` (API), `unchanged` or `kept` (its own window keeps it).
 */
async function rewind_plan(database, room_id, message_id) {
  await owner_message(database, room_id, message_id);
  if (await database.prepare("SELECT 1 FROM message_withdrawals WHERE message_id=?").bind(message_id).first()) throw new HttpError(409, "这条消息已被撤回或回退");
  const executions = new Map();
  for (const row of (await database.prepare(REWOUND_EXECUTIONS).bind(room_id, message_id, message_id).all()).results) {
    executions.set(row.member_id, [...executions.get(row.member_id) || [], row.id]);
  }
  const members = (await database.prepare("SELECT id,name,access,adapter FROM room_members WHERE room_id=? AND status<>'removed' ORDER BY id").bind(room_id).all()).results
    .map(row => {
      const taken = executions.get(row.id) || [];
      const session = row.access !== "runner" || ![...CUTTABLE_ADAPTERS, "api"].includes(row.adapter) ? "kept"
        : !taken.length ? "unchanged" : row.adapter === "api" ? "fresh" : "cut";
      return { id: row.id, name: row.name, executions: taken, session };
    });
  const counts = await database.prepare(`SELECT (SELECT COUNT(*) FROM messages m WHERE m.room_id=? AND m.id>=?
    AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM task_message_sources t WHERE t.message_id=m.id)) AS count,
    (SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?) AS latest`).bind(room_id, message_id, room_id).first();
  const state = JSON.stringify([message_id, counts.latest, counts.count, members]);
  return { message_id, messages: counts.count, members, revision: (await digest_hex(state)).slice(0, 12) };
}

/**
 * Owner returns the room to just before one of its messages, as editing that message does; mirrors backend/free_room.py.
 * Read the plan first and send its revision: missing is refused, changed conflicts. Files the members changed are not restored.
 */
async function rewind_room(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const message_id = payload.message_id;
  if (!Number.isInteger(message_id)) throw new HttpError(400, "须提供要回退到其之前的消息编号 message_id");
  if (payload.revision === undefined || payload.revision === null) throw new HttpError(400, "回退前须先读取回退计划（GET rewind?message_id=），并带上其 revision");
  const plan = await rewind_plan(database, room_id, message_id);
  const changed = "房间已有新的消息或执行，请重新读取回退计划后再确认";
  if (payload.revision !== plan.revision) throw new HttpError(409, changed);
  const cuts = Object.fromEntries(plan.members.filter(member => member.session === "cut").map(member => [String(member.id), member.executions]));
  const seen = await database.prepare(`SELECT (SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?) AS latest,
    (SELECT COALESCE(MAX(id),0) FROM member_executions WHERE room_id=?) AS execution,
    (SELECT COUNT(*) FROM member_executions WHERE room_id=? AND ${FREE_LIVE}) AS live`).bind(room_id, room_id, room_id).first();
  try {
    await checked_batch(database, `(SELECT COALESCE(MAX(id),0) FROM messages WHERE room_id=?)=? AND (SELECT COALESCE(MAX(id),0) FROM member_executions WHERE room_id=?)=?
      AND (SELECT COUNT(*) FROM member_executions WHERE room_id=? AND ${FREE_LIVE})=? AND NOT EXISTS(SELECT 1 FROM message_withdrawals WHERE message_id=?)`,
    [room_id, seen.latest, room_id, seen.execution, room_id, seen.live, message_id], [
      ...free_finish_statements(database, "room_id=?", [room_id], "cancelled", "用户回退了对话", "cancelled", "user_stop"),
      database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'user_stop' FROM member_requests WHERE room_id=? AND message_id>=? AND status='pending'").bind(room_id, message_id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE room_id=? AND message_id>=? AND status='pending'").bind(room_id, message_id),
      database.prepare(`UPDATE session_requests SET status='cancelled' WHERE status IN ('open','queued') AND member_request_id IN
        (SELECT id FROM member_requests WHERE room_id=? AND message_id>=?)`).bind(room_id, message_id),
      database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
        (SELECT DISTINCT session_id FROM session_requests WHERE member_request_id IN
          (SELECT id FROM member_requests WHERE room_id=? AND message_id>=?))`).bind(room_id, message_id),
      database.prepare("DELETE FROM free_queue WHERE room_id=? AND message_id>=?").bind(room_id, message_id),
      // Batches of taken-back dispatches never hand back, and a dispatch the round limit held from them is never sent.
      database.prepare("UPDATE free_batches SET settled=1 WHERE room_id=? AND batch_id>=?").bind(room_id, message_id),
      database.prepare("UPDATE free_chain_holds SET message_id=0,host_id=0,names='[]',handoff=0 WHERE room_id=? AND message_id>=?").bind(room_id, message_id),
      database.prepare(`INSERT INTO message_withdrawals (message_id,kind,created_at) SELECT id,'rewound',unixepoch() FROM messages m
        WHERE m.room_id=? AND m.id>=? AND NOT EXISTS(SELECT 1 FROM message_withdrawals w WHERE w.message_id=m.id)`).bind(room_id, message_id),
      database.prepare("UPDATE room_members SET read_until=MIN(read_until,?) WHERE room_id=?").bind(message_id - 1, room_id),
      database.prepare("INSERT INTO room_rewinds (room_id,message_id,cuts,created_at) VALUES (?,?,?,unixepoch())").bind(room_id, message_id, JSON.stringify(cuts)),
      ...free_settle_statements(database, room_id)]);
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(409, changed);
    throw error;
  }
  const rewind = await database.prepare("SELECT id FROM room_rewinds WHERE room_id=? AND message_id=? ORDER BY id DESC LIMIT 1").bind(room_id, message_id).first();
  return { rewind_id: rewind.id, ...plan };
}

// The runner checks this many of a member's latest rewinds before each execution.
const RECENT_REWINDS = 50;

/** Executions taken back from one member by recent rewinds, oldest first; the runner cuts before the earliest it finds. */
async function member_rewinds(database, member) {
  const taken = new Set();
  for (const row of (await database.prepare("SELECT cuts FROM room_rewinds WHERE room_id=? ORDER BY id DESC LIMIT ?").bind(member.room_id, RECENT_REWINDS).all()).results) {
    for (const id of JSON.parse(row.cuts)[String(member.id)] || []) taken.add(id);
  }
  return [...taken].sort((first, second) => first - second);
}

/** List what the runner should deliver or reconcile; owner credential only. */
async function free_inbox(database, room_id, token) {
  await require_free_owner(database, room_id, token);
  const active_session = await latest_session(database, room_id);
  if (active_session && await finish_session_if_limited(database, active_session, room_id)) {
    await release_session_messages(database, room_id, active_session);
  }
  await database.batch([...await free_expire_statements(database, room_id), ...free_release_statements(database, room_id)]);
  await reconcile_failed_session_requests(database, room_id);
  const archived = Boolean((await database.prepare("SELECT archived FROM room_directory WHERE room_id=?").bind(room_id).first()).archived);
  const rows = (await database.prepare(`SELECT * FROM room_members WHERE room_id=? AND status='active' AND ${FREE_REGISTERED} ORDER BY id`).bind(room_id).all()).results;
  // Manual and online members are never delivered to; the runner only reads them so smart scheduling can route to them too.
  const listed = await Promise.all(rows.map(async row => ({ ...pick(row, FREE_MEMBER_FIELDS),
    pending: (await database.prepare(`SELECT r.id,r.message_id,r.purpose,q.id AS session_request_id,q.session_id,q.round,q.position,q.read_until,
      q.question AS source_question,t.cause_kind,t.cause_message_id AS source_message_id,t.cause_request_id
      FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id
      LEFT JOIN task_message_sources t ON t.session_request_id=q.id
      WHERE r.member_id=? AND r.status='pending' ORDER BY r.id`).bind(row.id).all()).results })));
  const members = listed.filter(member => member.access === "runner"), observers = listed.filter(member => member.access !== "runner");
  const executions = (await database.prepare(`SELECT member_executions.*,room_members.name,${FREE_RETRY_SQL("member_executions")} FROM member_executions JOIN room_members ON room_members.id=member_id
    WHERE member_executions.room_id=? AND member_executions.${FREE_LIVE} ORDER BY member_executions.id`).bind(room_id).all()).results
    .map(row => ({ ...pick(row, FREE_EXECUTION_FIELDS), member: row.name, retry: JSON.parse(row.retry || "null") }));
  return { room_id, archived, members, observers, executions, execution_minutes: await free_execution_minutes(database, room_id) };
}

/** Smart scheduling suggests another member for an unnamed message; the host keeps it until the user adopts. */
async function free_recommend(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const { provider, confidence, message_id } = payload;
  if (!FREE_SCHEDULER_PROVIDERS.includes(provider) || typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) {
    throw new HttpError(400, "须提供智能调度供应商 provider 与 0–1 的置信度 confidence");
  }
  const route = Number.isInteger(message_id) ? await database.prepare("SELECT * FROM member_requests WHERE message_id=? AND purpose='route'").bind(message_id).first() : null;
  if (!route || route.room_id !== room_id) throw new HttpError(404, "只能为交给主持人的未点名消息给出推荐");
  const target = await database.prepare(`SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active'
    AND ${FREE_REGISTERED} AND id<>?`).bind(room_id, payload.member_id ?? 0, route.member_id).first();
  if (!target) throw new HttpError(404, "推荐对象须为在场的其他成员");
  await database.prepare(`INSERT OR IGNORE INTO member_recommendations (message_id,room_id,member_id,provider,confidence,created_at,expires_at)
    VALUES (?,?,?,?,?,unixepoch(),unixepoch()+?)`).bind(message_id, room_id, target.id, provider, confidence, FREE_RECOMMEND_SECONDS).run();
  return database.prepare("SELECT * FROM member_recommendations WHERE message_id=?").bind(message_id).first();
}

/** Ask each adopted-later member once the host's request for that message has ended in any way. */
function free_release_statements(database, room_id) {
  const ready = `SELECT rec.message_id FROM member_recommendations rec JOIN member_requests r ON r.message_id=rec.message_id AND r.purpose='route'
    WHERE rec.room_id=? AND rec.status='waiting' AND r.status IN ('completed','cancelled','failed')`;
  return [
    database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
      SELECT rec.room_id,rec.member_id,rec.message_id,rec.message_id,'ask','user',unixepoch() FROM member_recommendations rec
      JOIN room_members m ON m.id=rec.member_id AND m.status='active' WHERE rec.message_id IN (${ready})`).bind(room_id),
    database.prepare(`UPDATE member_recommendations SET status='adopted' WHERE message_id IN (${ready})`).bind(room_id),
  ];
}

/**
 * Smart scheduling answers an unnamed message with everyone (each member once, as if the user named them all) or no one.
 * A message naming everyone (a group request) is answered by all at once or, with action sequential, one after another.
 * Only a host request that has not started changes; a started host already handles the message its own way.
 */
async function free_route_wide(database, room_id, message_id, action) {
  const group = await database.prepare("SELECT * FROM member_requests WHERE message_id=? AND purpose='group'").bind(message_id).first();
  if (group?.room_id === room_id) {
    if (!["all", "sequential"].includes(action)) throw new HttpError(400, "请全体成员回应的消息只能选 action=all 或 sequential");
    if (action === "sequential") return free_route_in_turn(database, room_id, group);
  } else if (action === "sequential") throw new HttpError(400, "只有请全体成员回应的消息可以依次回答");
  const route = group?.room_id === room_id ? group : await database.prepare("SELECT * FROM member_requests WHERE message_id=? AND purpose='route'").bind(message_id).first();
  if (!route || route.room_id !== room_id) throw new HttpError(404, "只能处理交给主持人的未点名消息");
  const pending = "AND status='pending'";
  const statements = action === "none"
    ? [database.prepare(`UPDATE member_requests SET status='cancelled' WHERE id=? ${pending}`).bind(route.id),
      database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'no_reply' FROM member_requests WHERE id=? AND status='cancelled' AND execution_id IS NULL AND answer_id IS NULL").bind(route.id)]
    // The host keeps its row (one request per message and member) and now answers its own share, without dispatching.
    : [database.prepare(`UPDATE member_requests SET purpose='all' WHERE id=? ${pending}`).bind(route.id),
      database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
        SELECT room_id,id,?,?,'all','user',unixepoch() FROM room_members WHERE room_id=? AND status='active' AND ${FREE_REGISTERED}
        AND EXISTS(SELECT 1 FROM member_requests WHERE id=? AND purpose='all' AND status='pending') ORDER BY id`).bind(message_id, message_id, room_id, route.id)];
  const results = await database.batch(statements);
  if (!results[0].meta.changes) throw new HttpError(409, "主持人已开始处理这条消息，不再改派");
  const requests = (await database.prepare("SELECT * FROM member_requests WHERE message_id=? ORDER BY id").bind(message_id).all()).results;
  return { action, requests };
}

/** Line everyone up for a group message in the room's speaking order; the host's row is removed so it queues like the rest. */
async function free_route_in_turn(database, room_id, group) {
  const results = await database.batch([
    database.prepare("DELETE FROM member_requests WHERE id=? AND status='pending'").bind(group.id),
    database.prepare(`INSERT INTO free_queue (room_id,message_id,member_id) SELECT ?,?,id FROM room_members
      WHERE room_id=? AND status='active' AND ${FREE_REGISTERED} AND changes()>0 ORDER BY ${SPEAKING_ORDER_BY}`).bind(room_id, group.message_id, room_id),
    ...free_advance_statements(database, room_id)]);
  if (!results[0].meta.changes) throw new HttpError(409, "这条消息已不再等待安排");
  const requests = (await database.prepare("SELECT * FROM member_requests WHERE message_id=? ORDER BY id").bind(group.message_id).all()).results;
  return { action: "sequential", requests };
}

/**
 * The user adopts a recommendation before it expires: interrupt the host now, or ask the member after the host.
 * Smart scheduling also sends action all or none here to have everyone or no one answer an unnamed message.
 */
async function free_adopt(database, room_id, token, message_id, payload) {
  await require_free_owner(database, room_id, token);
  if (["all", "none", "sequential"].includes(payload.action)) return free_route_wide(database, room_id, message_id, payload.action);
  if (payload.action !== "adopt" || !["interrupt", "after"].includes(payload.mode)) throw new HttpError(400, "采纳须为 action=adopt，mode 为 interrupt 或 after；全体、依次或无需回应为 action=all、sequential 或 none");
  const row = await database.prepare("SELECT * FROM member_recommendations WHERE room_id=? AND message_id=?").bind(room_id, message_id).first();
  if (!row) throw new HttpError(404, "这条消息没有智能调度推荐");
  if (row.status !== "open") return { recommendation: row, duplicate: true };
  if (Math.floor(Date.now() / 1000) > row.expires_at + FREE_RECOMMEND_GRACE_SECONDS) throw new HttpError(409, "推荐已过期，可直接 @ 该成员");
  if (!await database.prepare("SELECT 1 FROM room_members WHERE id=? AND status='active'").bind(row.member_id).first()) throw new HttpError(409, "推荐的成员已离开");
  const route = await database.prepare("SELECT * FROM member_requests WHERE message_id=? AND purpose='route'").bind(message_id).first();
  const statements = [];
  // The host's execution may carry other messages too; stopping it voids that whole execution.
  if (payload.mode === "interrupt" && route.status === "delivering") {
    statements.push(...free_finish_statements(database, "id=?", [route.execution_id], "cancelled", "智能调度改派，改由其他成员回答", "cancelled", "rerouted"));
  } else if (payload.mode === "interrupt" && route.status === "pending") {
    statements.push(database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) VALUES (?,'rerouted')").bind(route.id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE id=?").bind(route.id));
  }
  statements.push(database.prepare("UPDATE member_recommendations SET status='waiting',mode=? WHERE message_id=? AND status='open'").bind(payload.mode, message_id),
    ...free_release_statements(database, room_id), ...free_settle_statements(database, room_id));
  await database.batch(statements);
  return { recommendation: await database.prepare("SELECT * FROM member_recommendations WHERE message_id=?").bind(message_id).first(), duplicate: false };
}

/** Bundle a member's open requests into one execution; a retried client_id returns the same one. */
async function free_reserve(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const client_id = String(payload.client_id ?? "");
  if (client_id.length < 8 || client_id.length > 100) throw new HttpError(400, "client_id 须为 8–100 字符的本地投递编号");
  const lookup = () => database.prepare("SELECT * FROM member_executions WHERE room_id=? AND client_id=?").bind(room_id, client_id).first();
  const previous = await lookup();
  if (previous) return free_execution_detail(database, previous);
  await database.batch(await free_expire_statements(database, room_id));
  if ((await database.prepare("SELECT archived FROM room_directory WHERE room_id=?").bind(room_id).first()).archived) throw new HttpError(409, "房间已存档，不再投递");
  const member = await database.prepare("SELECT * FROM room_members WHERE room_id=? AND id=? AND status='active' AND access='runner'").bind(room_id, payload.member_id ?? 0).first();
  if (!member) throw new HttpError(404, "成员不存在、已离开或为手动接入");
  if (await database.prepare(`SELECT 1 FROM member_executions WHERE member_id=? AND ${FREE_LIVE}`).bind(member.id).first()) throw new HttpError(409, "该成员已有进行中的执行；同一会话不并发续接");
  // A group request waits for the runner to choose how everyone answers; it is never delivered itself.
  if (!await database.prepare("SELECT 1 FROM member_requests WHERE member_id=? AND status='pending' AND purpose<>'group'").bind(member.id).first()) throw new HttpError(409, "该成员没有待投递的请求");
  const cwd = String(payload.cwd || "").slice(0, FREE_MAX_PATH);
  try {
    // The partial unique index keeps one live execution per member even under concurrent reservations.
    await checked_batch(database, `EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active' AND access='runner')
      AND EXISTS(SELECT 1 FROM member_requests WHERE member_id=? AND status='pending' AND purpose<>'group')
      AND NOT EXISTS(SELECT 1 FROM room_directory WHERE room_id=? AND archived=1)
      `, [member.id, member.id, room_id], [
      database.prepare(`INSERT INTO member_executions (room_id,member_id,client_id,lease_until,created_at,cwd)
        VALUES (?,?,?,unixepoch()+?,unixepoch(),?)`).bind(room_id, member.id, client_id, FREE_LEASE_SECONDS, cwd),
      database.prepare(`UPDATE member_requests SET status='delivering',execution_id=(SELECT id FROM member_executions WHERE room_id=? AND client_id=?)
        WHERE member_id=? AND status='pending' AND purpose<>'group'
          AND (purpose='discuss' OR NOT EXISTS(SELECT 1 FROM member_requests WHERE member_id=? AND status='pending' AND purpose='discuss'))`)
        .bind(room_id, client_id, member.id, member.id),
    ]);
  } catch (error) {
    const committed = await lookup();
    if (committed) return free_execution_detail(database, committed);
    if (String(error).includes("UNIQUE constraint")) throw new HttpError(409, "该成员已有进行中的执行；同一会话不并发续接");
    throw error;
  }
  return free_execution_detail(database, await lookup());
}

/** Let the owner or the executing member read one execution. */
async function free_view_execution(database, room_id, execution_id, token) {
  const row = await database.prepare("SELECT * FROM member_executions WHERE room_id=? AND id=?").bind(room_id, execution_id).first();
  if (!row) throw new HttpError(404, "执行不存在");
  try { await require_free_owner(database, room_id, token); }
  catch (error) {
    const member = await require_free_member(database, room_id, token);
    if (member.id !== row.member_id) throw error;
  }
  return free_execution_detail(database, row);
}

/** Validate progress notes carried by a renewal; a repeated sequence number is the same note resent. */
function free_renewed_notes(payload) {
  const notes = payload.notes ?? [];
  if (!Array.isArray(notes) || notes.length > FREE_MAX_NOTES_PER_RENEW || notes.some(note => !note || typeof note !== "object"
    || !Number.isInteger(note.seq) || note.seq < 1 || note.seq > FREE_MAX_EXECUTION_NOTES
    || typeof note.text !== "string" || !note.text.length || note.text.length > FREE_MAX_NOTE_LENGTH)) {
    throw new HttpError(400, `notes 须为最多 ${FREE_MAX_NOTES_PER_RENEW} 条 {seq: 1–${FREE_MAX_EXECUTION_NOTES}, text: 1–${FREE_MAX_NOTE_LENGTH} 字}`);
  }
  return notes;
}

/** The owner's descriptions of members by name; everyone who can read the room may read them. */
async function member_descriptions(database, room_id) {
  const rows = (await database.prepare("SELECT name,description FROM member_descriptions WHERE room_id=? ORDER BY name").bind(room_id).all()).results;
  return Object.fromEntries(rows.map(row => [row.name, row.description]));
}

/** Owner sets members' descriptions by name; an empty text removes that member's description. */
async function describe_members(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const descriptions = payload.descriptions;
  const entries = descriptions && typeof descriptions === "object" && !Array.isArray(descriptions) ? Object.entries(descriptions) : [];
  if (!entries.length || entries.length > MAX_ROOM_AGENTS || entries.some(([name, text]) => !name || name.length > MAX_MEMBER_NAME
    || typeof text !== "string" || text.length > MAX_MEMBER_DESCRIPTION)) {
    throw new HttpError(400, `descriptions 须为 {成员名: 描述}，最多 ${MAX_ROOM_AGENTS} 位，每段最多 ${MAX_MEMBER_DESCRIPTION} 字`);
  }
  await database.batch(entries.map(([name, text]) => text.trim()
    ? database.prepare(`INSERT INTO member_descriptions (room_id,name,description,updated_at) VALUES (?,?,?,unixepoch())
      ON CONFLICT(room_id,name) DO UPDATE SET description=excluded.description,updated_at=excluded.updated_at`).bind(room_id, name, text.trim())
    : database.prepare("DELETE FROM member_descriptions WHERE room_id=? AND name=?").bind(room_id, name)));
  return { descriptions: await member_descriptions(database, room_id) };
}

/** The owner's display labels of members by name; only screens use them, never addressing or credentials. */
async function member_labels(database, room_id) {
  const rows = (await database.prepare("SELECT name,label FROM member_labels WHERE room_id=? ORDER BY name").bind(room_id).all()).results;
  return Object.fromEntries(rows.map(row => [row.name, row.label]));
}

/** Owner sets members' display labels by name; an empty text removes that member's label. */
async function label_members(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const labels = payload.labels;
  const entries = labels && typeof labels === "object" && !Array.isArray(labels) ? Object.entries(labels) : [];
  if (!entries.length || entries.length > MAX_ROOM_AGENTS || entries.some(([name, text]) => !name || name.length > MAX_MEMBER_NAME
    || typeof text !== "string" || text.trim().length > MAX_MEMBER_LABEL)) {
    throw new HttpError(400, `labels 须为 {成员名: 显示名}，最多 ${MAX_ROOM_AGENTS} 位，每个最多 ${MAX_MEMBER_LABEL} 字`);
  }
  await database.batch(entries.map(([name, text]) => text.trim()
    ? database.prepare(`INSERT INTO member_labels (room_id,name,label,updated_at) VALUES (?,?,?,unixepoch())
      ON CONFLICT(room_id,name) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at`).bind(room_id, name, text.trim())
    : database.prepare("DELETE FROM member_labels WHERE room_id=? AND name=?").bind(room_id, name)));
  return { labels: await member_labels(database, room_id) };
}

/** Read one execution's progress notes in order, with the same access as the room view. */
async function free_execution_notes(database, room_id, execution_id, token) {
  const execution = await database.prepare("SELECT * FROM member_executions WHERE room_id=? AND id=?").bind(room_id, execution_id).first();
  if (!execution) throw new HttpError(404, "执行不存在");
  const read_limit = await initial_session_read_limit(database, room_id, token);
  if (read_limit !== null) {
    try { await require_free_owner(database, room_id, token); }
    catch (error) {
      let member;
      try { member = await require_free_member(database, room_id, token); }
      catch { return { notes: [] }; }
      if (member.id !== execution.member_id && member.role !== "host") return { notes: [] };
    }
    if (!await database.prepare("SELECT 1 FROM member_requests WHERE execution_id=? LIMIT 1").bind(execution_id).first()) return { notes: [] };
  }
  return { notes: (await database.prepare("SELECT seq,text,created_at FROM execution_notes WHERE execution_id=? ORDER BY seq").bind(execution_id).all()).results };
}

/**
 * Statements recording an execution's phase segments as millisecond offsets from its delivery at `anchor`. The runner
 * measures them on its own clock, so they are kept within the execution's own span; `finished` is 0 while it runs. A
 * resent segment keeps the later end, so the open segment can be reported again as it runs on. `optional` allows a
 * report with no segments, when it carries progress notes instead.
 */
function segment_statements(database, source, room_id, execution_id, anchor, finished, payload, optional = false) {
  const now = Math.floor(Date.now() / 1000);
  if (finished && finished + SEGMENT_GRACE_SECONDS < now) throw new HttpError(409, "执行已结束较久，不再接收阶段记录");
  const segments = payload.segments ?? [];
  if (!Array.isArray(segments) || (!segments.length && !optional) || segments.length > MAX_SEGMENTS_PER_REPORT || segments.some(item => !item || typeof item !== "object"
    || !Number.isInteger(item.seq) || item.seq < 1 || item.seq > MAX_EXECUTION_SEGMENTS || !SEGMENT_PHASES.includes(item.phase)
    || typeof (item.tool ?? "") !== "string" || (item.tool ?? "").length > MAX_SEGMENT_TOOL
    || !Number.isInteger(item.start_ms) || !Number.isInteger(item.end_ms))) {
    throw new HttpError(400, `segments 须为 1–${MAX_SEGMENTS_PER_REPORT} 段 {seq: 1–${MAX_EXECUTION_SEGMENTS}, phase: ${SEGMENT_PHASES.join("、")}, tool: 最多 ${MAX_SEGMENT_TOOL} 字, start_ms, end_ms}`);
  }
  const limit = Math.max(0, (finished || now) - anchor + 1) * 1000;
  return segments.map(item => {
    const start = Math.min(Math.max(item.start_ms, 0), limit);
    return database.prepare(`INSERT INTO execution_segments (source,execution_id,seq,room_id,phase,tool,start_ms,end_ms)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(source,execution_id,seq) DO UPDATE SET end_ms=MAX(end_ms,excluded.end_ms)`)
      .bind(source, execution_id, item.seq, room_id, item.phase, item.tool ?? "", start, Math.min(Math.max(item.end_ms, start), limit));
  });
}

/**
 * The room's recent executions of both kinds with their phase segments and note times, for the timeline page. Times are
 * epoch seconds and segments are millisecond offsets from `dispatched_at`. A free execution's parent is the execution that
 * wrote the message it answers; discussion executions have none. `state` is running, done, failed or cancelled. A positive
 * `after` reads only executions still running or ended since then, so a page following live work rereads little.
 */
async function execution_timeline(database, room_id, after = 0, token = "") {
  await require_room_id(database, room_id);
  const params = [room_id, TIMELINE_EXECUTIONS, Math.max(0, Number.parseInt(after, 10) || 0)];
  const [rows, segment_rows, note_rows] = (await database.batch([TIMELINE_SQL, TIMELINE_SEGMENTS_SQL, TIMELINE_NOTES_SQL]
    .map(sql => database.prepare(sql).bind(...params)))).map(result => result.results);
  const segments = new Map();
  for (const row of segment_rows) {
    const key = `${row.source}:${row.execution_id}`;
    if (!segments.has(key)) segments.set(key, []);
    segments.get(key).push({ phase: row.phase, tool: row.tool, start_ms: row.start_ms, end_ms: row.end_ms });
  }
  const notes = new Map();
  for (const row of note_rows) {
    if (!notes.has(row.execution_id)) notes.set(row.execution_id, []);
    notes.get(row.execution_id).push(row.created_at);
  }
  const read_limit = await initial_session_read_limit(database, room_id, token);
  return { now: Math.floor(Date.now() / 1000), after: params[2], execution_limit: TIMELINE_EXECUTIONS, segment_limit: MAX_EXECUTION_SEGMENTS,
    executions: rows.map(row => {
      const hidden_task = read_limit !== null && (row.source === "discussion" || row.task_id > read_limit);
      return { ...row,
        ...(hidden_task ? { task: "", task_id: null, reason: "" } : {}),
        ...(read_limit !== null ? { last_note: "" } : {}),
        ...(read_limit !== null && row.answer_id > read_limit ? { result: "", answer_id: null } : {}),
        state: TIMELINE_STATES[row.status] || "running", segments: segments.get(`${row.source}:${row.id}`) || [],
        notes: read_limit !== null ? [] : row.source === "free" ? notes.get(row.id) || [] : [] };
    }) };
}

/** Validate the runner's reported phase; its output time is kept within the execution, since the runner's clock may differ. */
function free_renewed_activity(payload, row, now) {
  const { activity, activity_at } = payload;
  if (!FREE_ACTIVITY_PHASES.includes(activity)) throw new HttpError(400, `activity 须为 ${FREE_ACTIVITY_PHASES.filter(Boolean).join("、")} 或空`);
  if (!Number.isInteger(activity_at)) throw new HttpError(400, "activity_at 须为秒级时间戳");
  return [activity, Math.min(Math.max(activity_at, row.created_at), now)];
}

/** Runner-side lifecycle: renew, fail, release undelivered work, or report observed file changes. */
async function free_execution_action(database, room_id, execution_id, token, payload) {
  const row = await database.prepare("SELECT * FROM member_executions WHERE room_id=? AND id=?").bind(room_id, execution_id).first();
  if (!row) throw new HttpError(404, "执行不存在");
  const action = payload.action;
  if (action === "fail") {
    try { await require_free_owner(database, room_id, token); }
    catch {
      const member = await require_free_member(database, room_id, token);
      if (member.id !== row.member_id) throw new HttpError(403, "只能报告本人执行的失败");
    }
  } else await require_free_owner(database, room_id, token);
  const live = ["dispatched", "started"].includes(row.status);
  if (action === "report") {
    const files = payload.changes;
    if (!Array.isArray(files) || files.length > FREE_MAX_CHANGED_FILES || files.some(item => typeof item !== "string" || !item || item.length > FREE_MAX_PATH)) {
      throw new HttpError(400, `changes 须为最多 ${FREE_MAX_CHANGED_FILES} 个相对路径`);
    }
    const result = await database.prepare("UPDATE member_executions SET changes=? WHERE id=? AND changes=''").bind(JSON.stringify([...new Set(files)].sort()), execution_id).run();
    if (!result.meta.changes) throw new HttpError(409, "本次执行的改动已记录");
  } else if (action === "denials") {
    // Like file changes, read from the software's output once its process ends; recorded once.
    const result = await database.prepare("INSERT OR IGNORE INTO execution_denials (execution_id,room_id,denials) VALUES (?,?,?)")
      .bind(execution_id, room_id, JSON.stringify(free_denied_actions(payload))).run();
    if (!result.meta.changes) throw new HttpError(409, "本次执行的拒绝记录已记录");
  } else if (action === "segments") {
    // The last segments and notes arrive after the member's answer ended the execution; such notes are dated at its end.
    const finished = live ? 0 : row.finished_at || 1;
    const notes = free_renewed_notes(payload);
    const dated = finished ? Math.min(Math.floor(Date.now() / 1000), finished) : Math.floor(Date.now() / 1000);
    await database.batch([...segment_statements(database, "free", room_id, execution_id, row.created_at, finished, payload, notes.length > 0),
      ...notes.map(note => database.prepare("INSERT OR IGNORE INTO execution_notes (execution_id,seq,room_id,text,created_at) VALUES (?,?,?,?,?)")
        .bind(execution_id, note.seq, room_id, note.text, dated))]);
  } else if (!live) throw new HttpError(409, "执行已结束");
  else if (action === "renew") {
    const limit = row.created_at + await free_execution_minutes(database, room_id) * 60;
    const now = Math.floor(Date.now() / 1000);
    if (row.lease_until <= now || limit <= now) throw new HttpError(409, "执行租约或单次时限已到，不能续租");
    // Older runners renew without activity; the last reported one is kept.
    const [activity, activity_at] = "activity" in payload ? free_renewed_activity(payload, row, now) : [row.activity, row.activity_at];
    const notes = free_renewed_notes(payload);
    await database.batch([
      database.prepare(`UPDATE member_executions SET lease_until=MIN(unixepoch()+?,?),activity=?,activity_at=? WHERE id=? AND ${FREE_LIVE} AND lease_until>unixepoch()`)
        .bind(FREE_LEASE_SECONDS, limit, activity, activity_at, execution_id),
      ...notes.map(note => database.prepare("INSERT OR IGNORE INTO execution_notes (execution_id,seq,room_id,text,created_at) VALUES (?,?,?,?,unixepoch())")
        .bind(execution_id, note.seq, room_id, note.text))]);
  } else if (action === "retry_wait") {
    // A manual member's session refused the delivery: the runner keeps the execution and delivers again at retry_at.
    const { attempt, retry_at } = payload, reason = typeof payload.reason === "string" ? payload.reason : "";
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > FREE_MAX_RETRIES || !Number.isInteger(retry_at) || retry_at <= 0
      || !reason || reason.length > FREE_MAX_RETRY_REASON) {
      throw new HttpError(400, `retry_wait 须带 attempt（1–${FREE_MAX_RETRIES}）、秒级 retry_at 与 reason（最多 ${FREE_MAX_RETRY_REASON} 字）`);
    }
    await database.prepare(`INSERT INTO execution_retries (execution_id,room_id,attempt,retry_at,reason,stopped) VALUES (?,?,?,?,?,0)
      ON CONFLICT(execution_id) DO UPDATE SET attempt=excluded.attempt,retry_at=excluded.retry_at,reason=excluded.reason,stopped=0`)
      .bind(execution_id, room_id, attempt, retry_at, reason).run();
  } else if (action === "retry_start") {
    await database.prepare("UPDATE execution_retries SET retry_at=0 WHERE execution_id=?").bind(execution_id).run();
  } else if (action === "retry_now" || action === "retry_stop") {
    // The owner's answer to a waiting retry: deliver now, or stop so the runner fails the execution.
    const result = await database.prepare(`UPDATE execution_retries SET ${action === "retry_now" ? "retry_at=unixepoch()" : "stopped=1"}
      WHERE execution_id=? AND retry_at>0 AND stopped=0`).bind(execution_id).run();
    if (!result.meta.changes) throw new HttpError(409, "本次执行没有在等待自动重试");
  } else if (action === "fail") {
    await database.batch([...free_finish_statements(database, "id=?", [execution_id], "failed", String(payload.reason || "执行失败"), "failed"),
      ...free_settle_statements(database, room_id)]);
    await reconcile_failed_session_requests(database, room_id);
  } else if (action === "release") {
    // Only for proven non-delivery: the requests return to the queue unchanged.
    await database.batch(free_finish_statements(database, "id=?", [execution_id], "cancelled", String(payload.reason || "未送达"), "pending"));
  } else throw new HttpError(400, "action 须为 renew、fail、release、report、segments、retry_wait、retry_start、retry_now 或 retry_stop");
  return free_execution_detail(database, await database.prepare("SELECT * FROM member_executions WHERE id=?").bind(execution_id).first());
}

/** Read one non-removed member after proving the owner's credential. */
async function free_owned_member(database, room_id, member_id, token) {
  await require_free_owner(database, room_id, token);
  const member = await database.prepare(`SELECT room_members.*,COALESCE(src.source,'') AS manual_source FROM room_members
    LEFT JOIN member_manual_sources src ON src.member_id=room_members.id WHERE room_id=? AND id=?`).bind(room_id, member_id).first();
  if (!member || member.status === "removed") throw new HttpError(404, "成员不存在");
  return member;
}

/** Owner actions: add, interrupt, send away, bring back with a fresh credential, or remove. */
async function handle_free_api(database, request, parts) {
  const room_id = parts[2];
  const token = request.headers.get("X-Discussion-Token") ?? "";
  const method = request.method;
  if (parts.length === 4 && parts[3] === "suggestions" && method === "POST") return respond(await free_convert_suggestion(database, room_id, token, await read_payload(request)));
  if (parts.length === 4 && parts[3] === "inbox" && method === "GET") return respond(await free_inbox(database, room_id, token));
  if (parts.length === 4 && parts[3] === "executions" && method === "POST") return respond(await free_reserve(database, room_id, token, await read_payload(request)));
  if (parts.length === 4 && parts[3] === "recommendations" && method === "POST") return respond(await free_recommend(database, room_id, token, await read_payload(request)));
  if (parts.length === 5 && parts[3] === "recommendations" && method === "POST") return respond(await free_adopt(database, room_id, token, integer(parts[4]), await read_payload(request)));
  if (parts.length === 6 && parts[3] === "executions" && parts[5] === "notes" && method === "GET") return respond(await free_execution_notes(database, room_id, integer(parts[4]), token));
  if (parts.length === 5 && parts[3] === "executions") {
    const execution_id = integer(parts[4]);
    return respond(method === "GET" ? await free_view_execution(database, room_id, execution_id, token)
      : await free_execution_action(database, room_id, execution_id, token, await read_payload(request)));
  }
  if (parts.length === 4 && parts[3] === "members" && method === "POST") {
    await require_free_owner(database, room_id, token);
    const member = await free_member_value(await read_payload(request));
    const existing = await database.prepare("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'").bind(room_id, member.name).first();
    if (existing?.status === "active" && ["token_hash", "adapter", "access", "session_mode"].every(key => existing[key] === member[key])) return respond(await free_view(database, room_id));
    if (existing) {
      throw new HttpError(409, `${member.name} 已是本房间成员；离开的成员请用请回`);
    }
    await require_fresh_member_hash(database, room_id, member.token_hash);
    try { await database.batch([...free_member_statements(database, room_id, member), ...free_participant_statements(database, room_id)]); }
    catch (error) { if (String(error).includes("UNIQUE constraint")) throw new HttpError(409, `${member.name} 已是本房间成员`); throw error; }
    await queue_invited_expert(database, room_id, member.name);
    return respond(await free_view(database, room_id));
  }
  if (parts.length === 6 && parts[3] === "members" && parts[5] === "interrupt" && method === "POST") {
    const member = await free_owned_member(database, room_id, integer(parts[4]), token);
    await database.batch([...free_stop_statements(database, member.id, "用户打断", "user_stop"), ...free_settle_statements(database, room_id)]);
    await reconcile_cancelled_session_requests(database, room_id, member.id);
    return respond(await free_view(database, room_id));
  }
  if (parts.length === 5 && parts[3] === "members" && method === "POST") {
    const member = await free_owned_member(database, room_id, integer(parts[4]), token);
    const payload = await read_payload(request);
    if (["away", "remove"].includes(payload.action)) {
      if (member.role === 'host') await pause_session_for_host_change(database, room_id);
      else await session_member_change(database, room_id, member, payload.action);
      // Unnamed messages still waiting on a departing host move to its successor instead of being dropped.
      const routed = await free_open_route_messages(database, member.id);
      await database.batch([...free_stop_statements(database, member.id, payload.action === "away" ? "成员已离开" : "成员已移除", payload.action === "away" ? "member_away" : "member_removed"),
        database.prepare("UPDATE room_members SET status=? WHERE id=?").bind(payload.action === "away" ? "away" : "removed", member.id),
        ...free_participant_statements(database, room_id), ...free_settle_statements(database, room_id),
        ...free_hand_over_statements(database, room_id, routed, member.id)]);
    } else if (payload.action === "active") {
      const hashed = await runtime_hash(payload.token);
      if (member.status === "active" && hashed && hashed === member.token_hash) return respond(await free_view(database, room_id));
      if (member.status !== "away" || !hashed || hashed === member.token_hash) throw new HttpError(400, "只有离开的成员可以请回，且须提供新的成员凭证");
      await require_fresh_member_hash(database, room_id, hashed);
      await database.batch([database.prepare("UPDATE room_members SET status='active',token_hash=? WHERE id=? AND status='away'").bind(hashed, member.id),
        ...free_participant_statements(database, room_id)]);
      await session_member_change(database, room_id, member, 'active');
    } else if (payload.action === "adopt") {
      const reported = await database.prepare("SELECT session_id FROM member_sessions WHERE member_id=?").bind(member.id).first();
      if (!await registered_at(database, member)) throw new HttpError(400, "成员尚未注册，不能转为托管");
      if (!reported || reported.session_id !== payload.session_id || !["claude", "codex", "codex_cli", "antigravity", "antigravity_cli"].includes(payload.adapter)) throw new HttpError(400, "成员尚未上报与之相符的会话，不能转为托管");
      if (member.access !== "manual" || member.status !== "active") throw new HttpError(400, "只有在场的手动成员可以转为托管");
      const hashed = payload.token === undefined ? null : await runtime_hash(payload.token);
      if (hashed !== null) await require_fresh_member_hash(database, room_id, hashed);
      await database.batch([
        database.prepare("UPDATE room_members SET access='runner',adapter=?,session_mode='borrowed',token_hash=COALESCE(?,token_hash) WHERE id=?").bind(payload.adapter, hashed, member.id),
        database.prepare("DELETE FROM member_sessions WHERE member_id=?").bind(member.id),
        ...free_participant_statements(database, room_id), ...free_settle_statements(database, room_id)]);
    } else if (payload.action === "role") {
      if (!["host", "member"].includes(payload.role) || (payload.role === "host" && (member.access === "online" || member.manual_source === "web"))) {
        throw new HttpError(400, "role 须为 host 或 member；在线成员不能担任主持人");
      }
      if (payload.role === "member" && member.role === "host") throw new HttpError(400, "自由房间须由一位 AI 主持；请指定另一位成员担任主持人");
      // Unnamed messages the old host has not started move to the new host, which carries the host rules.
      const old_host = payload.role === "host" ? await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND id<>?").bind(room_id, member.id).first() : null;
      if (payload.role === 'host') await pause_session_for_host_change(database, room_id);
      const routed = old_host ? await free_open_route_messages(database, old_host.id, true) : [];
      await database.batch([
        ...(old_host ? [database.prepare("INSERT OR REPLACE INTO request_cancel_reasons (request_id,reason) SELECT id,'rerouted' FROM member_requests WHERE member_id=? AND purpose IN ('route','group') AND status='pending'").bind(old_host.id),
          database.prepare("UPDATE member_requests SET status='cancelled' WHERE member_id=? AND purpose IN ('route','group') AND status='pending'").bind(old_host.id)] : []),
        ...(payload.role === "host" ? [database.prepare("UPDATE room_members SET role='member' WHERE room_id=? AND role='host'").bind(room_id)] : []),
        database.prepare("UPDATE room_members SET role=? WHERE id=?").bind(payload.role, member.id),
        ...free_participant_statements(database, room_id), ...free_settle_statements(database, room_id),
        ...free_hand_over_statements(database, room_id, routed)]);
    } else throw new HttpError(400, "action 须为 away、active、remove、role 或 adopt");
    return respond(await free_view(database, room_id));
  }
  throw new HttpError(404, "地址不存在");
}

/** Queue a newly invited expert at the tail of the live plan in the same transaction as its membership. */
function queue_legacy_invited_expert(database, room_id, name) {
  return database.prepare(`INSERT OR IGNORE INTO discussion_turns (room_id,expert,question,status,submission_id,created_at)
    SELECT settings.room_id,member.name,
      CASE WHEN settings.phase='initial' THEN '欢迎加入：请先读取议题，独立给出你的开场观点。'
           ELSE '欢迎加入：请先读取议题和已有回答，给出你的观点。' END,
      'queued','invite:'||member.id,strftime('%Y-%m-%dT%H:%M:%SZ','now')
    FROM topic_settings AS settings JOIN room_members AS member ON member.room_id=settings.room_id
    WHERE settings.room_id=? AND member.name=? AND member.status='active'
      AND settings.phase NOT IN ('paused','concluded')
      AND EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=settings.room_id AND status IN ('pending','notified','queued'))`)
    .bind(room_id, name);
}

/** Owner invites, sends away (keeping the seat), brings back or removes one discussion expert; the run keeps going. */
async function handle_discussion_members(database, request, parts) {
  const room_id = parts[2];
  const token = request.headers.get("X-Discussion-Token") ?? "";
  const payload = await read_payload(request);
  const room = await require_room(database, room_id);
  const experts = { ...room.experts };
  const save = () => database.prepare("UPDATE topic_settings SET experts=? WHERE room_id=?").bind(JSON.stringify(experts), room_id);
  if (parts.length === 4) {
    await require_free_owner(database, room_id, token);
    const member = await free_member_value(payload);
    if (!discussion_access_ok(member.access, "cli", room.runtime?.mode === "automatic", false)) throw new HttpError(400, "新专家的接入方式须与讨论的推进方式一致");
    const existing = await database.prepare("SELECT * FROM room_members WHERE room_id=? AND name=? AND status<>'removed'").bind(room_id, member.name).first();
    if (existing?.status === "active" && existing.token_hash === member.token_hash) return respond(room);
    if (existing) throw new HttpError(409, `${member.name} 已是本房间成员；离开的成员请用请回`);
    if (room.phase === "concluded") throw new HttpError(400, "讨论已收束，不能再邀请专家");
    if (Object.keys(experts).length >= MAX_ROOM_AGENTS) throw new HttpError(400, "房间成员已达上限");
    await require_fresh_member_hash(database, room_id, member.token_hash);
    try { await database.batch([
      ...free_member_statements(database, room_id, mark_manual(member, room.runtime?.mode === "automatic")),
      database.prepare("UPDATE topic_settings SET experts=json_set(experts,?,'cli') WHERE room_id=?").bind(`$."${member.name}"`, room_id),
      ...(room.runtime?.mode === "automatic" && member.access === "manual" ? [] : [queue_legacy_invited_expert(database, room_id, member.name)])]); }
    catch (error) { if (String(error).includes("UNIQUE constraint")) throw new HttpError(409, `${member.name} 已是本房间成员`); throw error; }
  } else {
    const member = await free_owned_member(database, room_id, integer(parts[4]), token);
    if (["away", "remove"].includes(payload.action)) {
      if (member.name === room.host) throw new HttpError(400, "主持人不能离开或移除；请先更换主持人");
      const speaking = await database.prepare("SELECT 1 FROM discussion_turns WHERE room_id=? AND expert=? AND status IN ('pending','notified')").bind(room_id, member.name).first();
      if (speaking && room.phase !== "paused") throw new HttpError(400, "该专家正在发言；请先暂停讨论再离开或移除");
      delete experts[member.name];
      await database.batch([
        database.prepare("UPDATE discussion_turns SET status='cancelled' WHERE room_id=? AND expert=? AND status IN ('pending','notified')").bind(room_id, member.name),
        database.prepare("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND expert=? AND status='queued'").bind(room_id, member.name),
        database.prepare("UPDATE room_members SET status=? WHERE id=?").bind(payload.action === "away" ? "away" : "removed", member.id), save()]);
    } else if (payload.action === "active") {
      const hashed = await runtime_hash(payload.token);
      if (member.status === "active" && hashed && hashed === member.token_hash) return respond(room);
      if (member.status !== "away" || !hashed || hashed === member.token_hash) throw new HttpError(400, "只有离开的成员可以请回，且须提供新的成员凭证");
      await require_fresh_member_hash(database, room_id, hashed);
      experts[member.name] = member.access === "online" || member.manual_source === "web" ? "online" : "cli";
      await database.batch([
        database.prepare("UPDATE discussion_turns SET status='skipped' WHERE room_id=? AND status='queued'").bind(room_id),
        database.prepare("UPDATE room_members SET status='active',token_hash=? WHERE id=? AND status='away'").bind(hashed, member.id), save()]);
    } else if (payload.action === "adopt") {
      const reported = await database.prepare("SELECT session_id FROM member_sessions WHERE member_id=?").bind(member.id).first();
      if (!await registered_at(database, member)) throw new HttpError(400, "成员尚未注册，不能转为托管");
      if (!reported || reported.session_id !== payload.session_id || !["claude", "codex", "codex_cli", "antigravity", "antigravity_cli"].includes(payload.adapter)) throw new HttpError(400, "成员尚未上报与之相符的会话，不能转为托管");
      if (member.access !== "manual" || member.status !== "active" || room.runtime?.mode !== "automatic") throw new HttpError(400, "只有全自动讨论中在场的手动专家可以转为托管");
      await database.batch([
        database.prepare("UPDATE room_members SET access='runner',adapter=?,session_mode='borrowed' WHERE id=?").bind(payload.adapter, member.id),
        database.prepare("DELETE FROM member_sessions WHERE member_id=?").bind(member.id)]);
    } else throw new HttpError(400, "action 须为 away、active、remove 或 adopt");
  }
  return respond(await require_room(database, room_id));
}

/** Return when the member registered with its current credential, or '' while it has not. */
async function registered_at(database, member) {
  return (await database.prepare("SELECT registered_at FROM member_registrations WHERE member_id=? AND token_hash=?")
    .bind(member.id, member.token_hash).first())?.registered_at ?? "";
}

/** A manual member announces itself with its own credential; repeating it keeps the first time. The session ID is recorded separately from the CLI's headers. */
async function register_member(database, room_id, token) {
  const member = await require_free_member(database, room_id, token);
  if (member.access !== "manual") throw new HttpError(400, "只有手动接入的成员需要注册");
  const previous = await registered_at(database, member);
  const stamp = previous || new Date().toISOString();
  await database.prepare(`INSERT INTO member_registrations (member_id,room_id,token_hash,registered_at) VALUES (?,?,?,?)
    ON CONFLICT(member_id) DO UPDATE SET token_hash=excluded.token_hash,registered_at=excluded.registered_at`).bind(member.id, room_id, member.token_hash, stamp).run();
  if (!previous) {
    // A manual discussion expert joins the live round plan only now that it has registered.
    await queue_invited_expert(database, room_id, member.name);
  }
  const reported = await database.prepare("SELECT client FROM member_sessions WHERE member_id=?").bind(member.id).first();
  return { member: member.name, registered_at: stamp, session_client: reported?.client ?? "" };
}

/** Queue an invited expert after its registration, preserving the current open plan. */
async function queue_invited_expert(database, room_id, name) {
  const session = await latest_session(database, room_id);
  if (!session) return;
  const member = await database.prepare(`SELECT m.*,COALESCE(src.source,'') AS manual_source FROM room_members m
    LEFT JOIN member_manual_sources src ON src.member_id=m.id WHERE m.room_id=? AND m.name=? AND m.status='active'`)
    .bind(room_id, name).first();
  if (!member || (member.access === 'manual' && member.manual_source !== 'web' && !await registered_at(database, member))) return;
  const planned = await database.prepare("SELECT 1 FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued') LIMIT 1")
    .bind(session.id).first();
  if (!planned) return;
  const round = (await database.prepare("SELECT MIN(round) AS round FROM session_requests WHERE session_id=? AND purpose='discuss' AND status IN ('open','queued','failed')")
    .bind(session.id).first()).round ?? 1;
  const position = (await database.prepare("SELECT COALESCE(MAX(position),0)+1 AS position FROM session_requests WHERE session_id=? AND purpose='discuss' AND round=?")
    .bind(session.id, round).first()).position;
  const invitation = (await database.prepare("SELECT COUNT(*) AS count FROM session_requests WHERE session_id=? AND member_id=? AND submission_id LIKE 'invite:%'")
    .bind(session.id, member.id).first()).count + 1;
  const question = session.phase === 'initial' ? '欢迎加入：请先读取议题，独立给出你的开场观点。' : '欢迎加入：请先读取议题和已有回答，给出你的观点。';
  await database.batch([
    database.prepare(`INSERT OR IGNORE INTO session_requests(session_id,round,position,member_id,purpose,question,status,submission_id,read_until,created_at)
      VALUES(?,?,?,?,'discuss',?,'queued',?,?,?)`).bind(session.id, round, position, member.id, question,
      `invite:${member.id}:${invitation}`, session.phase === 'initial' && round === 1 ? session.read_until : null, new Date().toISOString()),
    database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id),
  ]);
}

/** Invalidate queued work after roster changes and ask the active host to plan again. */
async function session_member_change(database, room_id, member, action) {
  const session = await latest_session(database, room_id);
  if (!session || session.status !== 'active') return;
  const queued = (await database.prepare("SELECT id,member_request_id FROM session_requests WHERE session_id=? AND purpose='discuss' AND status='queued'")
    .bind(session.id).all()).results;
  const targets = ['away', 'remove'].includes(action)
    ? (await database.prepare("SELECT id,member_request_id FROM session_requests WHERE session_id=? AND purpose='discuss' AND member_id=? AND status IN ('open','queued','failed')")
      .bind(session.id, member.id).all()).results : [];
  const statements = [
    ...queued.flatMap(row => [
      ...(row.member_request_id ? [database.prepare("UPDATE member_requests SET status='cancelled' WHERE id=? AND status IN ('pending','delivering')").bind(row.member_request_id),
        database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='discussion_roster_changed'
          WHERE id IN (SELECT execution_id FROM member_requests WHERE id=?) AND status IN ('dispatched','started')`).bind(row.member_request_id)] : []),
      database.prepare("UPDATE session_requests SET status='skipped' WHERE id=? AND status='queued'").bind(row.id),
    ]),
    ...targets.flatMap(row => [
      ...(row.member_request_id ? [database.prepare("INSERT OR REPLACE INTO request_cancel_reasons(request_id,reason) SELECT ?,? WHERE EXISTS(SELECT 1 FROM member_requests WHERE id=? AND status IN ('pending','delivering'))")
        .bind(row.member_request_id, action === 'away' ? 'member_away' : 'member_removed', row.member_request_id),
        database.prepare("UPDATE member_requests SET status='cancelled' WHERE id=? AND status IN ('pending','delivering')").bind(row.member_request_id),
        database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='member_left'
          WHERE id IN (SELECT execution_id FROM member_requests WHERE id=?) AND status IN ('dispatched','started')`).bind(row.member_request_id)] : []),
      database.prepare("UPDATE session_requests SET status=CASE WHEN status='open' THEN 'cancelled' WHEN status='queued' THEN 'skipped' ELSE status END WHERE id=?").bind(row.id),
    ]),
    database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id),
  ];
  await database.batch(statements);
  const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
  if (host) {
    const detail = action === 'away' ? '暂离' : action === 'remove' ? '移除' : '请回';
    await create_session_task(database, session.id, host.id, 'discuss_host',
      `专家 ${member.name} 已${detail}；剩余排队安排已作废，请检查当前发言并重新安排。`, 'member_change');
  }
}

/** Pause and cancel a live session before changing its host. */
async function pause_session_for_host_change(database, room_id) {
  const session = await latest_session(database, room_id);
  if (!session || session.status !== 'active') return;
  const requests = (await database.prepare("SELECT member_request_id FROM session_requests WHERE session_id=? AND status IN ('open','queued')")
    .bind(session.id).all()).results;
  await database.batch([
    ...requests.flatMap(row => row.member_request_id ? [
      database.prepare("INSERT OR REPLACE INTO request_cancel_reasons(request_id,reason) SELECT ?,'user_stop' WHERE EXISTS(SELECT 1 FROM member_requests WHERE id=? AND status IN ('pending','delivering'))").bind(row.member_request_id, row.member_request_id),
      database.prepare("UPDATE member_requests SET status='cancelled' WHERE id=? AND status IN ('pending','delivering')").bind(row.member_request_id),
      database.prepare(`UPDATE member_executions SET status='cancelled',finished_at=unixepoch(),result='host_changed'
        WHERE id IN (SELECT execution_id FROM member_requests WHERE id=?) AND status IN ('dispatched','started')`).bind(row.member_request_id),
    ] : []),
    database.prepare("UPDATE session_requests SET status='cancelled' WHERE session_id=? AND status IN ('open','queued')").bind(session.id),
    database.prepare("UPDATE discussion_sessions SET status='paused' WHERE id=? AND status='active'").bind(session.id),
    database.prepare('UPDATE session_pauses SET paused_at=unixepoch() WHERE session_id=?').bind(session.id),
    database.prepare('UPDATE session_state SET revision=revision+1 WHERE session_id=?').bind(session.id),
  ]);
}

/** Prevent reuse of an existing member or owner credential. */
async function require_fresh_member_hash(database, room_id, hashed) {
  if (!hashed || await database.prepare("SELECT 1 FROM room_members WHERE room_id=? AND token_hash=? UNION ALL SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?")
    .bind(room_id, hashed, room_id, hashed).first()) throw new HttpError(400, "须提供独立的新成员凭证");
}

/** Remove Markdown code and quotes before interpreting ordinary members' mentions. */
function free_mention_prose(text) {
  const lines = [];
  let fence = "", quoted = false;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      continue;
    }
    if (fence || /^( {4}|\t)/.test(line)) continue;
    if (/^ {0,3}>/.test(line)) { quoted = true; continue; }
    if (!line.trim()) quoted = false;
    if (!quoted) lines.push(line);
  }
  return lines.join("\n").replace(/(`+)[\s\S]*?\1(?!`)/g, "");
}

/** Persist suggestion targets separately from requests; only an owner can activate them. */
async function free_suggestion_targets(database, room_id, member, payload) {
  if (member === "用户" || member.role === "host") return [];
  const active = await free_active_members(database, room_id);
  const targets = new Set(free_named(active, payload.to ?? [], member.name));
  const prose = free_mention_prose(String(payload.text ?? ""));
  for (const [name, target] of Object.entries(active)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (name !== member.name && new RegExp(`(^|[\\s(（，,。；;：:])@${escaped}(?![A-Za-z0-9_\\-\\u4e00-\\u9fff])`, "u").test(prose)) targets.add(target.id);
  }
  return [...targets];
}

/** Atomically confirm a saved suggestion, starting a user chain once per source and target. */
async function free_convert_suggestion(database, room_id, token, payload) {
  await require_free_owner(database, room_id, token);
  const { message_id, member_id } = payload;
  if (!Number.isSafeInteger(message_id) || !Number.isSafeInteger(member_id)) throw new HttpError(400, "须提供原消息编号 message_id 与成员编号 member_id");
  const target = await database.prepare(`SELECT m.name,m.status FROM member_suggestions s
    JOIN messages source ON source.id=s.message_id JOIN room_members m ON m.id=s.member_id
    WHERE source.room_id=? AND m.room_id=? AND s.message_id=? AND s.member_id=?`).bind(room_id, room_id, message_id, member_id).first();
  if (!target) throw new HttpError(404, "这条消息没有该成员的回应建议");
  if (target.status !== "active") throw new HttpError(409, "该成员已离开，不能转为请求");
  if (await database.prepare("SELECT 1 FROM room_directory WHERE room_id=? AND archived=1").bind(room_id).first()) throw new HttpError(400, "房间已存档；恢复后才能继续协作");
  const lookup = () => database.prepare("SELECT * FROM member_requests WHERE message_id=? AND member_id=?").bind(message_id, member_id).first();
  const previous = await lookup();
  if (previous) return { request: previous, duplicate: true };
  const submission = crypto.randomUUID(), key = [room_id, submission];
  const confirmation = "(SELECT id FROM messages WHERE room_id=? AND submission_id=?)";
  const guard = `EXISTS(SELECT 1 FROM room_modes WHERE room_id=? AND control_hash=?)
    AND EXISTS(SELECT 1 FROM room_members WHERE id=? AND room_id=? AND status='active')
    AND NOT EXISTS(SELECT 1 FROM room_directory WHERE room_id=? AND archived=1)`;
  await checked_batch(database, guard, [room_id, await runtime_hash(token), member_id, room_id, room_id], [
    database.prepare(`INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at)
      SELECT ?,'用户',?,?,'user',?,? WHERE NOT EXISTS(SELECT 1 FROM member_requests WHERE message_id=? AND member_id=?)`)
      .bind(room_id, `请 @${target.name} 回应 #${message_id} 的建议。`, message_id, submission, new Date().toISOString(), message_id, member_id),
    database.prepare(`INSERT INTO message_details (message_id,kind,submitted_by)
      SELECT id,'chat','用户' FROM messages WHERE room_id=? AND submission_id=?`).bind(...key),
    database.prepare(`INSERT OR IGNORE INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
      SELECT ?,?,?,${confirmation},'ask','user',unixepoch() WHERE ${confirmation} IS NOT NULL`)
      .bind(room_id, member_id, message_id, ...key, ...key),
  ]);
  return { request: await lookup(), duplicate: !await database.prepare(`SELECT 1 FROM messages WHERE room_id=? AND submission_id=?`).bind(...key).first() };
}

/** Append a free-room message: the owner's creates requests, a member's closes what its answer covers. */
async function append_free_message(database, room, payload, actor) {
  const room_id = room.id;
  if (payload.kind === "moderation") return append_free_moderation(database, room, payload, actor);
  if (["opinion", "moderation", "receipt"].includes(payload.kind) || payload.turn_id !== undefined && payload.turn_id !== null) {
    throw new HttpError(400, "自由房间回答使用 chat 并关联执行或请求，不接受旧 kind 或 turn_id");
  }
  const values = message_values(payload);
  const host_proxy = actor !== "用户" && actor.role === "host" && values.author === "web" && payload.submitted_by === actor.name;
  let proxy = null;
  if (actor === "用户" && values.author !== "用户") {
    proxy = await database.prepare(`SELECT room_members.*,COALESCE(src.source,'') AS manual_source FROM room_members
      LEFT JOIN member_manual_sources src ON src.member_id=room_members.id WHERE room_id=? AND name=? AND status='active'
      AND (access='online' OR src.source='web')`).bind(room_id, values.author).first();
    if (!proxy || (payload.submitted_by ?? "用户") !== "用户") throw new HttpError(403, "房间控制凭据只能以用户身份发言，或代发在线成员的回答");
  }
  const expected = { ...values, kind: "chat", submitted_by: proxy ? "用户" : host_proxy ? actor.name : values.author, turn_id: null,
    source: proxy ? "proxy" : host_proxy ? "host_proxy" : values.author === "用户" ? "user" : payload.source === "api" ? "api" : "cli", attachment_ids: attachment_ids(payload) };
  Object.assign(expected, message_summary(payload, expected));
  const lookup = () => database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
  const previous = await lookup();
  if (previous) {
    await attach_message_files(database, [previous]);
    check_retry(previous, expected);
    if (actor !== "用户" || proxy) await advance_session_answer(database, room_id, previous.id);
    return { message: previous, duplicate: true };
  }
  if (room.archived) throw new HttpError(400, "房间已存档；恢复后才能继续协作");
  const current_session = actor === "用户" && payload.to === undefined ? await latest_session(database, room_id) : null;
  const session = current_session?.status === "active" ? current_session : null;
  await check_message_references(database, room_id, expected);
  await check_message_attachments(database, room_id, expected);
  const message_id = "(SELECT id FROM messages WHERE room_id=? AND submission_id=?)";
  if (proxy && room.archived) throw new HttpError(400, "房间已存档；恢复后才能继续协作");
  const key = [room_id, values.submission_id];
  let guard = { condition: "NOT EXISTS(SELECT 1 FROM room_directory WHERE room_id=? AND archived=1)", values: [room_id] };
  if (proxy) guard = { condition: `${guard.condition} AND EXISTS(SELECT 1 FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
      WHERE m.id=? AND m.status='active' AND (m.access='online' OR src.source='web'))`, values: [...guard.values, proxy.id] };
  const effects = [];
  for (const member_id of await free_suggestion_targets(database, room_id, proxy || actor, payload)) {
    effects.push(database.prepare(`INSERT INTO member_suggestions (message_id,member_id) SELECT ${message_id},?`).bind(...key, member_id));
  }
  if (proxy) {
    const ids = payload.request_ids ?? [];
    const checked = await validate_web_proxy_requests(database, room_id, ids, proxy.id);
    guard = add_web_proxy_batch_guard(guard, room_id, proxy.id, checked.ids);
    effects.push(database.prepare(`UPDATE member_requests SET status='completed',answer_id=${message_id}
      WHERE member_id=? AND status='pending' AND id IN (SELECT value FROM json_each(?))`).bind(...key, proxy.id, JSON.stringify(checked.ids)));
    effects.push(database.prepare(`UPDATE session_requests SET status='answered' WHERE status='open' AND member_request_id IN
      (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss')`).bind(JSON.stringify(checked.ids)),
      database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
        (SELECT session_id FROM session_requests WHERE status='answered' AND member_request_id IN
          (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss'))`).bind(JSON.stringify(checked.ids)));
  } else if (host_proxy) {
    const ids = payload.request_ids ?? [];
    const checked = await validate_web_proxy_requests(database, room_id, ids);
    guard = add_web_proxy_batch_guard(guard, room_id, checked.member_id, checked.ids);
    guard = { condition: `${guard.condition} AND EXISTS(SELECT 1 FROM room_members m LEFT JOIN member_manual_sources src ON src.member_id=m.id
      WHERE m.id=? AND m.status='active' AND (m.access='online' OR src.source='web'))`, values: [...guard.values, checked.member_id] };
    effects.push(database.prepare(`UPDATE member_requests SET status='completed',answer_id=${message_id}
      WHERE id IN (SELECT value FROM json_each(?)) AND status='pending'`).bind(...key, JSON.stringify(checked.ids)));
    effects.push(database.prepare(`UPDATE session_requests SET status='answered' WHERE status='open' AND member_request_id IN
      (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss')`).bind(JSON.stringify(checked.ids)),
      database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
        (SELECT session_id FROM session_requests WHERE status='answered' AND member_request_id IN
          (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss'))`).bind(JSON.stringify(checked.ids)));
  } else if (actor === "用户" && payload.sequential === true && payload.to !== undefined) {
    // Named members answer one after another in the room's speaking order; settling below asks the first.
    const ids = (await free_recipients(database, room_id, payload)).map(recipient => recipient.id);
    effects.push(database.prepare(`INSERT INTO free_queue (room_id,message_id,member_id)
      SELECT ?,${message_id},id FROM room_members WHERE id IN (SELECT value FROM json_each(?)) ORDER BY ${SPEAKING_ORDER_BY}`)
      .bind(room_id, ...key, JSON.stringify(ids)));
  } else if (actor === "用户") {
    for (const recipient of session ? [] : await free_recipients(database, room_id, payload)) {
      effects.push(database.prepare(`INSERT INTO member_requests (room_id,member_id,message_id,chain_id,purpose,created_by,created_at)
        SELECT ?,?,${message_id},${message_id},?,'user',unixepoch() WHERE EXISTS(SELECT 1 FROM room_members WHERE id=? AND status='active')`)
        .bind(room_id, recipient.id, ...key, ...key, recipient.purpose, recipient.id));
    }
    if (session) {
      guard = { condition: `${guard.condition} AND EXISTS(SELECT 1 FROM discussion_sessions s JOIN session_state st ON st.session_id=s.id
        WHERE s.id=? AND s.status='active' AND st.revision=?)`, values: [...guard.values, session.id, session.state_revision] };
      effects.push(database.prepare(`UPDATE session_state SET held_since=CASE WHEN held_since=0 THEN ${message_id} ELSE held_since END,
        revision=revision+1 WHERE session_id=? AND EXISTS(SELECT 1 FROM discussion_sessions WHERE id=? AND status='active')`)
        .bind(...key, session.id, session.id));
    }
  } else {
    guard = await free_answer_guard(database, room_id, actor, payload);
    const chain_id = await free_answered_chain(database, actor, payload);
    if (guard.ids) {
      effects.push(database.prepare(`UPDATE member_requests SET status='completed',answer_id=${message_id}
        WHERE member_id=? AND status='pending' AND id IN (SELECT value FROM json_each(?))`).bind(...key, actor.id, JSON.stringify(guard.ids)));
      effects.push(database.prepare(`UPDATE session_requests SET status='answered' WHERE status='open' AND member_request_id IN
        (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss')`).bind(JSON.stringify(guard.ids)),
        database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
          (SELECT session_id FROM session_requests WHERE status='answered' AND member_request_id IN
            (SELECT id FROM member_requests WHERE id IN (SELECT value FROM json_each(?)) AND purpose='discuss'))`).bind(JSON.stringify(guard.ids)));
    } else {
      effects.push(database.prepare(`UPDATE member_requests SET status='completed',answer_id=${message_id} WHERE execution_id=? AND status='delivering'`)
        .bind(...key, guard.execution_id),
        database.prepare(`UPDATE member_executions SET status='completed',finished_at=unixepoch(),result='message:'||${message_id} WHERE id=?`)
          .bind(...key, guard.execution_id));
      effects.push(database.prepare(`UPDATE session_requests SET status='answered' WHERE status='open' AND member_request_id IN
        (SELECT id FROM member_requests WHERE execution_id=? AND purpose='discuss')`).bind(guard.execution_id),
        database.prepare(`UPDATE session_state SET revision=revision+1 WHERE session_id IN
          (SELECT session_id FROM session_requests WHERE status='answered' AND member_request_id IN
            (SELECT id FROM member_requests WHERE execution_id=? AND purpose='discuss'))`).bind(guard.execution_id));
    }
    effects.push(database.prepare(`UPDATE room_members SET read_until=MAX(read_until,${message_id}) WHERE id=?`).bind(...key, actor.id));
    if (actor.role === "host" && payload.to?.length) effects.push(...await free_dispatch_statements(database, room_id, actor, payload.to, chain_id, message_id, key, payload.handoff === true));
  }
  effects.push(...free_settle_statements(database, room_id));
  const statements = [
    database.prepare(`INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(room_id, expected.author, expected.text, expected.reply_to, expected.source, values.submission_id, new Date().toISOString()),
    database.prepare(`INSERT INTO message_details (message_id,kind,submitted_by,turn_id) SELECT ${message_id},'chat',?,NULL`).bind(...key, expected.submitted_by),
    database.prepare(`INSERT INTO message_summaries (message_id,text,author) SELECT ${message_id},?,?`).bind(...key, expected.summary, expected.summary_by),
    ...expected.attachment_ids.map((id, position) => database.prepare(`UPDATE attachments SET message_id=${message_id},position=? WHERE id=?`).bind(...key, position, id)),
    ...(guard.execution_id ? [database.prepare(`INSERT INTO message_timings(message_id,elapsed_seconds)
      SELECT m.id,MAX(0,CAST(strftime('%s',m.created_at) AS INTEGER)-e.created_at) FROM messages m JOIN member_executions e ON e.id=?
      WHERE m.room_id=? AND m.submission_id=?`).bind(guard.execution_id, ...key)] : []),
    ...effects,
  ];
  try { await checked_batch(database, guard.condition, guard.values, statements); }
  catch (error) {
    const saved = await lookup();
    if (saved && String(error).includes("UNIQUE constraint")) { await attach_message_files(database, [saved]); check_retry(saved, expected); return { message: saved, duplicate: true }; }
    if (String(error).includes("attachment_unavailable")) throw new HttpError(409, "附件已用于其他消息，或不属于本次实际提交者");
    if ((proxy || host_proxy) && error instanceof HttpError && error.status === 403) throw new HttpError(409, "代发请求或成员资格已变化；回答未保存");
    if (error instanceof HttpError && error.status === 403) throw new HttpError(409, "本次执行或成员资格已变化；回答未保存，请保留草稿");
    throw error;
  }
  const message = await lookup();
  if (actor !== "用户" || proxy) await advance_session_answer(database, room_id, message.id);
  if (session) {
    const host = await database.prepare("SELECT id FROM room_members WHERE room_id=? AND role='host' AND status='active'").bind(room_id).first();
    if (host) await create_session_task(database, session.id, host.id, "discuss_host", `用户留言 #${message.id}，请读取并处理后继续讨论。`,
      "user_message", message.id);
  }
  await attach_message_files(database, [message]);
  return { message, duplicate: false };
}

/** Validate one web member's request bindings, keeping a live discussion answer separate. */
async function validate_web_proxy_requests(database, room_id, request_ids, member_id = null) {
  if (!Array.isArray(request_ids) || member_id === null && !request_ids.length || request_ids.some(id => !Number.isSafeInteger(id))) {
    throw new HttpError(400, "代发须关联有效的 request_ids");
  }
  const ids = [...new Set(request_ids)];
  const rows = (await database.prepare(`SELECT r.id,r.member_id,r.status,r.purpose,q.status AS session_request_status,s.status AS session_status
    FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id AND q.purpose='discuss'
    LEFT JOIN discussion_sessions s ON s.id=q.session_id WHERE r.room_id=? AND r.id IN (SELECT value FROM json_each(?))`)
    .bind(room_id, JSON.stringify(ids)).all()).results;
  if (rows.length !== ids.length || rows.some(row => row.status !== "pending" || member_id !== null && row.member_id !== member_id)) {
    throw new HttpError(409, "代发请求不属于该在线成员或已处理");
  }
  const members = new Set(rows.map(row => row.member_id));
  if (members.size > 1) throw new HttpError(409, "代发请求必须属于同一在线成员");
  if (rows.some(row => row.purpose === "discuss") && rows.length !== 1) {
    throw new HttpError(400, "讨论安排须单独代发，不能与普通请求合并");
  }
  if (rows.some(row => row.purpose === "discuss" && (row.session_request_status !== "open" || row.session_status !== "active"))) {
    throw new HttpError(409, "讨论安排已暂停、结束或取消，不能继续回答");
  }
  return { ids, member_id: member_id ?? [...members][0] };
}

/** Recheck pending requests and their discussion state in the message write transaction. */
function add_web_proxy_batch_guard(guard, room_id, member_id, ids) {
  const encoded_ids = JSON.stringify(ids);
  return { condition: `${guard.condition} AND
    (SELECT COUNT(*) FROM member_requests WHERE room_id=? AND member_id=? AND status='pending'
      AND id IN (SELECT value FROM json_each(?)))=? AND NOT EXISTS(
    SELECT 1 FROM member_requests r LEFT JOIN session_requests q ON q.member_request_id=r.id AND q.purpose='discuss'
    LEFT JOIN discussion_sessions s ON s.id=q.session_id WHERE r.room_id=? AND r.id IN (SELECT value FROM json_each(?))
      AND r.purpose='discuss' AND (q.id IS NULL OR q.status<>'open' OR s.status<>'active'))`,
    values: [...guard.values, room_id, member_id, encoded_ids, ids.length, room_id, encoded_ids] };
}

/** Save a host note against its live host task without answering or routing it. */
async function append_free_moderation(database, room, payload, actor) {
  const room_id = room.id;
  if (actor === "用户" || actor.role !== "host" || actor.name !== room.host) throw new HttpError(403, "主持说明只能由当前主持成员提交");
  const values = message_values(payload);
  if (values.author !== room.host || (payload.submitted_by ?? values.author) !== values.author) throw new HttpError(403, "主持说明须保留当前主持人署名");
  if (payload.to?.length || payload.handoff || payload.turn_id !== undefined && payload.turn_id !== null) throw new HttpError(400, "主持说明不能派活或关联发言轮次");
  let guard;
  if (actor.access === "manual") {
    const ids = payload.request_ids;
    if (payload.execution_id !== undefined || !Array.isArray(ids) || !ids.length) throw new HttpError(400, "手动主持说明须关联有效的主持请求 request_ids");
    guard = await free_answer_guard(database, room_id, actor, payload);
    const purposes = (await database.prepare(`SELECT purpose FROM member_requests WHERE room_id=? AND id IN (SELECT value FROM json_each(?))`)
      .bind(room_id, JSON.stringify([...new Set(ids)])).all()).results;
    if (purposes.length !== new Set(ids).size || purposes.some(row => row.purpose !== "discuss_host")) throw new HttpError(409, "主持说明只能关联当前有效的主持请求");
  } else {
    if (payload.request_ids?.length) throw new HttpError(400, "自动主持说明须关联执行编号 execution_id");
    guard = await free_answer_guard(database, room_id, actor, payload);
    const purposes = (await database.prepare("SELECT purpose FROM member_requests WHERE execution_id=? AND status='delivering'").bind(guard.execution_id).all()).results;
    if (!purposes.length || purposes.some(row => row.purpose !== "discuss_host")) throw new HttpError(409, "主持说明只能关联当前有效的主持执行");
  }
  const expected = { ...values, kind: "moderation", submitted_by: values.author, turn_id: null,
    source: ["cli", "api"].includes(payload.source) ? payload.source : "cli", attachment_ids: attachment_ids(payload) };
  Object.assign(expected, message_summary(payload, expected));
  const lookup = () => database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
  const previous = await lookup();
  if (previous) { await attach_message_files(database, [previous]); check_retry(previous, expected); return { message: previous, duplicate: true }; }
  await check_message_references(database, room_id, expected);
  await check_message_attachments(database, room_id, expected);
  const key = [room_id, values.submission_id];
  const message_id = "(SELECT id FROM messages WHERE room_id=? AND submission_id=?)";
  const statements = [
    database.prepare(`INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at) VALUES (?,?,?,?,?,?,?)`)
      .bind(room_id, expected.author, expected.text, expected.reply_to, expected.source, values.submission_id, new Date().toISOString()),
    database.prepare(`INSERT INTO message_details (message_id,kind,submitted_by,turn_id) SELECT ${message_id},'moderation',?,NULL`).bind(...key, expected.submitted_by),
    database.prepare(`INSERT INTO message_summaries (message_id,text,author) SELECT ${message_id},?,?`).bind(...key, "", ""),
    ...expected.attachment_ids.map((id, position) => database.prepare(`UPDATE attachments SET message_id=?,position=? WHERE id=?`).bind(...key, position, id)),
  ];
  await checked_batch(database, `${guard.condition} AND NOT EXISTS(SELECT 1 FROM room_directory WHERE room_id=? AND archived=1)`,
    [...guard.values, room_id], statements);
  return { message: await lookup(), duplicate: false };
}

const ADMIN_ITERATIONS = 100000;
const ADMIN_LOCK_THRESHOLD = 5;
const ADMIN_LOCK_SECONDS = 300;
const ADMIN_AVATAR_LIMIT = 60000;
// With a valid admin session these skip the room credential, like directory arrangement.
const ADMIN_ROOM_OPERATIONS = ["rename", "archive", "restore", "delete"];

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
  return { registered: Boolean(admin), setup_available: !admin && Boolean(setup_key || setup),
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

/** Let a logged-in administrator without this room's credential write as its owner. */
async function admin_as_owner(database, request, room_id) {
  if (request.headers.get("X-Discussion-Token") || !request.headers.get("X-Discussion-Admin") || !await admin_session(database, request)) return request;
  const row = await database.prepare("SELECT control_hash FROM room_modes WHERE room_id=?").bind(room_id).first();
  if (!row?.control_hash) return request;
  const headers = new Headers(request.headers);
  headers.set("X-Discussion-Token", owner_proxy_token(row.control_hash));
  return new Request(request, { headers });
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

/** Route JSON operations alongside explicitly bounded binary attachment routes. */
// Room launches relayed to a paired computer; same contract as backend/remote_launch.py.
const MACHINE_ONLINE_SECONDS = 30;
const MACHINE_NAME_MAX = 60;
const REMOTE_PROJECT_NAME_MAX = 80;
const REMOTE_PROJECTS_MAX = 100;
const REMOTE_CLIENTS_MAX = 40;
const REMOTE_CLIENT_FIELD_MAX = 40;
const REMOTE_ERROR_MAX = 2000;
const LAUNCH_STAGES = ["not_started", "unconfirmed", "created", "started"];

/** Hash a machine token; malformed values hash to an empty string and never match. */
async function machine_token_digest(token) {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? digest_hex(token) : "";
}

/** Public machine fields: projects by name and id, and which platforms it can wake. */
function machine_view(row, now) {
  return { id: row.id, name: row.name, projects: JSON.parse(row.projects), clients: JSON.parse(row.clients),
    seen_at: row.seen_at, online: now - row.seen_at <= MACHINE_ONLINE_SECONDS };
}

/** Report a relayed launch without its request, which carries the room's credentials. */
function launch_view(row) {
  return { id: row.id, machine_id: row.machine_id, status: row.status, result: JSON.parse(row.result), error: row.error };
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
  return machine_view(await database.prepare("SELECT * FROM local_machines WHERE id=?").bind(id).first(), now);
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

/** Record the computer's projects and clients, and hand it every launch it has not finished. */
async function machine_sync(database, machine_id, token, payload, now) {
  await require_machine(database, machine_id, token);
  const projects = valid_projects(payload.projects), clients = valid_clients(payload.clients);
  await database.prepare("UPDATE local_machines SET projects=?, clients=?, seen_at=? WHERE id=?").bind(JSON.stringify(projects), JSON.stringify(clients), now, machine_id).run();
  const { results } = await database.prepare("SELECT id,request FROM remote_launches WHERE machine_id=? AND status IN ('pending','claimed') ORDER BY created_at").bind(machine_id).all();
  return { launches: results.map(row => ({ id: row.id, request: JSON.parse(row.request) })) };
}

/** Claim, finish or fail one launch; a finished or failed launch drops its request. */
async function machine_launch_action(database, machine_id, launch_id, token, payload, now) {
  await require_machine(database, machine_id, token);
  const row = await database.prepare("SELECT * FROM remote_launches WHERE id=? AND machine_id=?").bind(launch_id, machine_id).first();
  if (!row) throw new HttpError(404, "启动请求不存在");
  const { action } = payload;
  if (!["claim", "finish", "fail"].includes(action)) throw new HttpError(400, "action 须为 claim、finish 或 fail");
  let statement;
  if (action === "claim") statement = database.prepare("UPDATE remote_launches SET status='claimed', updated_at=? WHERE id=? AND status IN ('pending','claimed')").bind(now, launch_id);
  else if (action === "finish") {
    if (typeof payload.room_id !== "string" || !payload.room_id) throw new HttpError(400, "完成启动须提供 room_id");
    const result = { room_id: payload.room_id, status: String(payload.status || "") };
    statement = database.prepare("UPDATE remote_launches SET status='done', request='{}', result=?, error='', updated_at=? WHERE id=? AND status IN ('pending','claimed')")
      .bind(JSON.stringify(result), now, launch_id);
  } else {
    const result = { stage: LAUNCH_STAGES.includes(payload.stage) ? payload.stage : "unconfirmed", ...(typeof payload.room_id === "string" ? { room_id: payload.room_id } : {}) };
    statement = database.prepare("UPDATE remote_launches SET status='failed', request='{}', result=?, error=?, updated_at=? WHERE id=? AND status IN ('pending','claimed')")
      .bind(JSON.stringify(result), String(payload.error || "启动失败").slice(0, REMOTE_ERROR_MAX), now, launch_id);
  }
  if (!(await statement.run()).meta.changes) throw new HttpError(409, "启动请求已结束");
  return launch_view(await database.prepare("SELECT * FROM remote_launches WHERE id=?").bind(launch_id).first());
}

/** Queue a room creation for the paired computer; resubmitting the same id replays only a failed launch. */
async function submit_remote_launch(database, payload, now) {
  const { id, machine_id, request } = payload;
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new HttpError(400, "启动编号无效");
  if (!request || typeof request !== "object" || Array.isArray(request) || !request.room || typeof request.room !== "object" || request.room.submission_id !== id) {
    throw new HttpError(400, "远程启动只用于新建房间，room.submission_id 须与启动编号一致");
  }
  if (request.cwd || request.access_file) throw new HttpError(400, "远程启动只能选择电脑上已配置的项目，不能指定路径");
  const machine = await database.prepare("SELECT * FROM local_machines WHERE id=?").bind(machine_id ?? "").first();
  if (!machine) throw new HttpError(404, "这台电脑尚未连接网站");
  if (request.local_project && !JSON.parse(machine.projects).some(project => project.id === request.local_project)) throw new HttpError(409, "所选项目已在电脑上移除或更改，请重新选择");
  const text = JSON.stringify(request);
  await database.batch([
    database.prepare("INSERT OR IGNORE INTO remote_launches (id,machine_id,request,created_at,updated_at) VALUES (?,?,?,?,?)").bind(id, machine_id, text, now, now),
    database.prepare("UPDATE remote_launches SET status='pending', request=?, result='{}', error='', updated_at=? WHERE id=? AND machine_id=? AND status='failed'").bind(text, now, id, machine_id),
  ]);
  const row = await database.prepare("SELECT * FROM remote_launches WHERE id=?").bind(id).first();
  if (row.machine_id !== machine_id) throw new HttpError(409, "启动编号已用于另一台电脑");
  return launch_view(row);
}

/** Pair computers and relay room launches; a computer authenticates with its own token, everything else as the administrator. */
async function handle_remote_launch_api(database, request, parts) {
  const now = now_seconds(), method = request.method;
  if (parts[1] === "machines" && method === "POST" && ((parts.length === 4 && parts[3] === "sync") || (parts.length === 5 && parts[3] === "launches"))) {
    const token = request.headers.get("X-Machine-Token") ?? "", payload = await read_payload(request);
    return respond(parts.length === 4 ? await machine_sync(database, parts[2], token, payload, now)
      : await machine_launch_action(database, parts[2], parts[4], token, payload, now));
  }
  await require_admin_session(database, request);
  if (parts.length === 2 && parts[1] === "machines" && method === "GET") {
    const { results } = await database.prepare("SELECT * FROM local_machines ORDER BY seen_at DESC, created_at DESC").all();
    return respond({ machines: results.map(row => machine_view(row, now)) });
  }
  if (parts.length === 2 && parts[1] === "machines" && method === "POST") return respond(await pair_machine(database, await read_payload(request), now));
  if (parts.length === 2 && parts[1] === "remote-launches" && method === "POST") return respond(await submit_remote_launch(database, await read_payload(request), now));
  if (parts.length === 3 && parts[1] === "remote-launches" && method === "GET") {
    const row = await database.prepare("SELECT * FROM remote_launches WHERE id=?").bind(parts[2]).first();
    if (!row) throw new HttpError(404, "启动请求不存在");
    return respond(launch_view(row));
  }
  throw new HttpError(404, "地址不存在");
}

async function handle_api(database, request, parts, params, bucket, setup_key = "") {
  const route = parts.join("/");
  const method = request.method;
  if (route === "api/health" && method === "GET") return respond({ ok: true });
  if (parts[0] === "api" && parts[1] === "admin") return handle_admin_api(database, request, parts, setup_key);
  if (route === "api/scheduler-feedback" && method === "GET") {
    await require_admin_session(database, request);
    return respond(await list_feedback_cases(database, Number(params.after) || 0));
  }
  if (parts[0] === "api" && ["machines", "remote-launches"].includes(parts[1])) return handle_remote_launch_api(database, request, parts);
  if (route === "api/revisions" && method === "GET") return respond(await room_revisions(database, params));
  if (route === "api/rooms") {
    if (method === "GET") return respond(await query_rooms(database, params));
    const room = await create_room(database, await read_payload(request), request.headers.get("X-Discussion-Token") ?? "");
    return respond(room, room.duplicate ? 200 : 201);
  }
  if (route === "api/rooms/import" && method === "POST") {
    const result = await import_room(database, await read_payload(request, MAX_IMPORT_BYTES), request.headers.get("X-Discussion-Token") ?? "");
    return respond(result, result.skipped ? 200 : 201);
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
  request = await admin_as_owner(database, request, room_id);
  const reported = request.headers.get("X-Discussion-Session");
  if (reported) await record_reported_session(database, room_id, request.headers.get("X-Discussion-Token") ?? "",
    { session_id: reported, session_client: request.headers.get("X-Discussion-Session-Client") });
  if (parts[3] === "discussion" && parts.length === 4) {
    if (method === "GET") return respond(await session_view(database, room_id));
    if (method === "POST") return respond(await discussion_control(database, room_id,
      request.headers.get("X-Discussion-Token") ?? "", await read_payload(request)));
  }
  if (parts[3] === "descriptions" && parts.length === 4 && method === "POST") return respond(await describe_members(database, room_id, request.headers.get("X-Discussion-Token") ?? "", await read_payload(request)));
  if (parts[3] === "labels" && parts.length === 4 && method === "POST") return respond(await label_members(database, room_id, request.headers.get("X-Discussion-Token") ?? "", await read_payload(request)));
  if (parts[3] === "chains" && parts.length === 5 && method === "POST") return respond(await free_continue_chain(database, room_id, request.headers.get("X-Discussion-Token") ?? "", integer(parts[4]), await read_payload(request)));
  if (parts[3] === "budget" && parts.length === 4 && method === "POST") return respond(await set_chain_rounds(database, room_id, request.headers.get("X-Discussion-Token") ?? "", await read_payload(request)));
  if (parts[3] === "timeline" && parts.length === 4 && method === "GET") return respond(await execution_timeline(database, room_id, params.after,
    request.headers.get("X-Discussion-Token") ?? ""));
  if (parts[3] === "register" && parts.length === 4 && method === "POST") return respond(await register_member(database, room_id, request.headers.get("X-Discussion-Token") ?? ""));
  if (parts[3] === "messages" && parts.length === 6 && parts[5] === "retract" && method === "POST") {
    return respond(await retract_message(database, room_id, integer(parts[4]), request.headers.get("X-Discussion-Token") ?? ""));
  }
  if (parts[3] === "rewind" && parts.length === 4) {
    const token = request.headers.get("X-Discussion-Token") ?? "";
    if (method === "GET") { await require_free_owner(database, room_id, token); return respond(await rewind_plan(database, room_id, integer(params.message_id ?? 0))); }
    if (method === "POST") return respond(await rewind_room(database, room_id, token, await read_payload(request)));
  }
  if (parts[3] === "speaking-order" && parts.length === 4) {
    if (method === "GET") return respond((await require_room(database, room_id)).speaking_order);
    if (method === "POST") {
      const payload = await read_payload(request);
      await reorder_speakers(database, await require_room(database, room_id), request.headers.get("X-Discussion-Token") ?? "", payload);
      return respond(await require_room(database, room_id));
    }
  }
  if (method === "POST" && parts[3] === "turns" && !await latest_session(database, room_id)) {
    await reject_legacy_session_write(database, room_id);
  }
  const free = await room_mode(database, room_id) === "free";
  const session_model = await has_session_request_model(database, room_id);
  // A discussion keeps the local service's inbox and per-member executions for the user's direct questions.
  if (["inbox", "executions"].includes(parts[3]) || (free && ["members", "suggestions", "recommendations"].includes(parts[3]))) return handle_free_api(database, request, parts);
  if (parts[3] === "members" && method === "POST" && [4, 5].includes(parts.length)) return handle_discussion_members(database, request, parts);
  if (parts[3] === "attachments") return handle_attachments(database, request, parts, params, bucket, free);
  if (["runtime", "events", "scheduler-decisions", "scheduler-routing"].includes(parts[3])) {
    if (["runtime", "events"].includes(parts[3]) && await latest_session(database, room_id)) throw new HttpError(400, `${parts[3]} 已停用：讨论已改用请求与执行接口`);
    const legacy_action = method === "POST" && ["runtime", "events"].includes(parts[3])
      ? (await request.clone().json().catch(() => ({}))).action : "";
    const event_view = parts[3] === "events" && legacy_action === "view";
    if (method === "POST" && ["runtime", "events"].includes(parts[3]) && !event_view) {
      if (session_model) await reject_legacy_session_write(database, room_id);
      throw new HttpError(400, "旧讨论运行接口仅保留历史读取");
    }
    if (free && method === "POST" && !["scheduler-decisions", "scheduler-routing"].includes(parts[3]) && !event_view) {
      throw new HttpError(400, "自由房间不使用讨论运行控制");
    }
    return handle_runtime_api(database, request, parts, params);
  }
  const free_topic = method === "POST" && parts[3] === "topic" && free;
  if (free_topic) {
    const token = request.headers.get("X-Discussion-Token") ?? "";
    const payload = await read_payload(request.clone());
    try { await require_free_owner(database, room_id, token); }
    catch (error) {
      const member = await require_free_member(database, room_id, token, payload.actor);
      if (member.role !== "host" || ![member.name, "用户"].includes(payload.actor)) throw error;
    }
  }
  let free_actor = free_topic ? "用户" : null;
  const admin_bypass = method === "POST" && parts.length === 4 && ADMIN_ROOM_OPERATIONS.includes(parts[3]) && Boolean(await admin_session(database, request));
  if (method === "POST" && parts.length === 4 && DIRECTORY_OPERATIONS.includes(parts[3])) { /* directory arrangement */ }
  else if (admin_bypass) { /* valid admin session replaces the room credential */ }
  else if (method === "POST" && free && !free_topic && !(parts[3] === "turns" && await latest_session(database, room_id))
    && !(session_model && ["limits", "state"].includes(parts[3]))) free_actor = await authorize_free(database, room_id,
    request.headers.get("X-Discussion-Token") ?? "", parts[3] ?? "", await read_payload(request.clone()));
  else if (method === "POST" && parts.length === 4 && parts[3] === "messages" && answers_direct_question(await read_payload(request.clone()))) free_actor = await authorize_free(database, room_id,
    request.headers.get("X-Discussion-Token") ?? "", "messages", await read_payload(request.clone()));
  else if (method === "POST" && !free_topic) database = await authorize_database(database, room_id,
    request.headers.get("X-Discussion-Token") ?? "", parts[3], await read_payload(request.clone()));
  if (parts.slice(3).join("/") === "backup" && method === "GET") return respond(await room_backup(database, room_id,
    request.headers.get("X-Discussion-Token") ?? ""));
  const tail = parts.slice(3).join("/");
  if (tail === "limits") {
    if (await has_session_request_model(database, room_id)) {
      if (method === "GET") {
        await session_view(database, room_id);
        return respond(await session_limits_view(database, room_id));
      }
      return respond(await update_session_limits(database, room_id, request.headers.get("X-Discussion-Token") ?? "", await read_payload(request)));
    }
    if (method === "POST") await reject_legacy_session_write(database, room_id);
    return respond(method === "GET" ? (await require_room(database, room_id)).limits : await check_limits(database, room_id, await read_payload(request)));
  }
  if (["move", "folder", "rename", "archive", "restore", "delete"].includes(tail) && method === "POST") {
    const files = tail === "delete" ? (await database.prepare("SELECT id FROM attachments WHERE room_id=?").bind(room_id).all()).results : [];
    const result = await manage_room(database, room_id, tail, await read_payload(request));
    if (bucket) {
      for (const file of files) await bucket.delete(`rooms/${room_id}/${file.id}`).catch(error => console.error("Attachment cleanup failed", file.id, error));
    }
    return respond(result);
  }
  if (!tail && method === "GET") return respond(await require_room(database, room_id, request.headers.get("X-Discussion-Token") ?? ""));
  if (["topic", "turns", "conclusion"].includes(parts[3])) return handle_host_api(database, request, parts, params);
  if (tail === "messages") {
    if (method === "GET") return respond(await query_messages(database, room_id, params, request.headers.get("X-Discussion-Token") ?? ""));
    const payload = await read_payload(request);
    const result = await append_message(database, room_id, payload, request.headers.get("X-Discussion-Token") ?? "", free_actor);
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (parts.length === 5 && parts[3] === "messages" && method === "GET") {
    return respond(await get_message(database, room_id, parts[4], params, request.headers.get("X-Discussion-Token") ?? ""));
  }
  if (tail === "state" && method === "POST") {
    const payload = await read_payload(request);
    if (await has_session_request_model(database, room_id)) {
      const token = request.headers.get("X-Discussion-Token") ?? "";
      if (payload.actor === '用户') await require_free_owner(database, room_id, token);
      else {
        const actor = await require_free_member(database, room_id, token, payload.actor);
        if (actor.role !== 'host') throw new HttpError(403, '只有当前主持人可以更新讨论状态');
      }
    }
    return respond(await update_state(database, room_id, payload));
  }
  throw new HttpError(404, "地址不存在");
}

/** Handle upload, listing, metadata, and safe content access through an optional R2 binding. */
async function handle_attachments(database, request, parts, params, bucket, free = false) {
  const room_id = parts[2];
  if (parts.length === 4) {
    if (request.method === "GET") return respond(await query_attachments(database, room_id, params));
    if (!bucket) throw new HttpError(503, "附件存储未配置；请绑定 ATTACHMENTS R2 存储桶");
    const metadata = attachment_metadata(params);
    const token = request.headers.get("X-Discussion-Token") ?? "";
    let member_id = null;
    if (free) {
      const actor = await authorize_free(database, room_id, token, "attachments", { author: metadata.actor });
      if ((actor === "用户") !== (metadata.actor === "用户")) throw new HttpError(403, "附件上传者须与凭据身份一致");
      if (actor !== "用户") member_id = actor.id;
    } else database = await authorize_database(database, room_id, token, "attachments", metadata);
    await require_room_id(database, room_id);
    if (Number(request.headers.get("Content-Length")) > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "单个附件最多 20 MiB");
    const result = await store_attachment(database, bucket, room_id, metadata, await read_bytes(request, MAX_ATTACHMENT_BYTES), member_id);
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (request.method === "POST" && parts.length === 6 && parts[5] === "import") {
    if (Number(request.headers.get("Content-Length")) > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "单个附件最多 20 MiB");
    return respond(await import_attachment(database, bucket, room_id, parts[4], request.headers.get("X-Discussion-Token") ?? "",
      await read_bytes(request, MAX_ATTACHMENT_BYTES)));
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
  const has_session_model = await has_session_request_model(database, room_id);
  if (has_session_model && params.legacy === "1" && tail === "turns" && request.method === "GET") return respond(await query_turns(database, room_id, params));
  if (has_session_model && params.legacy === "1" && parts.length === 5 && parts[3] === "turns" && request.method === "GET") {
    return respond(await get_turn(database, room_id, parts[4]));
  }
  if (has_session_model && tail === "turns" && request.method === "GET") return respond(await session_turns(database, room_id, params));
  if (has_session_model && parts.length === 5 && parts[3] === "turns" && parts[4] !== "roster" && request.method === "GET") {
    const row = await database.prepare("SELECT q.*,m.name AS expert FROM session_requests q JOIN room_members m ON m.id=q.member_id WHERE q.id=? AND q.purpose='discuss' AND q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)")
      .bind(integer(parts[4]), room_id).first();
    if (!row) throw new HttpError(404, "讨论安排不存在");
    return respond(row);
  }
  if (await latest_session(database, room_id)) {
    if (tail === "turns/roster" && request.method === "GET") return respond(await session_roster(database, room_id));
    if (tail === "turns" && request.method === "POST") {
      const result = await create_session_plan(database, room_id, await read_payload(request), request.headers.get("X-Discussion-Token") ?? "");
      return respond(result, result.duplicate ? 200 : 201);
    }
    if (tail === "turns/continue" && request.method === "POST") return respond(await continue_session_plan(database, room_id,
      await read_payload(request), request.headers.get("X-Discussion-Token") ?? ""));
    if (parts.length === 5 && parts[3] === "turns") {
      if (request.method === "POST") return respond(await cancel_session_plan(database, room_id, parts[4], await read_payload(request),
        request.headers.get("X-Discussion-Token") ?? ""));
    }
  }
  if (request.method === "POST" && tail.startsWith("turns") && await has_session_request_model(database, room_id)) {
    throw new HttpError(409, "该房间已使用讨论会话请求接口；旧安排表仅保留历史读取");
  }
  if (tail === "topic" && request.method === "POST") return respond(await update_topic(database, room_id, await read_payload(request)));
  if (tail === "conclusion" && request.method === "GET") return respond(await conclusion_view(database, await require_room(database, room_id)));
  if (tail === "turns") {
    if (request.method === "GET") return respond(await query_turns(database, room_id, params));
    const result = await create_turn(database, room_id, await read_payload(request));
    return respond(result, result.duplicate ? 200 : 201);
  }
  if (tail === "turns/roster" && request.method === "GET") return respond(await roster_view(await require_room(database, room_id)));
  if (tail === "turns/continue" && request.method === "POST") return respond(await continue_turns(database, room_id, await read_payload(request)));
  if (parts.length === 5 && parts[3] === "turns") {
    return respond(request.method === "GET" ? await get_turn(database, room_id, parts[4]) :
      await update_turn(database, room_id, parts[4], await read_payload(request)));
  }
  throw new HttpError(404, "地址不存在");
}

/** Serve read-only plain text and reject the retired GET publication endpoint. */
async function handle_text(database, parts, params, token = "") {
  const room_id = parts[1];
  const tail = parts.slice(2).join("/");
  if (!room_id) throw new HttpError(404, "请指定房间");
  if (!tail) return room_text(database, room_id, params);
  if (["brief", "state", "protocol"].includes(tail)) {
    const room = await require_room(database, room_id, token);
    if (tail === "brief") return brief_text(room);
    if (tail === "state") return state_reading_text(room, await initial_session_read_limit(database, room_id, token));
    return protocol_text(room);
  }
  if (tail === "turns") {
    const result = await (await has_session_request_model(database, room_id)
      ? session_turns(database, room_id, params) : query_turns(database, room_id, params));
    const room = await require_room(database, room_id);
    return `第 ${result.page} / ${result.pages} 页，共 ${result.total} 项。\n\n${result.turns.map((turn) => turn_text(turn, room)).join("\n\n")}`;
  }
  if (parts.length === 4 && parts[2] === "turns") {
    const row = await (await has_session_request_model(database, room_id)
      ? database.prepare("SELECT q.*,m.name AS expert FROM session_requests q JOIN room_members m ON m.id=q.member_id WHERE q.id=? AND q.purpose='discuss' AND q.session_id IN (SELECT id FROM discussion_sessions WHERE room_id=?)").bind(integer(parts[3]), room_id).first()
      : get_turn(database, room_id, parts[3]));
    if (!row) throw new HttpError(404, "讨论安排不存在");
    return turn_text(row, await require_room(database, room_id));
  }
  if (tail === "messages" || tail === "search") {
    const result = await query_messages(database, room_id, params, token);
    const items = result.messages.map(message_text);
    const pagination = `第 ${result.page} / ${result.pages} 页，共 ${result.total} 条。翻页：保留查询条件，修改 page 参数。`;
    return `${pagination}\n\n${items.length ? items.join("\n\n---\n\n") : "没有匹配的消息。"}`;
  }
  if (parts.length === 4 && parts[2] === "messages") {
    return message_text(await get_message(database, room_id, parts[3], params, token));
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
      return respond(await handle_text(env.DB, parts, params, request.headers.get("X-Discussion-Token") ?? ""), 200, true);
    }
    // Timeline segments are read by the timeline page on its own schedule, so they wake no other page.
    const action = ["events", "executions"].includes(parts[3]) && request.method === "POST" ? (await request.clone().json().catch(() => ({}))).action : "";
    const quiet_renewal = (parts[3] === "events" && action === "renew") || (parts[3] === "executions" && action === "renew") || action === "segments";
    const response = await handle_api(env.DB, request, parts, params, env.ATTACHMENTS, env.ADMIN_SETUP_KEY);
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
