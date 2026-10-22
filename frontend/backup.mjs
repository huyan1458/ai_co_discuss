import { strFromU8, strToU8, unzip, zip } from "fflate";

const DOWNLOAD_RELEASE_MS = 60000;
const FILENAME_TITLE_LIMIT = 80;
const BACKUP_README = `AI CoDiscuss 聊天室备份

完整数据.json：指定聊天室在导出时的数据库快照，保留全部原始字段、编号和关联。
讨论记录.md：便于离线阅读的资料、消息原文与发言安排，正文以文本块原样保留。

备份不受网页分页、搜索或当前标签限制；未保存的输入草稿不属于服务器数据。
仅保存本聊天室及其所属文件夹信息，不包含其他聊天室、账号或本机配置。
附件/：本聊天室已发送附件的原文件，与完整数据中的附件编号对应。
外部网页、外链图片和外部附件仅保留原链接，不下载其内容；未发送的上传不在备份内。
这是导出时刻的快照，之后的新消息不在包内。
导入：在任一共议网站的房间目录选“导入房间”并选择本 ZIP，即建成可继续使用的副本；已有同一房间时跳过。
`;
const BATCH_README = `AI CoDiscuss 房间批量备份

每个子文件夹是一个房间的完整备份，结构与单个房间备份相同（完整数据.json、讨论记录.md、附件/）。
在任一共议网站的房间目录选“导入房间”并选择本 ZIP，可一次导入全部房间；已有同一房间时跳过。
`;

/** Wrap original text safely, including embedded Markdown fences and HTML. */
function original_block(value) {
  const text = value ?? "";
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Convert one message and its separate provenance rows to a readable record. */
function message_markdown(message, details, summary, attachments) {
  const submitted_by = details?.submitted_by || (["cli", "api", "url", "user"].includes(message.source) ? message.author : "用户");
  const lines = [`<a id="message-${message.id}"></a>`, `### #${message.id} · ${message.author}`,
    `时间：${message.created_at}；来源：${message.source}；职责：${details?.kind || "opinion"}；代发/提交者：${submitted_by}`];
  if (message.reply_to) lines.push(`回复：[#${message.reply_to}](#message-${message.reply_to})`);
  if (details?.turn_id) lines.push(`对应安排：[#${details.turn_id}](#turn-${details.turn_id})`);
  if (summary?.text) lines.push(`简述（作者：${summary.author}）：`, original_block(summary.text));
  lines.push("原文：", original_block(message.text));
  for (const file of attachments) {
    const path = attachment_archive_path(file).split("/").map(part => encodeURIComponent(part).replace(/[()]/g,
      char => `%${char.charCodeAt(0).toString(16)}`)).join("/");
    lines.push(`附件：${original_block(file.file_name)}\n\n[下载原文件](${path}) · ${file.size} 字节 · SHA-256: ${file.sha256}`);
  }
  return lines.join("\n\n");
}

/** Render the complete snapshot as text without interpreting message HTML. */
export function room_markdown(snapshot) {
  const tables = snapshot.tables;
  const room = tables.rooms[0];
  const settings = tables.topic_settings[0];
  const request = tables.room_user_requests?.[0];
  const legacy = !request && settings?.background.match(/^用户原文[：:][ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n){2,}((?:项目背景与入口|背景)[：:][\s\S]*)$/);
  const user_request = request?.text ?? (legacy ? legacy[1] : "");
  const background = legacy ? legacy[2] : settings?.background;
  const brief = tables.room_briefs[0];
  const details = new Map(tables.message_details.map((row) => [row.message_id, row]));
  const summaries = new Map(tables.message_summaries.map((row) => [row.message_id, row]));
  const lines = ["# 讨论记录", original_block(room.title),
    `房间：${room.id}；创建：${room.created_at}；导出：${snapshot.exported_at}`,
    `来源：${snapshot.source_url || "未记录"}`, `消息：${tables.messages.length} 条；发言安排：${tables.discussion_turns.length} 项`,
    `目录状态：${tables.room_directory[0]?.archived ? "已存档" : "使用中"}；文件夹：${tables.topic_folders[0]?.name || "未分组"}`,
    "## 目标", original_block(room.goal)];
  if (settings) lines.push(`主持人：${settings.host}；阶段：${settings.phase}`, "参与配置：", original_block(settings.experts),
    "## 用户原文", original_block(user_request), "## 背景", original_block(background), "## 讨论边界", original_block(settings.boundaries),
    "## 当前焦点", original_block(settings.focus));
  if (brief) lines.push("## 主持简报", `覆盖至 #${brief.until}；更新：${brief.updated_at}`, original_block(brief.text));
  if (tables.discussion_limits?.[0]) lines.push("## 讨论上限", original_block(JSON.stringify(tables.discussion_limits[0], null, 2)));
  lines.push("## 共识与分歧", `覆盖至 #${room.state_until}`, original_block(room.state_text),
    "## 发言权", original_block(JSON.stringify(tables.room_floor[0] || {}, null, 2)), "## 全部消息");
  for (const message of tables.messages) lines.push(message_markdown(message, details.get(message.id), summaries.get(message.id),
    (tables.attachments || []).filter(file => file.message_id === message.id)));
  if (!tables.messages.length) lines.push("暂无消息。");
  lines.push("## 全部发言安排");
  for (const turn of tables.discussion_turns) {
    lines.push(`<a id="turn-${turn.id}"></a>`, `### 安排 #${turn.id} · ${turn.expert}`,
      `状态：${turn.status}；创建：${turn.created_at}；通知：${turn.notified_at || "未记录"}`,
      original_block(turn.question));
    if (turn.answer_id) lines.push(`回答：[#${turn.answer_id}](#message-${turn.answer_id})`);
  }
  if (!tables.discussion_turns.length) lines.push("暂无发言安排。");
  return lines.join("\n\n") + "\n";
}

/** Keep each archived filename unique and portable without trusting path separators. */
export function attachment_archive_path(file) {
  const name = file.file_name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "") || "附件";
  return `附件/${file.id}_${name}`;
}

