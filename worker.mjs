/** Cloudflare Workers / D1 adapter for the existing discussion HTTP protocol. */
const MAX_BODY_BYTES = 65536;
const MAX_TEXT_LENGTH = 4000;
const PAGE_SIZE = 20;
const PARTICIPANTS = ["用户", "Codex", "Claude", "Gemini", "DeepSeek", "Qwen"];
const PHASES = { preparing: "准备中", initial: "独立观点", discussing: "深入讨论", reviewing: "结论复核", paused: "已暂停", concluded: "已收束" };
const TURN_STATUSES = { pending: "待通知", notified: "已通知，待回答", answered: "已回答", cancelled: "已取消" };
const MAX_TOPIC_DETAIL = 4000;
const MAX_QUESTION_LENGTH = 1000;
const MESSAGE_QUERY = `SELECT messages.*, COALESCE(details.kind,'opinion') AS kind,
  COALESCE(details.submitted_by, CASE WHEN messages.source IN ('cli','url','user')
  THEN messages.author ELSE '用户' END) AS submitted_by, details.turn_id
  FROM messages LEFT JOIN message_details AS details ON details.message_id=messages.id`;
const ROOM_QUERY = `SELECT rooms.*, COUNT(messages.id) AS message_count,
  COALESCE(MAX(messages.id),0) AS latest_id FROM rooms
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
      "X-Robots-Tag": "noindex, nofollow",
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

/** Read a bounded JSON object from a browser request. */
async function read_payload(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "请求内容为空或过大");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(400, "请求内容为空或过大");
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
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

/** Read a room with its actual history count and latest message ID. */
async function require_room(database, room_id) {
  const room = await database.prepare(`${ROOM_QUERY} WHERE rooms.id=? GROUP BY rooms.id`)
    .bind(room_id).first();
  if (!room) throw new HttpError(404, "房间不存在");
  const settings = await database.prepare("SELECT * FROM topic_settings WHERE room_id=?").bind(room_id).first();
  const current_turn = await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id DESC LIMIT 1").bind(room_id).first();
  return { ...room, ...(settings ? { ...settings, experts: JSON.parse(settings.experts) } : topic_defaults()), current_turn };
}

/** Return independent defaults for legacy rooms without settings. */
function topic_defaults() {
  return { host: "用户", background: "", boundaries: "", phase: "preparing", focus: "",
    experts: Object.fromEntries(PARTICIPANTS.slice(1).map((name) => [name, name === "Codex" ? "cli" : "online"])) };
}

/** Validate topic information and require an AI host to have CLI capability. */
function topic_values(payload, current = {}) {
  const result = { ...topic_defaults(), ...current };
  const limits = { title: 80, goal: 1000, background: MAX_TOPIC_DETAIL, boundaries: MAX_TOPIC_DETAIL, focus: MAX_QUESTION_LENGTH };
  for (const [field, limit] of Object.entries(limits)) {
    result[field] = String(payload[field] ?? result[field] ?? "").trim();
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
  return result;
}

/** Prepare an upsert shared by topic creation and maintenance. */
function topic_statement(database, room_id, settings) {
  return database.prepare(`INSERT INTO topic_settings (room_id,host,background,boundaries,experts,phase,focus)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET host=excluded.host,background=excluded.background,
    boundaries=excluded.boundaries,experts=excluded.experts,phase=excluded.phase,focus=excluded.focus`)
    .bind(room_id, settings.host, settings.background, settings.boundaries, JSON.stringify(settings.experts), settings.phase, settings.focus);
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
  const turn = room.current_turn;
  if (turn && ["pending", "notified"].includes(turn.status) && (settings.phase === "concluded" || !settings.experts[turn.expert])) {
    throw new HttpError(400, "请先完成或取消当前发言安排");
  }
  try {
    await database.batch([
      database.prepare("UPDATE rooms SET title=?,goal=? WHERE id=?").bind(settings.title, settings.goal, room_id),
      topic_statement(database, room_id, settings),
    ]);
  } catch (error) {
    if (String(error).includes("open_turn")) throw new HttpError(400, "请先完成或取消当前发言安排");
    throw error;
  }
  return require_room(database, room_id);
}

/** Create the room and topic settings together. */
async function create_room(database, payload) {
  const settings = topic_values(payload);
  const room_id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  await database.batch([
    database.prepare("INSERT INTO rooms (id,title,goal,created_at) VALUES (?,?,?,?)")
      .bind(room_id, settings.title, settings.goal, new Date().toISOString()),
    topic_statement(database, room_id, settings),
  ]);
  return require_room(database, room_id);
}

/** Normalize and validate a message before either URL or JSON publication. */
function message_values(payload) {
  const author = String(payload.author ?? "").trim();
  const text = String(payload.text ?? "").trim();
  const submission_id = String(payload.submission_id ?? "").trim();
  const reply_to = payload.reply_to ? integer(payload.reply_to) : null;
  if (!PARTICIPANTS.includes(author)) throw new HttpError(400, "请选择有效的发言者");
  if (!text || text_length(text) > MAX_TEXT_LENGTH) {
    throw new HttpError(400, `发言需为 1–${MAX_TEXT_LENGTH} 字`);
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(submission_id)) {
    throw new HttpError(400, "submission_id 必须是 8–100 位字母、数字、下划线或连字符；同一次提交应重复使用相同编号");
  }
  return { author, text, submission_id, reply_to };
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

/** Compare semantic content, including provenance and assignment linkage. */
function check_retry(previous, expected) {
  if (["author", "text", "reply_to", "kind", "submitted_by", "turn_id"].some((key) => previous[key] !== expected[key])) {
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
function message_statements(database, room_id, message) {
  const { author, text, submission_id, reply_to, source, kind, submitted_by, turn_id } = message;
  return [
    database.prepare(`INSERT INTO messages (room_id,author,text,reply_to,source,submission_id,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
      .bind(room_id, author, text, reply_to, source, submission_id, new Date().toISOString()),
    database.prepare(`INSERT INTO message_details (message_id,kind,submitted_by,turn_id)
      SELECT id,?,?,? FROM messages WHERE room_id=? AND submission_id=? AND author=? AND text=? AND reply_to IS ?
      ON CONFLICT(message_id) DO NOTHING`).bind(kind, submitted_by, turn_id, room_id, submission_id, author, text, reply_to),
    database.prepare(`UPDATE discussion_turns SET status='answered',answer_id=(SELECT id FROM messages WHERE room_id=? AND submission_id=?)
      WHERE id=? AND status IN ('pending','notified') AND EXISTS
      (SELECT 1 FROM messages JOIN message_details ON messages.id=message_details.message_id
      WHERE messages.room_id=? AND messages.submission_id=? AND message_details.turn_id=discussion_turns.id)`)
      .bind(room_id, submission_id, turn_id, room_id, submission_id),
    database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, submission_id),
  ];
}

