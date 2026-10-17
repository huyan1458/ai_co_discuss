/** 微信 iLink 与已有 Codex 聊天之间的持久文本桥接。 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { CodexAppClient, CodexClient, MessageStore, process_message } from './message_bridge.mjs';
import {
  acquire_account_lock, begin_login, complete_login, IlinkClient, IlinkError, load_account,
} from './weixin_client.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE = resolve(ROOT, 'data/message-bridge.sqlite3');
const DEFAULT_ACCOUNT = resolve(ROOT, 'data/weixin-account.json');
const DEFAULT_CODEX = process.platform === 'win32' ? 'codex.exe' : 'codex';
const INTERVAL_MS = 2_000;
const QUEUED_NOTICE_MS = 60_000;
const CHUNK_BYTES = 3_500;
const ALIAS_PATTERN = /^[\p{L}][\p{L}\p{N}_-]{0,31}$/u;
const THREAD_PATTERN = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const NOTICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,100}$/;
const REPLY_PATTERN = /^\[Codex #(\d+) [^\]\r\n]+\]/;
const QUESTION_PATTERN = /^\[Codex 提问 ([A-Za-z0-9_-]{8,100})\]/;
const LISTENER_START_MS = 5_000;
const LISTENER_CHECK_MS = 100;
const NEW_COMMAND_PATTERN = /^\/new(?:\s+([\s\S]*))?$/i;
const CHAT_COMMAND_PATTERN = /^\/(\S*)(?:\s+([\s\S]*))?$/;
const CHAT_LIST_LIMIT = 10;
const CHAT_TITLE_LIMIT = 80;
const NEW_CHAT_TITLE_LIMIT = 24;
const CHAT_HELP = `微信便捷命令：
/help — 查看用法
/status — 当前聊天与消息投递状态
/resume — 查看会话列表（/sessions、/rusume 也可用）
/resume 后可单独回复序号切换；名称后的（当前绑定）标识当前窗口
/resume 序号 [消息] — 切换聊天，可同时发送消息，例如 /resume 2 你是窗口几？
/new [问题] — 先选项目，再新建聊天；0 表示无项目
/clear — 清理旧对话列表，保留当前对话

按上述格式发送；Codex 新消息成功发到微信后自动绑定其来源，引用回复仍进入原消息所属聊天。`;

const USAGE = `微信直连桥接（Node.js 24+；不需要 Hermes / OpenClaw）
  node weixin_bridge.mjs login
  node weixin_bridge.mjs login --complete [--verify-code 手机显示的数字]
  node weixin_bridge.mjs notify --message-id 唯一编号 --text '通知内容'
  node weixin_bridge.mjs notify --message-id 唯一编号 --text-file UTF8文件
  node weixin_bridge.mjs notify-status [--message-id 唯一编号]
  node weixin_bridge.mjs ask --message-id 唯一编号 --text-file UTF8文件 [--thread UUID]
  node weixin_bridge.mjs listen-start
  node weixin_bridge.mjs reply-status
  node weixin_bridge.mjs new-claim --request-id 内部编号
  node weixin_bridge.mjs new-complete --request-id 内部编号 --thread 新UUID [--title 聊天名称]
  node weixin_bridge.mjs sync
  node weixin_bridge.mjs bind --alias 测试 --thread UUID [--default]
  node weixin_bridge.mjs unbind --alias 测试
  node weixin_bridge.mjs run
  node weixin_bridge.mjs status

共用选项：--account 凭据文件；--state SQLite文件；--codex 原生可执行文件
login 生成本地二维码；扫码后 login --complete 确认，最多等待60秒。
notify 只发送指定通知后退出；有来源聊天时确保后台收件器运行，允许微信直接回复。
不执行模型任务；正文含来源标题不超过3500个UTF-8字节。
notify 不获取收件锁，可与后台收件程序同时运行。
ask 记录来源聊天并发送问题；thread 默认取当前 CODEX_THREAD_ID。
notify/ask 自动使用来源聊天名称，可用 --title 传入已经核实的名称。
微信只显示纯文本及 Codex（聊天名称）：；引用通过内部回执定位。
微信支持 /help、/status、/resume [序号 [消息]]、/clear，以及 /new [问题]。
/resume 无参数时查看会话列表，兼容 /sessions 和 /rusume。
/clear 清理旧对话列表并保留当前对话；只有 /new 申请新聊天，不继承旧历史。
listen-start 启动一个后台微信收件器；listen 可前台运行（支持 --once）。
普通回复跟随最近发出通知或问题的聊天；手动切换立即生效，之后的新通知会更新目标；引用仍回原消息的来源。
回复只经 codex queue 投递；不扫描历史、不调用模型生成通知、不安装 Hook。
相同编号和正文不重复发送；notify-status 只查本地配置或指定通知。
sync 只读取一批微信消息刷新上下文，不投递命令、不回信；最多等待40秒。
run 持续收发，Ctrl+C 停止；--once 只完成一次收件及处理检查。
微信中用 #别名 正文 或 #回复编号 正文；直接输入发往默认聊天。
只接受扫码账号的私聊文字；普通引用需包含本桥接回复头，否则不猜测目标。
API受理不等于手机送达；结果不明的发送保留 uncertain，不自动重发。
`;

/** Split text on Unicode code points while bounding each payload's UTF-8 size. */
export function split_text(text, limit = CHUNK_BYTES) {
  const chunks = [];
  let chunk = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/** Distinguish new user text from quoted context; media never silently disappears. */
export function incoming_text(message) {
  const items = message.item_list ?? [];
  if (!items.length || items.some(item => item.type !== 1 || typeof item.text_item?.text !== 'string')) {
    throw new Error('当前桥接只接收文字，请单独发送文字指令。');
  }
  const text = items.map(item => item.text_item.text).join('\n');
  const references = items.filter(item => item.ref_msg).map(item => item.ref_msg);
  const reference_ids = references.map(reference => (
    (reference.message_item?.text_item?.text ?? '').match(REPLY_PATTERN)?.[1]
      ?? (reference.title ?? '').match(REPLY_PATTERN)?.[1]
  ));
  return { text, references, reference_ids };
}

/** Ignore pasted zero-width spaces around command names, leaving arguments and ordinary text intact. */
function command_input(text) {
  return text.replace(/^[\s\u200B]+/u, '')
    .replace(/^(\/[a-z]+)\u200B+(?=\s|$)/iu, '$1');
}

/** Keep skill questions and their queue receipts separate from the legacy history bridge. */
function initialize_reply_tables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS weixin_questions (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,peer_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      raw_id TEXT NOT NULL, question_id TEXT, thread_id TEXT, text TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, queue_receipt TEXT, last_error TEXT,
      UNIQUE(account_id,peer_id,raw_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_listeners (
      account_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weixin_active_chats (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, thread_id TEXT,
      pending_request TEXT, PRIMARY KEY(account_id,peer_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_new_requests (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      source_thread_id TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      thread_id TEXT, title TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS weixin_chat_choices (
      id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
      thread_id TEXT NOT NULL, title TEXT NOT NULL, last_seen INTEGER NOT NULL,
      UNIQUE(account_id,peer_id,thread_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_chat_lists (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, choice_ids TEXT NOT NULL,
      PRIMARY KEY(account_id,peer_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_project_lists (
      account_id TEXT NOT NULL, peer_id TEXT NOT NULL, answer_id INTEGER NOT NULL, choices TEXT,
      PRIMARY KEY(account_id,peer_id)
    );
  `);
  add_column(db, 'weixin_questions', 'source_text', 'TEXT');
  add_column(db, 'weixin_questions', 'title', 'TEXT');
  add_column(db, 'weixin_questions', 'mode', "TEXT NOT NULL DEFAULT 'ask'");
  add_column(db, 'weixin_outbox', 'server_id', 'TEXT');
  add_column(db, 'weixin_outbox', 'sent_order', 'INTEGER');
  add_column(db, 'weixin_answers', 'kind', "TEXT NOT NULL DEFAULT 'reply'");
  add_column(db, 'weixin_answers', 'request_id', 'TEXT');
  add_column(db, 'weixin_new_requests', 'project_id', 'TEXT');
  add_column(db, 'weixin_chat_choices', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  add_column(db, 'weixin_chat_choices', 'source_key', "TEXT NOT NULL DEFAULT ''");
  add_column(db, 'weixin_chat_lists', 'awaiting_selection', 'INTEGER NOT NULL DEFAULT 0');
}

/** Add only this bridge's missing columns, preserving existing messages and receipts. */
function add_column(db, table, name, definition) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** Render common Markdown as Weixin text while preserving code contents and link destinations. */
export function weixin_text(text) {
  const code = [];
  const marker = `\uE000${randomUUID()}:`;
  let plain = text.replace(/```[^\n]*\n([\s\S]*?)```|`([^`\n]+)`/g, (_match, block, inline) => {
    code.push(block ?? inline); return `${marker}${code.length - 1}\uE001`;
  });
  plain = plain.replace(/!?(?:\[([^\]\n]*)\])\(([^)\n]+)\)/g,
    (_match, label, url) => label === url ? url : `${label || '链接'}（${url}）`)
    .replace(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/gm, '$1')
    .replace(/\*\*([^\n]+?)\*\*|__([^\n]+?)__|~~([^\n]+?)~~/g, (_match, bold, under, strike) => bold ?? under ?? strike)
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[，。！？,.!?]|$)/g, '$1$2')
    .replace(/(^|\s)_([^_\n]+)_(?=\s|[，。！？,.!?]|$)/g, '$1$2')
    .replace(/^[\t ]*[-*+][\t ]+/gm, '• ').replace(/^[\t ]*>[\t ]?/gm, '')
    .replace(/^[\t ]*(?:---+|\*\*\*+|___+)[\t ]*$/gm, '')
    .replace(/^[\t ]*\|?[\t ]*:?-{3,}:?[\t ]*(?:\|[\t ]*:?-{3,}:?[\t ]*)+\|?[\t ]*$/gm, '')
    .replace(/^[\t ]*\|(.+)\|[\t ]*$/gm, (_match, row) => row.split('|').map(cell => cell.trim()).join('；'));
  code.forEach((value, index) => { plain = plain.replaceAll(`${marker}${index}\uE001`, value); });
  return plain.trim();
}

/** Give every new Weixin message a human-readable source instead of an internal identifier. */
export function format_notice(title, text) {
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title) || title.length > 160) {
    throw new Error('需要有效的来源聊天名称（--title），不能使用内部编号代替');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('通知正文不能为空');
  return `💬 Codex（${title.trim()}）：\n\n${weixin_text(text)}`;
}

/** Pass only the new request and channel setup to a fresh desktop chat, never previous history. */
function new_chat_prompt(request) {
  return `[微信新聊天] 请用 $weixin-notify 接入并回复。\n接入编号：${request.id}\n\n`
    + (request.text || '暂无问题，请在微信告知已就绪。');
}

/** Convert an ordinary saved reply into a queue message. */
function answer_prompt(message) {
  return '[微信] 请用 $weixin-notify 回复。\n\n' + message.text;
}

/** Channel state shares the inbox transaction so advancing a cursor cannot lose a command. */
export class WeixinStore extends MessageStore {
  constructor(path) {
    super(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS weixin_accounts (
        account_id TEXT PRIMARY KEY, cursor TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS weixin_bindings (
        account_id TEXT NOT NULL, peer_id TEXT NOT NULL, alias TEXT NOT NULL, thread_id TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id,peer_id,alias)
      );
      CREATE TABLE IF NOT EXISTS weixin_peers (
        account_id TEXT NOT NULL, peer_id TEXT NOT NULL, context_token TEXT NOT NULL,
        PRIMARY KEY(account_id,peer_id)
      );
      CREATE TABLE IF NOT EXISTS weixin_inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, peer_id TEXT NOT NULL,
        raw_id TEXT NOT NULL, text TEXT NOT NULL, thread_id TEXT, alias TEXT,
        bridge_message_id TEXT, UNIQUE(account_id,peer_id,raw_id)
      );
      CREATE TABLE IF NOT EXISTS weixin_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE,
        group_key TEXT NOT NULL, part_index INTEGER NOT NULL,
        account_id TEXT NOT NULL, peer_id TEXT NOT NULL, text TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
    `);
    initialize_reply_tables(this.db);
  }

  /** Wrap related inbox, outbox and cursor changes in a single synchronous transaction. */
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  /** Bind an explicit local alias to an existing thread; no remote message can create bindings. */
  bind(account, alias, thread_id, is_default = false) {
    if (!ALIAS_PATTERN.test(alias ?? '') || !THREAD_PATTERN.test(thread_id ?? '')) {
      throw new Error('alias 需以字母或汉字开头，最长32字；thread 需为已有聊天 UUID');
    }
    this.transaction(() => {
      if (is_default) this.db.prepare('UPDATE weixin_bindings SET is_default=0 WHERE account_id=? AND peer_id=?')
        .run(account.account_id, account.owner_id);
      this.db.prepare(`INSERT INTO weixin_bindings VALUES (?,?,?,?,?)
        ON CONFLICT(account_id,peer_id,alias) DO UPDATE SET thread_id=excluded.thread_id,
        is_default=MAX(weixin_bindings.is_default,excluded.is_default)`)
        .run(account.account_id, account.owner_id, alias, thread_id.toLowerCase(), Number(is_default));
    });
  }

  /** Revoke future routing through an alias, including references to an unbound thread. */
  unbind(account, alias) {
    this.db.prepare('DELETE FROM weixin_bindings WHERE account_id=? AND peer_id=? AND alias=?')
      .run(account.account_id, account.owner_id, alias);
  }

  /** Return the currently authorized thread aliases. */
  bindings(account) {
    return this.db.prepare('SELECT alias,thread_id,is_default FROM weixin_bindings WHERE account_id=? AND peer_id=?')
      .all(account.account_id, account.owner_id);
  }

  /** Resolve an explicit alias/receipt or a verified quote, otherwise use the local default. */
  route(account, input) {
    const explicit = input.text.match(/^#([^\s]+)\s+([\s\S]+)$/u);
    let reference_id;
    let binding;
    const bindings = this.bindings(account);
    if (/^#[^\s]+\s*$/u.test(input.text)) throw new Error('请在 #别名 或 #回复编号 后加空格和正文。');
    if (explicit && /^\d+$/.test(explicit[1])) reference_id = explicit[1];
    else if (explicit) binding = bindings.find(value => value.alias === explicit[1]);
    else if (input.references.length) {
      if (input.reference_ids.some(value => !value) || new Set(input.reference_ids).size !== 1) {
        throw new Error('无法定位引用消息，请使用 #别名 正文 或 #回复编号 正文。');
      }
      [reference_id] = input.reference_ids;
    } else binding = bindings.find(value => value.is_default);
    if (reference_id) {
      const prior = this.db.prepare(`SELECT thread_id FROM weixin_inbox
        WHERE id=? AND account_id=? AND peer_id=?`).get(reference_id, account.account_id, account.owner_id);
      binding = bindings.find(value => value.thread_id === prior?.thread_id);
    }
    const text = explicit ? explicit[2] : input.text;
    if (!binding || !text.trim()) throw new Error('没有可用的目标聊天。请先在本机绑定，再发送 #别名 正文。');
    return { ...binding, text };
  }

  /** Read the last cursor only after all messages from that page were saved. */
  cursor(account_id) {
    return this.db.prepare('SELECT cursor FROM weixin_accounts WHERE account_id=?').get(account_id)?.cursor ?? '';
  }

  /** Read the QR owner's cached context without scanning messages or chat history. */
  notification_context(account) {
    return this.db.prepare('SELECT context_token FROM weixin_peers WHERE account_id=? AND peer_id=?')
      .get(account.account_id, account.owner_id)?.context_token;
  }

  /** Refresh only the owner's reply context and cursor; inbound text is never executed. */
  receive_context(account, response) {
    if (!Array.isArray(response.msgs ?? [])) throw new Error('微信收件格式无效，未推进游标');
    return this.transaction(() => {
      let refreshed = false;
      for (const message of response.msgs ?? []) {
        if (message.message_type !== 1 || message.message_state !== 2 || message.group_id
            || message.from_user_id !== account.owner_id
            || (message.to_user_id && message.to_user_id !== account.account_id)
            || typeof message.context_token !== 'string' || !message.context_token) continue;
        this.db.prepare(`INSERT INTO weixin_peers VALUES (?,?,?) ON CONFLICT(account_id,peer_id)
          DO UPDATE SET context_token=excluded.context_token`)
          .run(account.account_id, account.owner_id, message.context_token);
        refreshed = true;
      }
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
        this.db.prepare(`INSERT INTO weixin_accounts VALUES (?,?)
          ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor`)
          .run(account.account_id, response.get_updates_buf);
      }
      return refreshed;
    });
  }

  /** Look up one notification by its stable identifier, isolated from legacy replies. */
  notification(account, message_id) {
    if (!NOTICE_ID_PATTERN.test(message_id ?? '')) throw new Error('message-id 需为8–100位字母、数字、下划线或连字符');
    const group_key = JSON.stringify([account.account_id, account.owner_id, `notify:${message_id}`]);
    return this.db.prepare('SELECT * FROM weixin_outbox WHERE event_key=?').get(`${group_key}:0`);
  }

  /** Persist a short notification once, rejecting identifier reuse with different content. */
  prepare_notification(account, message_id, text) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > CHUNK_BYTES) {
      throw new Error('通知正文不能为空，且不能超过3500个UTF-8字节');
    }
    this.transaction(() => {
      const prior = this.notification(account, message_id);
      if (prior && prior.text !== text) throw new Error('同一 message-id 的正文不同，请核对原通知');
      if (!prior) this.add_outbox(account, `notify:${message_id}`, text);
    });
    return this.notification(account, message_id);
  }

  /** Report local readiness and one receipt without credentials or message bodies. */
  notification_status(account, message_id) {
    const result = { configured: true, context_available: Boolean(this.notification_context(account)) };
    if (message_id === undefined) return result;
    const notice = this.notification(account, message_id);
    return { ...result, message_id, status: notice?.status ?? 'not_found', last_error: notice?.last_error ?? '' };
  }

  /** Save original content and source; retries retain the original displayed title and body. */
  prepare_question(account, request) {
    const { message_id, thread_id, text } = request;
    if (!THREAD_PATTERN.test(thread_id ?? '')) throw new Error('ask 需要当前聊天 UUID：--thread 或 CODEX_THREAD_ID');
    if (typeof text !== 'string' || !text.trim()) throw new Error('问题正文不能为空');
    const title = request.title ?? '未命名聊天';
    const body = format_notice(title, text);
    this.transaction(() => {
      const prior = this.db.prepare(`SELECT * FROM weixin_questions
        WHERE account_id=? AND peer_id=? AND message_id=?`).get(account.account_id, account.owner_id, message_id);
      if (prior && prior.thread_id !== thread_id.toLowerCase()) throw new Error('同一问题编号不能改投其他聊天');
      const notice = this.notification(account, message_id);
      const previous_text = prior?.source_text ?? notice?.text.replace(/^\[Codex 提问 [^\]]+\]\n/, '');
      if (notice && (!prior || previous_text !== text)) throw new Error('问题编号已用于其他正文或通知');
      if (Buffer.byteLength(body) > CHUNK_BYTES) throw new Error('正文含来源标题不能超过3500个UTF-8字节');
      if (!notice) this.add_outbox(account, `notify:${message_id}`, body);
      this.db.prepare(`INSERT OR IGNORE INTO weixin_questions
        (account_id,peer_id,message_id,thread_id,created_at,source_text,title,mode) VALUES (?,?,?,?,?,?,?,?)`)
        .run(account.account_id, account.owner_id, message_id, thread_id.toLowerCase(), Date.now(),
          text, title, request.mode ?? 'ask');
    });
    return this.notification(account, message_id).text;
  }

  /** Look up a received Weixin quote by server ID or complete body, keeping old headers readable. */
  quoted_target(account, reference) {
    const body = reference.message_item?.text_item?.text ?? reference.title ?? '';
    const legacy_id = body.match(QUESTION_PATTERN)?.[1];
    const column = reference.svr_id ? 'o.server_id' : legacy_id ? 'q.message_id' : 'o.text';
    const value = reference.svr_id ? String(reference.svr_id) : legacy_id ?? body;
    if (!value) return undefined;
    const matches = this.db.prepare(`SELECT q.* FROM weixin_questions q
      JOIN weixin_outbox o ON o.event_key=json_array(q.account_id,q.peer_id,'notify:'||q.message_id)||':0'
      WHERE q.account_id=? AND q.peer_id=? AND o.status IN ('api_accepted','uncertain')
      AND ${column}=? ORDER BY o.id DESC`).all(account.account_id, account.owner_id, value);
    return new Set(matches.map(row => row.thread_id)).size === 1 ? matches[0] : undefined;
  }

  /** Resolve quotes first, then the target updated by a switch or a successfully sent notification. */
  answer_target(account, input) {
    if (input.references.length) {
      const targets = input.references.map(reference => this.quoted_target(account, reference));
      return targets.every(Boolean) && new Set(targets.map(target => target.thread_id)).size === 1
        ? targets[0] : undefined;
    }
    const active = this.active_chat(account);
    if (active) return { thread_id: active.thread_id, pending_request: active.pending_request };
    return this.db.prepare(`SELECT q.* FROM weixin_questions q JOIN weixin_outbox o
      ON o.event_key=json_array(q.account_id,q.peer_id,'notify:'||q.message_id)||':0'
      WHERE q.account_id=? AND q.peer_id=? AND o.status IN ('api_accepted','uncertain')
      ORDER BY COALESCE(o.sent_order,o.id) DESC LIMIT 1`).get(account.account_id, account.owner_id);
  }

  /** Read only the selected Weixin conversation, never the desktop's currently selected tab. */
  active_chat(account) {
    return this.db.prepare('SELECT * FROM weixin_active_chats WHERE account_id=? AND peer_id=?')
      .get(account.account_id, account.owner_id);
  }

  /** Track internal identities only for chats already connected to this owner's Weixin channel. */
  known_chats(account) {
    const sources = this.db.prepare(`SELECT q.thread_id,q.title,q.created_at,COALESCE(o.sent_order,o.id) AS source_id,
      'notify:'||q.message_id AS source_key,1 AS source_type FROM weixin_questions q
      JOIN weixin_outbox o ON o.event_key=json_array(q.account_id,q.peer_id,'notify:'||q.message_id)||':0'
      WHERE q.account_id=? AND q.peer_id=? AND o.status IN ('api_accepted','uncertain')
      UNION ALL SELECT thread_id,title,created_at,rowid,'new:'||id,0 FROM weixin_new_requests
      WHERE account_id=? AND peer_id=? AND status='completed' ORDER BY source_type,source_id,source_key`)
      .all(account.account_id, account.owner_id, account.account_id, account.owner_id);
    const upsert = this.db.prepare(`INSERT INTO weixin_chat_choices
      (account_id,peer_id,thread_id,title,last_seen,source_key) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id,peer_id,thread_id) DO UPDATE SET title=excluded.title,last_seen=excluded.last_seen,
      hidden=CASE WHEN excluded.source_key!=weixin_chat_choices.source_key THEN 0 ELSE weixin_chat_choices.hidden END,
      source_key=excluded.source_key`);
    const latest = new Map(sources.map(source => [source.thread_id, source]));
    for (const source of latest.values()) {
      const title = (source.title || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_TITLE_LIMIT) || '未命名聊天';
      upsert.run(account.account_id, account.owner_id, source.thread_id, title, source.created_at, source.source_key);
    }
    return this.db.prepare(`SELECT * FROM weixin_chat_choices WHERE account_id=? AND peer_id=? AND hidden=0
      ORDER BY last_seen DESC,id DESC`).all(account.account_id, account.owner_id);
  }

  /** Read the owner's last displayed order; new notifications do not change its selection numbers. */
  last_chat_list(account) {
    const saved = this.db.prepare('SELECT choice_ids FROM weixin_chat_lists WHERE account_id=? AND peer_id=?')
      .get(account.account_id, account.owner_id);
    return saved ? JSON.parse(saved.choice_ids) : [];
  }

  /** Treat a standalone number as a selection only while this owner's last list awaits a choice. */
  numeric_chat_command(account, input) {
    if (input.references.length || !/^\d+$/.test(input.text.trim())) return null;
    const saved = this.db.prepare('SELECT awaiting_selection FROM weixin_chat_lists WHERE account_id=? AND peer_id=?')
      .get(account.account_id, account.owner_id);
    return saved?.awaiting_selection ? [input.text, 'resume', input.text.trim()] : null;
  }

  /** End number selection after a successful choice or a new ordinary message. */
  finish_chat_selection(account) {
    this.db.prepare('UPDATE weixin_chat_lists SET awaiting_selection=0 WHERE account_id=? AND peer_id=?')
      .run(account.account_id, account.owner_id);
  }

  /** Number the bounded list from one and persist its order with the command response. */
  chat_list_text(account) {
    this.dismiss_project_list(account);
    const target = this.answer_target(account, { references: [] });
    const chats = this.known_chats(account);
    const current = chats.find(chat => chat.thread_id === target?.thread_id);
    const others = chats.filter(chat => chat !== current && chat.title !== '未命名聊天')
      .slice(0, CHAT_LIST_LIMIT - Number(Boolean(current)));
    const listed = current ? [current, ...others] : others;
    this.db.prepare(`INSERT INTO weixin_chat_lists (account_id,peer_id,choice_ids,awaiting_selection) VALUES (?,?,?,1)
      ON CONFLICT(account_id,peer_id) DO UPDATE SET choice_ids=excluded.choice_ids,awaiting_selection=1`)
      .run(account.account_id, account.owner_id, JSON.stringify(listed.map(chat => chat.id)));
    if (!current && !others.length) return '暂无可用对话。先从 Codex 向微信发送一条消息。';
    const title = current?.title === '未命名聊天' ? '' : ` · ${current?.title}`;
    const heading = current ? `当前：\n\n1${title}（当前绑定）` : '请选择对话：';
    if (!others.length) return heading;
    const lines = others.map((chat, index) => `${index + 1 + Number(Boolean(current))} · ${chat.title}`);
    return `${heading}\n\n${lines.join('\n\n')}\n\n切换：直接回复序号，或 /resume 序号`;
  }

  /** Clear the recent catalog and selection snapshot, retaining routing and delivery receipts. */
  clear_chats(account) {
    const target = this.answer_target(account, { references: [] });
    this.known_chats(account);
    this.db.prepare(`UPDATE weixin_chat_choices SET hidden=1
      WHERE account_id=? AND peer_id=? AND thread_id!=COALESCE(?, '')`)
      .run(account.account_id, account.owner_id, target?.thread_id ?? null);
    this.db.prepare('DELETE FROM weixin_chat_lists WHERE account_id=? AND peer_id=?')
      .run(account.account_id, account.owner_id);
    return target?.thread_id ? '已清理旧对话列表，当前对话保留。' : '已清理对话列表。';
  }

  /** Report delivery facts without treating queue acceptance as live model execution. */
  chat_status_text(account) {
    const target = this.answer_target(account, { references: [] });
    const chat = this.known_chats(account).find(value => value.thread_id === target?.thread_id);
    const counts = this.db.prepare(`SELECT status,COUNT(*) AS count FROM weixin_answers
      WHERE account_id=? AND peer_id=? AND kind!='command'
      AND status IN ('received','waiting_new','uncertain') GROUP BY status`).all(account.account_id, account.owner_id);
    const count = status => counts.find(row => row.status === status)?.count ?? 0;
    return `当前聊天：${chat?.title ?? '尚未选择'}\n`
      + `收件器：${this.reply_status(account).running ? '运行中' : '未运行'}\n`
      + `待投递：${count('received')}；等待新聊天：${count('waiting_new')}；投递待核查：${count('uncertain')}\n`
      + (target?.pending_request ? '新聊天尚未登记，后续普通消息暂存。\n' : '')
      + '这里只显示桥接状态；消息入队不代表 Codex 已开始或完成任务。';
  }

  /** Switch future routing and optionally queue the command's text; older messages keep their destination. */
  resume_chat(account, argument, reply) {
    if (!/^[1-9]\d*$/.test(argument)) return '用法：/resume 序号 [消息]。单独发送 /resume 查看列表。';
    const choice_id = this.last_chat_list(account)[Number(argument) - 1];
    const chat = this.known_chats(account).find(value => value.id === choice_id);
    if (!chat) return '未找到该序号。单独发送 /resume 查看列表。';
    this.dismiss_project_list(account);
    const pending = this.active_chat(account)?.pending_request;
    this.db.prepare(`INSERT INTO weixin_active_chats VALUES (?,?,?,NULL) ON CONFLICT(account_id,peer_id)
      DO UPDATE SET thread_id=excluded.thread_id,pending_request=NULL`)
      .run(account.account_id, account.owner_id, chat.thread_id);
    this.finish_chat_selection(account);
    if (reply?.text.trim()) {
      this.db.prepare("UPDATE weixin_answers SET thread_id=?,text=?,status='received',kind='reply' WHERE id=?")
        .run(chat.thread_id, reply.text, reply.answer_id);
    }
    return `已切换：${argument} · ${chat.title}`
      + (pending ? '\n先前的新建请求仍保留；此前暂存的消息仍交给那个新聊天。' : '');
  }

  /** Execute the small fixed command set locally, without model calls or desktop history scans. */
  chat_command_text(account, command, answer_id) {
    const name = command[1].toLowerCase();
    if (name === 'resume') {
      if (!(command[2] ?? '').trim()) return this.chat_list_text(account);
      const selection = (command[2] ?? '').match(/^([1-9]\d*)(?:\s+([\s\S]*))?$/);
      return this.resume_chat(account, selection?.[1] ?? '', { answer_id, text: selection?.[2] ?? '' });
    }
    const argument = (command[2] ?? '').trim();
    if (name === 'new') return '尚未选择聊天。先用 /resume 查看列表，再用 /resume 序号 选择来源聊天。';
    if (!['help', 'status', 'sessions', 'rusume', 'clear'].includes(name)) return '未支持此命令。发送 /help 查看可用命令。';
    if (argument) return `/${name} 不需要参数，请单独发送。`;
    if (name === 'clear') return this.clear_chats(account);
    if (name === 'help') return CHAT_HELP;
    return name === 'status' ? this.chat_status_text(account) : this.chat_list_text(account);
  }

  /** Save the command, routing change and reply in the caller's inbox/cursor transaction. */
  receive_chat_command(account, message, command) {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO weixin_answers
      (account_id,peer_id,raw_id,text,status,created_at,kind) VALUES (?,?,?,?,'handled',?,'command')`)
      .run(account.account_id, account.owner_id, String(message.message_id), command[0], Date.now());
    if (!inserted.changes) return 0;
    const text = this.chat_command_text(account, command, Number(inserted.lastInsertRowid));
    this.add_outbox(account, `command:${inserted.lastInsertRowid}`, text, '🔔 系统通知：\n\n');
    return 1;
  }

  /** Read the current project picker and its original first question, isolated by owner. */
  project_list(account) {
    return this.db.prepare(`SELECT a.*,p.choices FROM weixin_project_lists p
      JOIN weixin_answers a ON a.id=p.answer_id WHERE p.account_id=? AND p.peer_id=?`)
      .get(account.account_id, account.owner_id);
  }

  /** Discard only an unconfirmed picker; existing creation requests keep their messages. */
  dismiss_project_list(account, status = 'cancelled') {
    this.db.prepare(`UPDATE weixin_outbox SET status='cancelled' WHERE status='pending' AND group_key IN
      (SELECT json_array(account_id,peer_id,'command:'||answer_id) FROM weixin_project_lists
        WHERE account_id=? AND peer_id=?)`).run(account.account_id, account.owner_id);
    this.db.prepare(`UPDATE weixin_answers SET status=? WHERE id IN
      (SELECT answer_id FROM weixin_project_lists WHERE account_id=? AND peer_id=?)`)
      .run(status, account.account_id, account.owner_id);
    this.db.prepare('DELETE FROM weixin_project_lists WHERE account_id=? AND peer_id=?')
      .run(account.account_id, account.owner_id);
  }

  /** Save /new before reading desktop projects; no chat is created until a valid choice. */
  begin_project_list(account, message, target, text) {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO weixin_answers
      (account_id,peer_id,raw_id,thread_id,text,status,created_at,kind)
      VALUES (?,?,?,?,?,'received',?,'project_list')`).run(account.account_id, account.owner_id,
      String(message.message_id), target.thread_id, text, Date.now());
    if (!inserted.changes) return 0;
    this.dismiss_project_list(account);
    this.finish_chat_selection(account);
    this.db.prepare('INSERT INTO weixin_project_lists VALUES (?,?,?,NULL)')
      .run(account.account_id, account.owner_id, inserted.lastInsertRowid);
    return 1;
  }

  /** Persist exactly the displayed project order and its system reply in one transaction. */
  save_project_list(account, answer_id, projects) {
    return this.transaction(() => {
      const current = this.project_list(account);
      if (current?.id !== answer_id || current.status !== 'received') return;
      const choices = projects.filter(project => project.projectKind === 'local' && project.hostId === 'local')
        .map(project => ({ project_id: project.projectId,
          title: project.label.replace(/\s+/g, ' ').trim().slice(0, CHAT_TITLE_LIMIT) }));
      const lines = choices.map((project, index) => `${index + 1} · ${project.title}`);
      const text = ['请选择新聊天所在的项目：', '0 · 无项目', ...lines, '回复序号创建聊天。'].join('\n\n');
      this.db.prepare('UPDATE weixin_project_lists SET choices=? WHERE account_id=? AND peer_id=?')
        .run(JSON.stringify(choices), account.account_id, account.owner_id);
      this.db.prepare("UPDATE weixin_answers SET status='choosing',last_error=NULL WHERE id=?").run(answer_id);
      this.add_outbox(account, `command:${answer_id}`, text, '🔔 系统通知：\n\n');
    });
  }

  /** Consume a picker number as a creation choice; other unquoted text never reaches an old AI. */
  receive_project_choice(account, message, input) {
    if (input.references.length) return null;
    const picker = this.project_list(account);
    if (!picker) return null;
    const number = /^\d+$/.test(input.text.trim()) ? Number(input.text.trim()) : -1;
    const choices = picker.choices ? JSON.parse(picker.choices) : null;
    if (!choices || !Number.isSafeInteger(number) || number < 0 || number > choices.length) {
      const reply = choices ? '请回复项目列表中的序号；0 表示无项目。'
        : '正在读取项目列表，请稍后按序号选择。';
      return this.receive_project_hint(account, message, input.text, reply);
    }
    const target = { thread_id: picker.thread_id, project_id: choices[number - 1]?.project_id ?? null };
    const received = this.receive_new_request(account, message, target, picker.text);
    if (received) this.dismiss_project_list(account, 'handled');
    return received;
  }

  /** Persist one invalid selection and its reply without changing the pending picker. */
  receive_project_hint(account, message, text, reply) {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO weixin_answers
      (account_id,peer_id,raw_id,text,status,created_at,kind) VALUES (?,?,?,?,'handled',?,'command')`)
      .run(account.account_id, account.owner_id, String(message.message_id), text, Date.now());
    if (!inserted.changes) return 0;
    this.add_outbox(account, `command:${inserted.lastInsertRowid}`, reply, '🔔 系统通知：\n\n');
    return 1;
  }

  /** Persist replies together with the cursor so restarts neither lose nor replay submissions. */
  receive_answers(account, response) {
    if (!Array.isArray(response.msgs ?? [])) throw new Error('微信收件格式无效，未推进游标');
    return this.transaction(() => {
      let received = 0;
      for (const message of response.msgs ?? []) received += this.receive_answer(account, message);
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
        this.db.prepare(`INSERT INTO weixin_accounts VALUES (?,?)
          ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor`)
          .run(account.account_id, response.get_updates_buf);
      }
      return received;
    });
  }

  /** Admit only complete owner text; quoted content determines routing but is never an instruction. */
  receive_answer(account, message) {
    if (message.message_type !== 1 || message.message_state !== 2 || message.group_id
        || message.from_user_id !== account.owner_id || message.message_id == null
        || !String(message.message_id).trim()
        || (message.to_user_id && message.to_user_id !== account.account_id)) return 0;
    if (typeof message.context_token === 'string' && message.context_token) {
      this.db.prepare(`INSERT INTO weixin_peers VALUES (?,?,?) ON CONFLICT(account_id,peer_id)
        DO UPDATE SET context_token=excluded.context_token`)
        .run(account.account_id, account.owner_id, message.context_token);
    }
    let input;
    let target;
    let chat_command;
    let command_text;
    try {
      input = incoming_text(message);
      command_text = command_input(input.text);
      chat_command = command_text.match(CHAT_COMMAND_PATTERN);
      target = this.answer_target(account, chat_command ? { ...input, references: [] } : input);
    }
    catch { /* Unsupported media is recorded as ignored, never partially executed. */ }
    if (input && !chat_command) {
      const selection = this.receive_project_choice(account, message, input);
      if (selection !== null) return selection;
      chat_command = this.numeric_chat_command(account, input);
    }
    const command = command_text?.match(NEW_COMMAND_PATTERN);
    if (command && target?.thread_id) return this.begin_project_list(account, message, target, command[1] ?? '');
    if (chat_command) return this.receive_chat_command(account, message, chat_command);
    const accepted = Boolean(target && input?.text.trim());
    const insertion = this.db.prepare(`INSERT OR IGNORE INTO weixin_answers
      (account_id,peer_id,raw_id,question_id,thread_id,text,status,created_at,request_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(account.account_id, account.owner_id, String(message.message_id),
      target?.message_id ?? null, target?.thread_id ?? null, input?.text ?? '',
      accepted ? target.pending_request ? 'waiting_new' : 'received' : 'ignored', Date.now(),
      target?.pending_request ?? null);
    if (insertion.changes) this.finish_chat_selection(account);
    return Number(insertion.changes);
  }

  /** Persist an explicit /new command once and hold following plain replies until registration. */
  receive_new_request(account, message, target, text) {
    const raw_id = String(message.message_id);
    const request_id = createHash('sha256').update(JSON.stringify([account.account_id, account.owner_id, raw_id])).digest('hex');
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO weixin_answers
      (account_id,peer_id,raw_id,thread_id,text,status,created_at,kind,request_id)
      VALUES (?,?,?,?,?,'received',?,'new',?)`).run(account.account_id, account.owner_id, raw_id,
      target.thread_id, text, Date.now(), request_id);
    if (!inserted.changes) return 0;
    this.finish_chat_selection(account);
    this.db.prepare(`INSERT INTO weixin_new_requests
      (id,account_id,peer_id,source_thread_id,text,created_at,project_id) VALUES (?,?,?,?,?,?,?)`)
      .run(request_id, account.account_id, account.owner_id, target.thread_id, text.trim(), Date.now(), target.project_id ?? null);
    this.db.prepare(`INSERT INTO weixin_active_chats VALUES (?,?,?,?) ON CONFLICT(account_id,peer_id)
      DO UPDATE SET pending_request=excluded.pending_request`)
      .run(account.account_id, account.owner_id, target.thread_id, request_id);
    return 1;
  }

  /** Claim creation before invoking the desktop tool; unknown outcomes never create another chat. */
  claim_new_request(account, request_id, source_thread_id) {
    const request = this.db.prepare(`SELECT * FROM weixin_new_requests
      WHERE id=? AND account_id=? AND peer_id=?`).get(request_id, account.account_id, account.owner_id);
    if (!request || request.source_thread_id !== source_thread_id) throw new Error('新聊天请求不存在或来源聊天不匹配');
    const changed = this.db.prepare("UPDATE weixin_new_requests SET status='creating' WHERE id=? AND status='pending'")
      .run(request_id).changes;
    return { request_id, claimed: Boolean(changed), status: changed ? 'creating' : request.status,
      thread_id: request.thread_id, prompt: new_chat_prompt(request), target: request.project_id
        ? { type: 'project', projectId: request.project_id, environment: { type: 'local' } } : { type: 'projectless' } };
  }

  /** Reject a deleted project before creation and keep its unsent messages recorded. */
  reject_new_project(account, message) {
    this.transaction(() => {
      const changed = this.db.prepare("UPDATE weixin_new_requests SET status='failed' WHERE id=? AND status='pending'")
        .run(message.request_id).changes;
      if (!changed) return;
      this.db.prepare("UPDATE weixin_answers SET status='failed',last_error='所选项目已不可用' WHERE id=?")
        .run(message.id);
      this.db.prepare("UPDATE weixin_answers SET status='cancelled',last_error='目标项目已不可用，未投递' WHERE request_id=? AND status='waiting_new'")
        .run(message.request_id);
      this.db.prepare('UPDATE weixin_active_chats SET pending_request=NULL WHERE account_id=? AND peer_id=? AND pending_request=?')
        .run(account.account_id, account.owner_id, message.request_id);
      this.add_outbox(account, `command:${message.id}`, '所选项目已不可用，未创建聊天。请重新发送 /new 选择项目。', '🔔 系统通知：\n\n');
    });
  }

  /** Register the desktop-created chat and release only replies waiting for this exact request. */
  complete_new_request(account, request_id, target) {
    if (!THREAD_PATTERN.test(target.thread_id ?? '')) throw new Error('新聊天 UUID 无效');
    format_notice(target.title, '验证名称');
    return this.transaction(() => {
      const request = this.db.prepare(`SELECT * FROM weixin_new_requests
        WHERE id=? AND account_id=? AND peer_id=?`).get(request_id, account.account_id, account.owner_id);
      if (!request || !['creating', 'completed'].includes(request.status)) throw new Error('新聊天请求尚未领取');
      if (request.source_thread_id === target.thread_id) throw new Error('必须使用新建的独立聊天');
      if (request.thread_id && request.thread_id !== target.thread_id) throw new Error('该请求已经关联另一个聊天');
      this.db.prepare("UPDATE weixin_new_requests SET status='completed',thread_id=?,title=? WHERE id=?")
        .run(target.thread_id, target.title, request_id);
      this.db.prepare("UPDATE weixin_answers SET status='created',last_error=NULL WHERE request_id=? AND kind='new'")
        .run(request_id);
      this.db.prepare(`UPDATE weixin_active_chats SET thread_id=?,pending_request=NULL
        WHERE account_id=? AND peer_id=? AND pending_request=?`)
        .run(target.thread_id, account.account_id, account.owner_id, request_id);
      this.db.prepare("UPDATE weixin_answers SET thread_id=?,status='received' WHERE request_id=? AND status='waiting_new'")
        .run(target.thread_id, request_id);
      return { status: 'completed', thread_id: target.thread_id, title: target.title };
    });
  }

  /** Return only reply IDs and delivery status, without exposing text or credentials. */
  reply_status(account) {
    const runtime = this.db.prepare('SELECT pid,status FROM weixin_listeners WHERE account_id=?')
      .get(account.account_id);
    let running = runtime?.status === 'running';
    try { if (running) process.kill(runtime.pid, 0); } catch { running = false; }
    return { running: Boolean(running), pid: running ? runtime.pid : null, active_chat: this.active_chat(account),
      replies: this.db.prepare(`SELECT id,question_id,thread_id,status FROM weixin_answers
        WHERE account_id=? AND peer_id=? ORDER BY id DESC LIMIT 20`).all(account.account_id, account.owner_id) };
  }

  /** Persist one response page atomically; unknown senders and bot/group messages are ignored. */
  receive(account, response) {
    if (!Array.isArray(response.msgs ?? [])) throw new Error('微信收件格式无效，未推进游标');
    return this.transaction(() => {
      let received = 0;
      for (const message of response.msgs ?? []) received += this.receive_one(account, message);
      if (typeof response.get_updates_buf === 'string' && response.get_updates_buf) {
        this.db.prepare(`INSERT INTO weixin_accounts VALUES (?,?)
          ON CONFLICT(account_id) DO UPDATE SET cursor=excluded.cursor`)
          .run(account.account_id, response.get_updates_buf);
      }
      return received;
    });
  }

  /** Admit only the QR-confirmed owner, deduplicate before routing and retain its latest reply token. */
  receive_one(account, message) {
    if (message.message_type !== 1 || message.message_state !== 2 || message.group_id
        || message.from_user_id !== account.owner_id
        || (message.to_user_id && message.to_user_id !== account.account_id)) return 0;
    if (message.message_id == null || String(message.message_id).trim() === '') return 0;
    if (typeof message.context_token === 'string' && message.context_token) {
      this.db.prepare(`INSERT INTO weixin_peers VALUES (?,?,?) ON CONFLICT(account_id,peer_id)
        DO UPDATE SET context_token=excluded.context_token`)
        .run(account.account_id, account.owner_id, message.context_token);
    }
    const raw_id = String(message.message_id);
    const insertion = this.db.prepare(`INSERT OR IGNORE INTO weixin_inbox
      (account_id,peer_id,raw_id,text) VALUES (?,?,?,?)`)
      .run(account.account_id, account.owner_id, raw_id, '');
    if (!insertion.changes) return 0;
    const id = Number(insertion.lastInsertRowid);
    let target;
    try { target = this.route(account, incoming_text(message)); }
    catch (error) { this.add_outbox(account, `reject:${id}`, error.message); return 1; }
    const bridge_id = `wx.${createHash('sha256').update(JSON.stringify([
      account.account_id, account.owner_id, raw_id,
    ])).digest('hex')}`;
    this.enqueue({ message_id: bridge_id, thread_id: target.thread_id, text: target.text, source: 'weixin' });
    this.db.prepare(`UPDATE weixin_inbox SET text=?,thread_id=?,alias=?,bridge_message_id=? WHERE id=?`)
      .run(target.text, target.thread_id, target.alias, bridge_id, id);
    this.add_outbox(account, `receipt:${id}`, `[Codex #${id} ${target.alias}]\n已收件，等待 Codex 处理。`);
    return 1;
  }

  /** Add durable chunks with stable IDs; preparing the same response again is harmless. */
  add_outbox(account, event_key, text, header = '') {
    const group_key = JSON.stringify([account.account_id, account.owner_id, event_key]);
    split_text(text, CHUNK_BYTES - Buffer.byteLength(header)).forEach((chunk, index) => {
      this.db.prepare(`INSERT OR IGNORE INTO weixin_outbox
        (event_key,group_key,part_index,account_id,peer_id,text,client_id,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(`${group_key}:${index}`, group_key, index, account.account_id, account.owner_id,
          header + chunk, `codex-${randomUUID()}`, Date.now());
    });
  }

  /** Find only this account's channel messages, leaving simulated inputs to their own runner. */
  channel_messages(account) {
    return this.db.prepare(`SELECT m.*,i.id AS inbox_id,i.alias FROM weixin_inbox i
      JOIN bridge_messages m ON m.message_id=i.bridge_message_id
      WHERE i.account_id=? AND i.peer_id=? ORDER BY i.id`).all(account.account_id, account.owner_id);
  }

  /** Prepare final or uncertain notifications once; commentary never becomes a final reply. */
  prepare_replies(account) {
    this.transaction(() => {
      for (const message of this.channel_messages(account)) {
        let text;
        let event = message.status;
        if (message.status === 'completed') text = message.reply || 'Codex 已完成，本轮没有文字回复。';
        else if (message.status === 'failed') text = 'Codex 本轮失败或中断，请在桌面查看详情。';
        else if (message.status === 'uncertain') text = '投递结果待核查，程序不会自动重复发送。请在桌面查看。';
        else if (message.status === 'queued' && Date.now() - message.updated_at >= QUEUED_NOTICE_MS) {
          event = 'queued_notice';
          text = '消息已进入 Codex 队列，但尚未观察到开始。请在桌面打开对应聊天检查；不要重复发送同一指令。';
        }
        if (text) {
          const header = `[Codex #${message.inbox_id} ${message.alias}]\n`;
          this.add_outbox(account, `${event}:${message.inbox_id}`, text, header);
        }
      }
    });
  }

  /** List pending chunks with the latest token; no token means wait for a fresh inbound message. */
  pending_outbox(account) {
    return this.db.prepare(`SELECT o.*,p.context_token FROM weixin_outbox o
      JOIN weixin_peers p ON p.account_id=o.account_id AND p.peer_id=o.peer_id
      WHERE o.account_id=? AND o.peer_id=? AND o.status='pending'
      AND NOT EXISTS (SELECT 1 FROM weixin_outbox earlier WHERE earlier.group_key=o.group_key
        AND earlier.part_index<o.part_index AND earlier.status!='api_accepted') ORDER BY o.id`)
      .all(account.account_id, account.owner_id);
  }

  /** Persist uncertainty before the external send; only one sender may claim a chunk. */
  claim_outbox(id) {
    return this.db.prepare("UPDATE weixin_outbox SET status='uncertain' WHERE id=? AND status='pending'")
      .run(id).changes === 1;
  }

  /** Bind to every successfully sent Codex source; already saved replies keep their own destinations. */
  finish_outbox(id, status, error = '', server_id = null) {
    this.transaction(() => {
      const settled = this.db.prepare(`UPDATE weixin_outbox SET status=?,last_error=?,server_id=COALESCE(?,server_id),
        sent_order=CASE WHEN ?='api_accepted' THEN (SELECT COALESCE(MAX(COALESCE(sent_order,id)),0)+1 FROM weixin_outbox)
        ELSE sent_order END WHERE id=? AND status='uncertain'`).run(status, error, server_id, status, id);
      if (!settled.changes || status !== 'api_accepted') return;
      const source = this.db.prepare(`SELECT q.* FROM weixin_questions q JOIN weixin_outbox o
        ON o.event_key=json_array(q.account_id,q.peer_id,'notify:'||q.message_id)||':0' WHERE o.id=?`).get(id);
      if (source) this.db.prepare(`UPDATE weixin_active_chats SET thread_id=?,pending_request=NULL
        WHERE account_id=? AND peer_id=?`)
        .run(source.thread_id, source.account_id, source.peer_id);
    });
  }

  /** Return channel diagnostics without account tokens, context tokens or message bodies. */
  status(account) {
    return {
      account_id: account.account_id, owner_id: account.owner_id, bindings: this.bindings(account),
      inbox: this.channel_messages(account).map(message => ({
        id: message.inbox_id, alias: message.alias, thread_id: message.thread_id,
        status: message.status, turn_id: message.turn_id,
      })),
      outbox: this.db.prepare(`SELECT id,status,last_error FROM weixin_outbox
        WHERE account_id=? AND peer_id=? ORDER BY id`).all(account.account_id, account.owner_id),
    };
  }
}

/** Attempt each claimed chunk once; only an explicit expired-session rejection is resumable. */
export async function flush_outbox(store, client, account, signal) {
  for (const message of store.pending_outbox(account)) {
    if (signal?.aborted) break;
    await send_outbox_message(store, client, message);
  }
}

/** Deliver only local command replies; do not resend unrelated notification or legacy backlogs. */
export async function flush_command_replies(store, client, account, signal) {
  for (const message of store.pending_outbox(account)) {
    if (signal?.aborted) break;
    const event = JSON.parse(message.group_key)[2];
    if (!event.startsWith('command:')) continue;
    const started_at = Date.now();
    try { await send_outbox_message(store, client, message); }
    finally {
      const result = store.db.prepare('SELECT status FROM weixin_outbox WHERE id=?').get(message.id);
      log_event('command_reply', { answer_id: Number(event.slice('command:'.length)), outbox_id: message.id,
        local_wait_ms: started_at - message.created_at, send_ms: Date.now() - started_at, status: result.status });
    }
  }
}

/** Claim and send one durable message, retaining ambiguity across process restarts. */
async function send_outbox_message(store, client, message) {
  if (!store.claim_outbox(message.id)) return;
  try {
    const response = await client.send(message);
    store.finish_outbox(message.id, 'api_accepted', '', response?.message_id == null ? null : String(response.message_id));
  } catch (error) {
    const expired = error instanceof IlinkError && error.session_expired;
    const rejected = error instanceof IlinkError && error.code !== null;
    const status = expired ? 'pending' : rejected ? 'failed' : 'uncertain';
    const detail = rejected ? `iLink 拒绝（${error.code}）` : '发送回执不确定，未自动重发';
    store.finish_outbox(message.id, status, detail);
    if (expired) throw error;
  }
}

/** Send only the requested notification to the scanner; no Codex client or backlog processing. */
export async function send_notification(store, client, account, request) {
  const notice = store.prepare_notification(account, request.message_id, request.text);
  const context_token = store.notification_context(account);
  if (notice.status === 'pending' && context_token) {
    try { await send_outbox_message(store, client, { ...notice, context_token }); }
    catch (error) { if (!(error instanceof IlinkError && error.session_expired)) throw error; }
  }
  const result = store.notification_status(account, request.message_id);
  if (result.status === 'pending' && !context_token) result.status = 'waiting_context';
  return result;
}

/** Read project names for a saved /new and persist its picker without starting a chat. */
async function dispatch_project_list(store, desktop, account) {
  const picker = store.project_list(account);
  if (!picker || picker.status !== 'received') return;
  try {
    await desktop.open();
    const projects = await desktop.list_projects(picker.thread_id);
    store.save_project_list(account, picker.id, projects);
  } catch {
    store.db.prepare("UPDATE weixin_answers SET last_error=? WHERE id=? AND status='received'")
      .run('桌面项目列表暂不可用，恢复后重试', picker.id);
  } finally { desktop.close(); }
}

/** Create each explicitly selected /new through the desktop, without source-AI forwarding. */
async function dispatch_new_requests(store, desktop, account) {
  const messages = store.db.prepare(`SELECT a.*,r.project_id FROM weixin_answers a
    JOIN weixin_new_requests r ON r.id=a.request_id
    WHERE a.account_id=? AND a.peer_id=? AND a.kind='new' AND a.status='received'
      AND r.status='pending' ORDER BY a.id`)
    .all(account.account_id, account.owner_id);
  for (const message of messages) {
    let claimed = false;
    try {
      await desktop.open();
      if (message.project_id) {
        const projects = await desktop.list_projects(message.thread_id);
        if (!projects.some(project => project.projectId === message.project_id
            && project.projectKind === 'local' && project.hostId === 'local')) {
          store.reject_new_project(account, message);
          continue;
        }
      }
      const request = store.transaction(() => {
        const result = store.claim_new_request(account, message.request_id, message.thread_id);
        if (result.claimed) store.db.prepare("UPDATE weixin_answers SET status='uncertain',last_error=NULL WHERE id=?")
          .run(message.id);
        return result;
      });
      if (!request.claimed) continue;
      claimed = true;
      const subject = [...message.text.replace(/\s+/g, ' ').trim()].slice(0, NEW_CHAT_TITLE_LIMIT).join('');
      const title = subject ? `微信新聊：${subject}` : `微信新聊 ${new Date(message.created_at).toLocaleTimeString('zh-CN', { hour12: false })}`;
      const target = await desktop.create_thread(message.thread_id, request.prompt, title, request.target);
      store.complete_new_request(account, message.request_id, target);
    } catch {
      store.db.prepare("UPDATE weixin_answers SET last_error=? WHERE id=? AND status!='created'")
        .run(claimed ? '桌面创建结果待核查，未自动重建' : '桌面连接不可用，尚未创建；恢复后重试', message.id);
    } finally { desktop.close(); }
  }
}

/** Create requested chats, then queue each ordinary reply once to its recorded destination. */
export async function dispatch_answers(store, codex, account, desktop = new CodexAppClient()) {
  await dispatch_project_list(store, desktop, account);
  await dispatch_new_requests(store, desktop, account);
  const messages = store.db.prepare(`SELECT * FROM weixin_answers
    WHERE account_id=? AND peer_id=? AND status='received' AND kind='reply' ORDER BY id`)
    .all(account.account_id, account.owner_id);
  for (const message of messages) {
    const claimed = store.db.prepare("UPDATE weixin_answers SET status='uncertain' WHERE id=? AND status='received'")
      .run(message.id).changes;
    if (!claimed) continue;
    try {
      const receipt = await codex.queue({ thread_id: message.thread_id, prompt: answer_prompt(message) });
      store.db.prepare("UPDATE weixin_answers SET status='queued',queue_receipt=? WHERE id=? AND status='uncertain'")
        .run(receipt, message.id);
    } catch {
      store.db.prepare('UPDATE weixin_answers SET last_error=? WHERE id=?')
        .run('queue 结果待核查，未自动重投', message.id);
    }
  }
}

/** Record command timing after commit, without logging message bodies or credentials. */
function log_command_receipts(store, account, response, received_at) {
  const processing_ms = Date.now() - received_at;
  const find = store.db.prepare(`SELECT id,created_at FROM weixin_answers
    WHERE account_id=? AND peer_id=? AND raw_id=? AND kind='command'`);
  for (const message of response.msgs ?? []) {
    const answer = find.get(account.account_id, account.owner_id, String(message.message_id));
    if (!answer || answer.created_at < received_at) continue;
    log_event('command_received', { answer_id: answer.id, received_at, processing_ms,
      source_created_at: Number.isFinite(message.create_time_ms) && message.create_time_ms > 0
        ? message.create_time_ms : null });
  }
}

/** Receive replies; /new calls desktop app tools and ordinary text uses queue, without history reads. */
async function listen_answers(store, account, options) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  const { signal } = controller;
  const client = new IlinkClient(account, { signal });
  const codex = new CodexClient(options.codex);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  store.db.prepare(`INSERT INTO weixin_listeners VALUES (?,?,'running')
    ON CONFLICT(account_id) DO UPDATE SET pid=excluded.pid,status='running'`).run(account.account_id, process.pid);
  log_event('reply_listener_running', { pid: process.pid });
  try {
    do {
      await flush_command_replies(store, client, account, signal);
      await dispatch_answers(store, codex, account);
      await flush_command_replies(store, client, account, signal);
      try {
        const response = await client.updates(store.cursor(account.account_id));
        if (signal.aborted) break;
        const received_at = Date.now();
        const count = store.receive_answers(account, response);
        if (count) {
          log_command_receipts(store, account, response, received_at);
          log_event('replies_saved', { count });
        }
        await flush_command_replies(store, client, account, signal);
        await dispatch_answers(store, codex, account);
        await flush_command_replies(store, client, account, signal);
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof IlinkError && error.session_expired) throw error;
        log_event('reply_receive_retry', { message: '微信读取暂时失败，保留游标' });
        if (!options.once) await pause(signal);
      }
      if (options.once) break;
    } while (!signal.aborted);
  } finally {
    controller.abort();
    store.db.prepare("UPDATE weixin_listeners SET status='stopped' WHERE account_id=? AND pid=?")
      .run(account.account_id, process.pid);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Start a hidden receiver and verify its own readiness; duplicate starts cannot share the receive lock. */
async function start_listener(store, account, options) {
  const current = store.reply_status(account);
  if (current.running) return { running: true, pid: current.pid, status: 'already_running' };
  const log_path = `${resolve(options.state)}.replies.log`;
  const log = openSync(log_path, 'a', 0o600);
  let child;
  let failed = false;
  try {
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'listen',
      '--account', resolve(options.account), '--state', resolve(options.state), '--codex', options.codex],
    { cwd: ROOT, windowsHide: true, detached: true, stdio: ['ignore', log, log] });
    child.on('error', () => { failed = true; });
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + LISTENER_START_MS;
  do {
    const state = store.reply_status(account);
    if (state.running) return { running: true, pid: state.pid, status: 'running' };
    if (failed || child.exitCode != null) break;
    await sleep(LISTENER_CHECK_MS);
  } while (Date.now() < deadline);
  throw new Error(`微信收件器未就绪；请查看 ${log_path}，并核对是否有旧收件器占用`);
}

/** Process only authorized channel messages, then durably prepare their replies. */
export async function process_weixin(store, codex, account, signal) {
  for (const message of store.channel_messages(account)) {
    if (signal?.aborted) break;
    if (!['completed', 'failed'].includes(message.status)) {
      await process_message(store, codex, message.message_id);
    }
  }
  store.prepare_replies(account);
}

/** Emit small operational events; never echo remote bodies or secret-bearing errors. */
function log_event(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

/** Wait responsively between retries; SIGINT cancels the delay immediately. */
async function pause(signal) {
  try { await sleep(INTERVAL_MS, undefined, { signal }); }
  catch (error) { if (error.name !== 'AbortError') throw error; }
}

/** Receive continuously while an independent loop checks Codex progress. */
async function poll_loop(store, client, account, signal) {
  while (!signal.aborted) {
    try {
      const response = await client.updates(store.cursor(account.account_id));
      if (signal.aborted) break;
      const received = store.receive(account, response);
      if (received) log_event('received', { count: received });
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof IlinkError && error.session_expired) throw error;
      log_event('receive_retry', { message: '微信读取暂时失败；保留游标后重试' });
    }
    await pause(signal);
  }
}

/** Reconnect only the Codex reader after failures, retaining already accepted submissions. */
async function work_loop(store, client, account, options) {
  const { signal } = options;
  let codex;
  const stop = () => codex?.close();
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (!signal.aborted) {
      try {
        if (!codex) { codex = new CodexClient(options.codex); await codex.open(); }
        await process_weixin(store, codex, account, signal);
      } catch {
        codex?.close(); codex = null;
        if (!signal.aborted) log_event('codex_retry', { message: 'Codex 读取失败；已保存消息不会盲目重投' });
      }
      await flush_outbox(store, client, account, signal);
      await pause(signal);
    }
  } finally { signal.removeEventListener('abort', stop); codex?.close(); }
}