/** Fetch only this site's managed attachment bytes, not arbitrary URLs in message text. */
async function fetch_attachment(file) {
  const response = await fetch(`/api/rooms/${encodeURIComponent(file.room_id)}/attachments/${encodeURIComponent(file.id)}/content?download=1`);
  if (!response.ok) throw new Error(`附件下载失败：${file.file_name}，未生成备份`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== file.size) throw new Error(`附件不完整：${file.file_name}，未生成备份`);
  if (globalThis.crypto?.subtle) {
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== file.sha256) throw new Error(`附件校验失败：${file.file_name}，未生成备份`);
  }
  return bytes;
}

/** Add one room's snapshot, readable record and original files under a folder prefix. */
async function add_room_files(files, snapshot, prefix, load_attachment) {
  files[`${prefix}完整数据.json`] = strToU8(JSON.stringify(snapshot, null, 2) + "\n");
  files[`${prefix}讨论记录.md`] = strToU8(room_markdown(snapshot));
  for (const file of snapshot.tables.attachments || []) files[prefix + attachment_archive_path(file)] = [await load_attachment(file), { level: 0 }];
}

/** Compress archive entries, resolving only once the whole package exists. */
function compress(files) {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (error, data) => error ? reject(error) : resolve(data));
  });
}

/** Make a title usable as a portable file or folder name. */
function safe_title(title) {
  return [...title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")].slice(0, FILENAME_TITLE_LIMIT).join("").replace(/[. ]+$/, "") || "讨论";
}

/** Package a versioned snapshot and all published original files without partial success. */
export async function create_room_archive(snapshot, load_attachment = fetch_attachment) {
  const files = { "备份说明.txt": strToU8(BACKUP_README) };
  await add_room_files(files, snapshot, "", load_attachment);
  return compress(files);
}

/** Package several rooms, one folder each, so the whole set imports in one step. */
export async function create_rooms_archive(snapshots, load_attachment = fetch_attachment) {
  const files = { "备份说明.txt": strToU8(BATCH_README) };
  for (const snapshot of snapshots) {
    const room = snapshot.tables.rooms[0];
    await add_room_files(files, snapshot, `${safe_title(room.title)}_${room.id}/`, load_attachment);
  }
  return compress(files);
}

/** Read every room backup in a single or batch ZIP (or a bare 完整数据.json), with original files keyed by attachment ID. */
export async function read_room_archives(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith(".json")) return [{ snapshot: JSON.parse(strFromU8(bytes)), files: new Map() }];
  const entries = await new Promise((resolve, reject) => unzip(bytes, (error, data) => error ? reject(new Error(`${file.name} 不是有效的 ZIP 备份`)) : resolve(data)));
  const rooms = Object.keys(entries).filter(path => /^(?:[^/]+\/)?完整数据\.json$/.test(path)).map(path => {
    const prefix = path.slice(0, -"完整数据.json".length), snapshot = JSON.parse(strFromU8(entries[path]));
    const files = new Map((snapshot.tables?.attachments || []).map(item => [item.id, entries[prefix + attachment_archive_path(item)]]).filter(([, data]) => data));
    return { snapshot, files };
  });
  if (!rooms.length) throw new Error(`${file.name} 中没有房间备份（完整数据.json）`);
  return rooms;
}

/** Start a browser download of a finished archive. */
function save_archive(archive, name) {
  const url = URL.createObjectURL(new Blob([archive], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  try { link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_RELEASE_MS); }
}

/** Start a browser download after the whole archive has been successfully built. */
export async function download_room_backup(snapshot) {
  const archive = await create_room_archive(snapshot);
  save_archive(archive, `${safe_title(snapshot.tables.rooms[0].title)}_${snapshot.exported_at.replace(/[:.]/g, "-")}.zip`);
}

/** Download several rooms as one batch archive named after the selection. */
export async function download_rooms_backup(snapshots, name) {
  const archive = await create_rooms_archive(snapshots);
  save_archive(archive, `${safe_title(name)}_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`);
}