/** Atomically append a message, preserving idempotency under concurrent retries. */
async function append_message(database, room_id, payload) {
  const values = message_values(payload);
  const room = await require_room(database, room_id);
  const expected = { ...values, ...message_details(room, { ...payload, author: values.author }) };
  const previous = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND submission_id=?`).bind(room_id, values.submission_id).first();
  if (previous) { check_retry(previous, expected); return { message: previous, duplicate: true }; }
  if (["paused", "concluded"].includes(room.phase) && expected.kind === "opinion") throw new HttpError(400, "话题已暂停或收束；恢复阶段后才能提交新观点，运行回执请用 receipt");
  await check_message_references(database, room_id, expected);
  let results;
  try { results = await database.batch(message_statements(database, room_id, expected)); }
  catch (error) {
    if (String(error).includes("topic_inactive")) throw new HttpError(400, "话题已暂停或收束，请重新读取阶段");
    if (String(error).includes("UNIQUE constraint") || String(error).includes("turn_unavailable")) throw new HttpError(409, "该发言安排已有回答或已取消，请重新读取核对");
    throw error;
  }
  const message = results[3].results[0];
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
  await require_room(database, room_id);
  const page = Math.max(1, integer(params.page ?? 1));
  const results = await database.batch([
    database.prepare("SELECT COUNT(*) AS total FROM discussion_turns WHERE room_id=?").bind(room_id),
    database.prepare("SELECT * FROM discussion_turns WHERE room_id=? ORDER BY id LIMIT ? OFFSET ?").bind(room_id, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = results[0].results[0].total;
  return { turns: results[1].results, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Schedule one expert; creation does not send a notification. */
async function create_turn(database, room_id, payload) {
  const room = await require_room(database, room_id);
  require_host(room, payload);
  const { author: expert, text: question, submission_id } = message_values({ author: payload.expert, text: payload.question, submission_id: payload.submission_id });
  const previous = await database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND submission_id=?").bind(room_id, submission_id).first();
  if (previous) {
    if (previous.expert !== expert || previous.question !== question) throw new HttpError(409, "该安排编号已被其他内容使用");
    return { turn: previous, duplicate: true };
  }
  if (!room.experts[expert] || text_length(question) > MAX_QUESTION_LENGTH) throw new HttpError(400, "请选择参与专家，待回应问题最多 1000 字");
  if (["paused", "concluded"].includes(room.phase)) throw new HttpError(400, "话题已暂停或收束，请先调整阶段");
  let results;
  try {
    results = await database.batch([
      database.prepare(`INSERT INTO discussion_turns (room_id,expert,question,submission_id,created_at)
        VALUES (?,?,?,?,?) ON CONFLICT(room_id,submission_id) DO NOTHING RETURNING id`)
        .bind(room_id, expert, question, submission_id, new Date().toISOString()),
      database.prepare("SELECT * FROM discussion_turns WHERE room_id=? AND submission_id=?").bind(room_id, submission_id),
    ]);
  } catch (error) {
    if (String(error).includes("topic_inactive")) throw new HttpError(400, "话题已暂停或收束，请重新读取阶段");
    if (String(error).includes("UNIQUE constraint")) throw new HttpError(409, "请先完成或取消当前发言安排");
    throw error;
  }
  const turn = results[1].results[0];
  if (turn.expert !== expert || turn.question !== question) throw new HttpError(409, "该安排编号已被其他内容使用");
  return { turn, duplicate: results[0].results.length === 0 };
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
    AND (?='cancelled' OR NOT EXISTS (SELECT 1 FROM topic_settings WHERE room_id=discussion_turns.room_id AND phase IN ('paused','concluded')))`)
    .bind(status, status === "notified" ? new Date().toISOString() : turn.notified_at, turn.id, status).run();
  const updated = await get_turn(database, room_id, turn_id);
  if (updated.status !== status) throw new HttpError(409, "话题阶段或发言安排已变化，请重新读取核对");
  return updated;
}