/** Run both loops until cancellation or expired authentication, closing only owned resources. */
async function run_channel(store, account, options) {
  if (!store.bindings(account).length) throw new Error('请先用 bind 显式绑定目标聊天');
  const controller = new AbortController();
  const stop = () => controller.abort();
  const { signal } = controller;
  const client = new IlinkClient(account, { signal });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (options.once) {
      store.receive(account, await client.updates(store.cursor(account.account_id)));
      const codex = new CodexClient(options.codex);
      try { await codex.open(); await process_weixin(store, codex, account, signal); }
      finally { codex.close(); }
      await flush_outbox(store, client, account, signal);
      return;
    }
    log_event('running', { message: '微信通道已启动；Ctrl+C 停止' });
    const guard = async operation => {
      try { await operation; } catch (error) { controller.abort(); throw error; }
    };
    const outcomes = await Promise.allSettled([
      guard(poll_loop(store, client, account, signal)),
      guard(work_loop(store, client, account, { codex: options.codex, signal })),
    ]);
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    controller.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

/** Parse the explicitly local setup and runtime commands. */
function parse_options(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    account: { type: 'string', default: DEFAULT_ACCOUNT }, state: { type: 'string', default: DEFAULT_STATE },
    codex: { type: 'string', default: DEFAULT_CODEX }, alias: { type: 'string' }, thread: { type: 'string' },
    default: { type: 'boolean' }, complete: { type: 'boolean' }, 'verify-code': { type: 'string' },
    'message-id': { type: 'string' }, text: { type: 'string' }, 'text-file': { type: 'string' },
    title: { type: 'string' }, 'request-id': { type: 'string' },
    once: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) return { help: true };
  if (positionals.length !== 1
      || !['login', 'bind', 'unbind', 'run', 'status', 'notify', 'notify-status', 'sync',
        'ask', 'listen', 'listen-start', 'reply-status', 'new-claim', 'new-complete'].includes(positionals[0])) {
    throw new Error('未知命令；使用 --help 查看用法');
  }
  return { ...values, command: positionals[0] };
}

