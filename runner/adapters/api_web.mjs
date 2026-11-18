/**
 * Web tools of a model API member: web_search and web_fetch. Claude Code, Codex and Antigravity bring their own; a model
 * API brings none, so the runner supplies them at every project access level (not on a task confined to the room).
 * They follow DeepSeek Harness's defaults (packages/web, https://github.com/deepseek-ai/deepseek-harness at 39163dd30f,
 * MIT License, Copyright (c) 2026 DeepSeek): search is the DeepSeek Search API, billed to a DeepSeek API key, and fetch
 * is an anonymous local request.
 *
 * Input: a search query, or a public http(s) address. Output: search results, or the page as plain text in slices.
 * Fetches leave from this computer, which also runs the site and other private services, so an address that resolves
 * to loopback, a private network or Tailscale is refused at connection time, on every redirect. Node's built-in modules
 * only.
 */
import { lookup } from 'node:dns';
import { request as http_request } from 'node:http';
import { request as https_request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { read_saved_api_key, saved_api_keys } from '../discussion_api.mjs';

const REQUEST_TIMEOUT_MS = 20_000;
const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const SEARCH_KEY_HOST = 'api.deepseek.com';
const SEARCH_TIMEOUT_MS = 60_000;
const SEARCH_ERROR_CHARS = 300;
const MAX_REDIRECTS = 5;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DEFAULT_PAGE_CHARS = 20_000;
const MAX_PAGE_CHARS = 60_000;
const DEFAULT_RESULTS = 8;
const MAX_RESULTS = 10;
const MAX_QUERY_CHARS = 400;
const CHARSET_SNIFF_BYTES = 2048;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const TEXT_TYPES = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml)\b)/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', plusmn: '±', deg: '°', le: '≤', ge: '≥', copy: '©', reg: '®' };

// 198.18.0.0/15 stays open: Clash in TUN fake-ip mode answers every public name from that range.
const BLOCKED = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(network, prefix, 'ipv6');

/** Whether an IP address belongs to this computer or a private network rather than the public internet. */
export function is_private_address(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return BLOCKED.check(mapped, 'ipv4');
  return BLOCKED.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** A DNS lookup that fails when any address of the name is private, so the checked address is the one connected to. */
function guarded_lookup(is_blocked) {
  return (hostname, options, callback) => lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (addresses.some(item => is_blocked(item.address))) return callback(new Error(`不能访问本机或内网地址：${hostname}`));
    return options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family);
  });
}