/** Retrieve bounded history pages with keyword, author, and mention filters. */
async function query_messages(database, room_id, params) {
  await require_room(database, room_id);
  const page = Math.max(1, integer(params.page ?? 1));
  const clauses = ["room_id=?"];
  const values = [room_id];
  const query = String(params.q ?? "").trim();
  const author = String(params.author ?? "").trim();
  const mention = String(params.mention ?? "").trim();
  if (query) {
    clauses.push("(instr(lower(text),lower(?)) > 0 OR CAST(messages.id AS TEXT)=?)");
    values.push(query, query.replace(/^#+/, ""));
  }
  if (author) { clauses.push("author=?"); values.push(author); }
  if (mention) { clauses.push("instr(text,?) > 0"); values.push(`@${mention}`); }
  const where = clauses.join(" AND ");
  const results = await database.batch([
    database.prepare(`SELECT COUNT(*) AS total FROM messages WHERE ${where}`).bind(...values),
    database.prepare(`${MESSAGE_QUERY} WHERE ${where} ORDER BY messages.id LIMIT ? OFFSET ?`)
      .bind(...values, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  ]);
  const total = results[0].results[0].total;
  return { messages: results[1].results, page, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
}

/** Read exact message text only inside its owning room. */
async function get_message(database, room_id, message_id) {
  const message = await database.prepare(`${MESSAGE_QUERY} WHERE room_id=? AND messages.id=?`)
    .bind(room_id, integer(message_id)).first();
  if (!message) throw new HttpError(404, "消息不存在");
  return message;
}

/** Save the human-maintained state without advancing its evidence boundary. */
async function update_state(database, room_id, payload) {
  const text = String(payload.text ?? "").trim();
  if (text_length(text) > MAX_TEXT_LENGTH) throw new HttpError(400, "讨论状态最多 4000 字");
  const room = await require_room(database, room_id);
  require_host(room, { actor: payload.actor ?? "用户" });
  const until = integer(payload.until ?? room.latest_id);
  if (until < 0 || until > room.latest_id) throw new HttpError(400, "讨论状态的截止编号无效");
  await database.prepare("UPDATE rooms SET state_text=?,state_until=? WHERE id=?")
    .bind(text, until, room_id).run();
  return require_room(database, room_id);
}

/** Render a message with its provenance and original reply reference. */
function message_text(message) {
  const reply = message.reply_to ? ` · 回复 #${message.reply_to}` : "";
  const role = { moderation: "主持发言", receipt: "运行回执" }[message.kind] || "专家观点";
  return `#${message.id} · ${message.author} · ${message.created_at}${reply}\n职责：${role}；来源：${message.source}；提交者：${message.submitted_by ?? "用户"}；安排：${message.turn_id || "无"}\n${message.text}`;
}

/** Expose an overview; supporting context is available only through chosen links. */
async function room_text(database, room_id, params) {
  const room = await require_room(database, room_id);
  const base = `/r/${room_id}`;
  const content = [`# ${room.title}`, `目标：${room.goal}`,
    `主持人：${room.host}；阶段：${PHASES[room.phase]}；当前焦点：${room.focus || "尚未填写"}`,
    `当前记录截止 #${room.latest_id}；共 ${room.message_count} 条。`];
  const turn = room.current_turn;
  if (room.phase === "initial") content.push("本阶段先独立形成详细观点：仅阅读目标、背景、边界和自己的已有讨论；暂不阅读他人观点或主持总结。提交后再交叉阅读。这是参与约定，不是权限隔离。");
  if (["paused", "concluded"].includes(room.phase)) content.push("停止处理发言安排，取消本讨论自己的后台任务；核对实际状态后提交运行回执。不要因旧通知恢复讨论。");
  if (turn) content.push(`当前安排 #${turn.id}：${turn.expert} · ${TURN_STATUSES[turn.status]}`, `待回应问题：${turn.question}`, `安排详情：${base}/turns/${turn.id}`);
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
      "请读取议题、状态和相关原文，在你自己的聊天窗口输出观点，并注明引用的消息编号；需要留档时由用户代发。",
      "不要操作网页表单、调用写入接口或生成发布链接，不要求获取发布回执。读取失败时如实报告，由用户提供复制的材料。");
  }
  content.push("参与方式按运行环境区分；主持人可以兼任专家；作者、职责与来源尚未认证。不调用模型服务 API。");
  return content.join("\n\n");
}

/** Render the detailed brief only when selected by a reader. */
function brief_text(room) {
  const experts = Object.entries(room.experts).map(([name, mode]) => `- ${name}：${mode === "cli" ? "本地 CLI 读写" : "在线只读"}`).join("\n");
  return `# ${room.title} · 话题资料\n\n目标：${room.goal}\n\n背景：\n${room.background || "未填写"}\n\n边界：\n${room.boundaries || "未填写"}\n\n主持人：${room.host}（可兼任专家）\n\n参与专家：\n${experts}`;
}

/** Render an assignment without embedding topic context. */
function turn_text(turn, room_id) {
  const answer = turn.answer_id ? `\n回答原文：/r/${room_id}/messages/${turn.answer_id}` : "";
  return `安排 #${turn.id} · ${turn.expert} · ${TURN_STATUSES[turn.status]}\n待回应问题：${turn.question}\n话题入口：/r/${room_id}?participant=${turn.expert}\n回答关联 turn_id：${turn.id}${answer}\n复制通知不代表已送达；实际通知后由主持人确认。`;
}

/** Describe CLI host operations separately from topic material. */
function protocol_text(room) {
  const base = `/api/rooms/${room.id}`;
  return ["# 本地 CLI 读写与主持协议", `当前主持人：${room.host}。以下为留言板接口，不是模型服务 API。`,
    "所有写入使用 POST 和 Content-Type: application/json。主持操作填写 actor 为当前主持人或用户；这些是声明身份，不是认证凭据。",
    '创建话题：POST /api/rooms；字段 title、goal、background、boundaries、host、experts，例如 experts={"Codex":"cli","Gemini":"online"}。AI 主持人必须配置为 cli。',
    `维护话题：POST ${base}/topic；actor 加需要修改的上述字段，另可更新 phase（preparing/initial/discussing/reviewing/paused/concluded）、focus。收束前先完成或取消当前安排。暂停保留安排；恢复阶段后再继续。`,
    `安排发言：POST ${base}/turns；字段 actor、expert、question、submission_id（新 UUID）。同一话题同时只有一个未完成安排；重试沿用同一编号和问题。`,
    `通知：仅把对象、问题、话题入口交给对应专家，不附背景、摘要或历史。使用已有且获准的会话通道；没有通道时交由用户协助。实际送达后 POST ${base}/turns/安排编号，字段 actor、status=notified；取消用 status=cancelled。复制不算送达。`,
    `专家观点：POST ${base}/messages；author、text、submission_id、source=cli，kind=opinion；可选 reply_to（本话题原文编号）、turn_id（回答的安排编号）。`,
    `主持发言：同一消息接口，author=${room.host}、submitted_by=${room.host}、kind=moderation、source=cli；个人观点使用 kind=opinion，不能自动视为共识。`,
    `代发只读专家观点：author 保留原专家，submitted_by=${room.host}、kind=opinion、text 为原文；可附 reply_to 和 turn_id。服务保存代发来源；不要冒充专家直接提交。`,
    `整理状态：POST ${base}/state；actor、text、until（依据的消息截止编号）。这不覆盖原始记录，也不代表全体专家一致同意。`,
    "讨论方法：initial 先独立给出结论、依据、假设和风险，不回应他人；discussing 围绕具体分歧引用原文，说明维持或修正及原因；reviewing 检查拟定结论是否误述自己、遗漏条件或仍有阻碍。沉默不算同意。",
    `运行回执：POST ${base}/messages；author 使用实际身份、kind=receipt、source=cli、text 记录本次运行编号、任务编号、启动或停止状态及实际证据，submission_id 同次重试不变，不填 turn_id。回执不算专家观点或已回答。`,
    "后台参与：先立即检查，再用本会话真实可用的后台任务按约定频率和上限检查；未配置时不自称在线。只答自己未完成的安排，每项一次；无新安排不发言。paused/concluded 或达到上限时停止自己的任务并报告结果。失败时保留未提交原文；重新读取阶段后再决定是否重试。",
    "收束：结论须有原文依据，区分明确共识、未决分歧与主持人判断；完成约定复核或达到已说明的时间/轮次上限后收束。讨论完成与后台任务退出分别核验；不为追求全员确认无限续轮。",
    "消息与安排都按 submission_id 去重，改变内容需新编号。写入后重新读取服务器返回的原文或安排，核对身份、内容与引用。",
  ].join("\n\n");
}

/** Route the existing JSON API without changing frontend callers. */
async function handle_api(database, request, parts, params) {
  const route = parts.join("/");
  const method = request.method;
  if (route === "api/health" && method === "GET") return respond({ ok: true });
  if (route === "api/rooms") {
    if (method === "GET") {
      const rows = await database.prepare(`${ROOM_QUERY} GROUP BY rooms.id ORDER BY rooms.created_at,rooms.id`).all();
      return respond({ rooms: rows.results, participants: PARTICIPANTS });
    }
    return respond(await create_room(database, await read_payload(request)), 201);
  }
  if (parts.length < 3 || parts[0] !== "api" || parts[1] !== "rooms") {
    throw new HttpError(404, "地址不存在");
  }
  const room_id = parts[2];
  const tail = parts.slice(3).join("/");
  if (!tail && method === "GET") return respond(await require_room(database, room_id));
  if (["topic", "turns"].includes(parts[3])) return handle_host_api(database, request, parts, params);
  if (tail === "messages") {
    if (method === "GET") return respond(await query_messages(database, room_id, params));
    const payload = await read_payload(request);
    const result = await append_message(database, room_id, payload);
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
    if (tail === "state") return `主持人维护的状态（整理至 #${room.state_until}）\n\n${room.state_text || "尚未整理"}`;
    return protocol_text(room);
  }
  if (tail === "turns") {
    const result = await query_turns(database, room_id, params);
    return `第 ${result.page} / ${result.pages} 页，共 ${result.total} 项。\n\n${result.turns.map((turn) => turn_text(turn, room_id)).join("\n\n")}`;
  }
  if (parts.length === 4 && parts[2] === "turns") return turn_text(await get_turn(database, room_id, parts[3]), room_id);
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

/** Dispatch Worker requests, preserving HEAD's no-publication behavior. */
async function fetch_request(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const text_mode = parts[0] === "r";
  try {
    if (url.pathname === "/robots.txt") return respond("User-agent: *\nDisallow: /\n", 200, true);
    if (!["api", "r"].includes(parts[0])) return env.ASSETS.fetch(request);
    if (!["GET", "POST"].includes(request.method)) return new Response(null, { status: 501 });
    const params = Object.fromEntries(url.searchParams);
    if (text_mode && request.method === "GET") {
      return respond(await handle_text(env.DB, parts, params), 200, true);
    }
    return await handle_api(env.DB, request, parts, params);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 500 ? "服务器内部错误" : error.message;
    return respond(text_mode ? message : { error: message }, status, text_mode);
  }
}

export default { fetch: fetch_request };