/** Resolve the real source title once per send, with an explicit verified title avoiding a metadata process. */
async function source_details(options) {
  const thread_id = options.thread ?? process.env.CODEX_THREAD_ID;
  if (thread_id && !THREAD_PATTERN.test(thread_id)) throw new Error('来源聊天 UUID 无效');
  let title = options.title;
  if (!title && thread_id) {
    const metadata = await new CodexClient(options.codex).metadata(thread_id);
    title = metadata.name;
    if (!title?.trim()) {
      throw new Error('当前聊天尚未生成名称；请先用桌面 set_thread_title 设置简短中文标题，再沿用同一 message-id 重试');
    }
  }
  format_notice(title, '检查来源');
  return { thread_id, title };
}

/** Execute the short notification commands without entering the Codex bridge loops. */
async function notification_command(store, account, options) {
  const message_id = options['message-id'];
  if (options.command === 'notify-status') return store.notification_status(account, message_id);
  const client = new IlinkClient(account);
  if (options.command === 'sync') {
    const refreshed = store.receive_context(account, await client.updates(store.cursor(account.account_id)));
    const result = store.notification_status(account);
    return { ...result, context_refreshed: refreshed, status: refreshed ? 'context_ready' : 'waiting_context' };
  }
  if ((options.text === undefined) === (options['text-file'] === undefined)) {
    throw new Error('notify 需要 --text 或 --text-file，且不能同时提供');
  }
  const text = options['text-file'] === undefined ? options.text
    : readFileSync(options['text-file'], 'utf8').replace(/^\uFEFF/, '');
  const source = await source_details(options);
  if (options.command === 'ask' && !source.thread_id) throw new Error('ask 需要实际来源聊天 UUID');
  const body = source.thread_id
    ? store.prepare_question(account, { message_id, ...source, text, mode: options.command })
    : format_notice(source.title, text);
  const listener = source.thread_id ? await start_listener(store, account, options) : null;
  return { ...await send_notification(store, client, account, { message_id, text: body }),
    ...source, ...(listener ? { listener_pid: listener.pid } : {}) };
}