/** The address to request, refused unless it is public http(s) without embedded credentials. */
function public_url(address, is_blocked) {
  let url;
  try { url = new URL(address); } catch { throw new Error(`网址无效：${address}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只能访问 http 或 https 网址');
  if (url.username || url.password) throw new Error('网址不能包含账号或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && is_blocked(host)) throw new Error(`不能访问本机或内网地址：${host}`);
  return url;
}

/** Read a response body up to the page limit, decompressing it; a longer page is kept up to the limit. */
function read_body(response, url) {
  const decoders = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const decoder = decoders[String(response.headers['content-encoding'] || '').toLowerCase()]?.();
  const stream = decoder ? response.pipe(decoder) : response;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const finish = truncated => resolve({ status: response.statusCode, headers: response.headers, url: url.href, body: Buffer.concat(chunks), truncated });
    stream.on('data', chunk => {
      if (size >= MAX_PAGE_BYTES) return;
      chunks.push(chunk.subarray(0, MAX_PAGE_BYTES - size));
      size += chunk.length;
      if (size < MAX_PAGE_BYTES) return;
      response.destroy();
      finish(true);
    });
    stream.on('end', () => finish(false));
    stream.on('error', reject);
    response.on('error', reject);
  });
}

/** One request without following redirects. */
function request_once(url, signal, is_blocked) {
  const send = url.protocol === 'https:' ? https_request : http_request;
  return new Promise((resolve, reject) => {
    const request = send(url, { method: 'GET', signal, lookup: guarded_lookup(is_blocked), headers: { 'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'accept-encoding': 'gzip, deflate, br' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: new URL(response.headers.location, url).href });
      } else read_body(response, url).then(resolve, reject);
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetch a public page, checking every redirect's target.
 *
 * @param {string} address - the http(s) address.
 * @param {{signal?: AbortSignal, is_blocked?: function(string): boolean}} [options] - stops the request; which IPs to refuse.
 * @returns {Promise<{status: number, headers: object, url: string, body: Buffer, truncated: boolean}>} the final response.
 */
export async function fetch_page(address, { signal, is_blocked = is_private_address } = {}) {
  const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, limit]) : limit;
  let next = address;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const outcome = await request_once(public_url(next, is_blocked), combined, is_blocked);
    if (!outcome.redirect) return outcome;
    next = outcome.redirect;
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
}

/** Decode a page by its declared charset (header, then meta tag), so GBK sites read correctly. */
function decode_page(body, content_type) {
  const declared = /charset=["']?([\w-]+)/i.exec(content_type)?.[1] || /charset=["']?([\w-]+)/i.exec(body.subarray(0, CHARSET_SNIFF_BYTES).toString('latin1'))?.[1];
  try { return new TextDecoder(declared || 'utf-8').decode(body); } catch { return new TextDecoder().decode(body); }
}

/** Replace HTML entities with their characters; an unknown one stays as written. */
function decode_entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (entity, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? entity;
    const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity;
  });
}

/** Inline HTML as one line of text. */
function inline_text(html) {
  return decode_entities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** The readable text of an HTML page, keeping line structure, list items and table cells. */
export function html_text(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<\/t[dh]\s*>/gi, ' | ').replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|main|aside|header|footer|nav|ul|ol|table|tr|h[1-6]|blockquote|pre|dl|dt|dd|form|figure)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decode_entities(text).split('\n').map(line => line.replace(/[ \t 　]+/g, ' ').trim()).filter(Boolean).join('\n');
}

/**
 * The DeepSeek API key web_search bills: the member's own when it runs on DeepSeek, else the one saved on this computer.
 *
 * @param {string} home - the service directory holding saved keys.
 * @param {{base_url?: string}} profile - the member's model API settings.
 * @param {string} member_key - the member's own API key.
 * @returns {string} the key, or '' when this computer has none, which withholds web_search.
 */
export function web_search_key(home, profile, member_key) {
  const on_deepseek = address => { try { return new URL(address).hostname === SEARCH_KEY_HOST; } catch { return false; } };
  if (member_key && on_deepseek(profile?.base_url)) return member_key;
  try {
    const saved = saved_api_keys(home);
    const root = Object.keys(saved).find(on_deepseek);
    return root ? read_saved_api_key(home, root, saved[root]) : '';
  } catch { return ''; }
}

/** One search through the DeepSeek Search API; a redirect fails, so the key never reaches another address. */
async function run_search(args, signal, key) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error('query 不能为空');
  if (query.length > MAX_QUERY_CHARS) throw new Error(`query 不能超过 ${MAX_QUERY_CHARS} 个字符`);
  const count = Math.min(Math.max(Number(args.limit) || DEFAULT_RESULTS, 1), MAX_RESULTS);
  const limit = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const response = await fetch(SEARCH_ENDPOINT, { method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, limit]) : limit,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, count, need_content: false }) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`DeepSeek 搜索返回 HTTP ${response.status}：${String(body?.error?.message || '').slice(0, SEARCH_ERROR_CHARS)}`);
  if (!Array.isArray(body?.results)) throw new Error('DeepSeek 搜索的返回格式无法识别');
  return { query, results: body.results.filter(item => typeof item?.url === 'string' && item.url).map(item => ({ title: String(item.title || ''), url: item.url,
    snippet: String(item.snippet || ''), ...(item.summary ? { summary: String(item.summary) } : {}), ...(item.date ? { date: String(item.date) } : {}) })) };
}

async function run_fetch(args, signal) {
  const page = await fetch_page(String(args.url || ''), { signal });
  if (page.status >= 400) throw new Error(`网页返回 HTTP ${page.status}`);
  const content_type = String(page.headers['content-type'] || '');
  if (content_type && !TEXT_TYPES.test(content_type)) {
    return { url: page.url, content_type, readable: false, reason: '不是文本网页（如 PDF、图片、压缩包），读不到内容；在回答里说明没有读取' };
  }
  const decoded = decode_page(page.body, content_type);
  const is_html = /html/i.test(content_type) || /^\s*<(!doctype|html)/i.test(decoded);
  const text = is_html ? html_text(decoded) : decoded;
  const offset = Math.max(Number(args.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_PAGE_CHARS, 1), MAX_PAGE_CHARS);
  const end = Math.min(offset + limit, text.length);
  return { url: page.url, title: is_html ? inline_text(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(decoded)?.[1] || '') : '', content_type, total_chars: text.length,
    text: text.slice(offset, end), ...(end < text.length ? { next_offset: end } : {}), ...(page.truncated ? { page_truncated: true } : {}) };
}

const WEB_TOOLS = [
  { name: 'web_search', description: `搜索网页，返回标题、网址与摘要。摘要不等于原文：要引用的内容用 web_fetch 读原网页核实。limit 默认 ${DEFAULT_RESULTS}，最多 ${MAX_RESULTS}`,
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: MAX_QUERY_CHARS }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULTS } }, required: ['query'], additionalProperties: false } },
  { name: 'web_fetch', description: `读取一个公开网页的正文（http 或 https），不能访问本机或内网地址，读不到 PDF、图片等非文本文件。长网页用 offset（从第几个字符起）与 limit（默认 ${DEFAULT_PAGE_CHARS}，最多 ${MAX_PAGE_CHARS}）按返回的 next_offset 续读`,
    parameters: { type: 'object', properties: { url: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE_CHARS } }, required: ['url'], additionalProperties: false } },
];

/** The web tools this task may use: none when confined to the room (`no_web`), and no search without a DeepSeek key. */
export function web_tools(context) {
  if (context.no_web) return [];
  return context.web_search_key ? WEB_TOOLS : WEB_TOOLS.filter(item => item.name !== 'web_search');
}

/** Whether a tool name is one of the web tools. */
export function is_web_tool(name) {
  return WEB_TOOLS.some(item => item.name === name);
}

/** Run one web tool; a failure is thrown for the caller to hand back to the model. */
export function run_web_tool(name, args, signal, search_key = '') {
  return name === 'web_search' ? run_search(args, signal, search_key) : run_fetch(args, signal);
}