/** Handle channel lifecycle and the desktop tool's explicit new-chat acknowledgement. */
async function reply_command(store, account, options) {
  if (options.command === 'new-claim') {
    return store.claim_new_request(account, options['request-id'], options.thread ?? process.env.CODEX_THREAD_ID);
  }
  if (options.command === 'new-complete') {
    return store.complete_new_request(account, options['request-id'], await source_details(options));
  }
  if (options.command === 'listen-start') return start_listener(store, account, options);
  if (options.command === 'listen') await listen_answers(store, account, options);
  return store.reply_status(account);
}

/** Lock only receiving/login operations; independent sends use atomic per-message claims. */
export async function main(args = process.argv.slice(2)) {
  const options = parse_options(args);
  if (options.help) { process.stdout.write(USAGE); return 0; }
  const unlock = ['login', 'run', 'sync', 'listen'].includes(options.command)
    ? acquire_account_lock(options.account) : () => {};
  let store;
  try {
    if (options.command === 'login') {
      const result = options.complete
        ? await complete_login(options.account, { verify_code: options['verify-code'] })
        : await begin_login(options.account);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'connected' || result.status === 'scan_required' ? 0 : 2;
    }
    const account = load_account(options.account);
    store = new WeixinStore(options.state);
    if (['notify', 'notify-status', 'sync', 'ask'].includes(options.command)) {
      const result = await notification_command(store, account, options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return options.command === 'notify-status' || ['api_accepted', 'context_ready'].includes(result.status) ? 0 : 2;
    }
    if (['listen', 'listen-start', 'reply-status', 'new-claim', 'new-complete'].includes(options.command)) {
      const result = await reply_command(store, account, options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    if (options.command === 'bind') {
      if (!ALIAS_PATTERN.test(options.alias ?? '') || !THREAD_PATTERN.test(options.thread ?? '')) {
        throw new Error('bind 需要有效的 --alias 和 --thread UUID');
      }
      const codex = new CodexClient(options.codex);
      try { await codex.open(); await codex.list_turns(options.thread, { limit: 1 }); }
      finally { codex.close(); }
      store.bind(account, options.alias, options.thread, options.default);
    } else if (options.command === 'unbind') {
      if (!options.alias) throw new Error('unbind 需要 --alias');
      store.unbind(account, options.alias);
    } else if (options.command === 'run') await run_channel(store, account, options);
    process.stdout.write(`${JSON.stringify(store.status(account), null, 2)}\n`);
    return 0;
  } finally { store?.close(); unlock(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    const message = error instanceof IlinkError ? error.message
      : error.name === 'TypeError' ? '网络连接或输入失败；未输出凭据，请检查网络和参数' : error.message;
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  });
}
