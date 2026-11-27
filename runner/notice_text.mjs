/**
 * The text of an owner notice, shared by every notification channel: plain text from the room's Markdown, the source
 * and room on the first line, and the receiver's own receipts. Channels that render richer text may still send this.
 */
import { randomUUID } from 'node:crypto';

const CHUNK_BYTES = 3_500;
// Messages name their source first, as coder_notifier's do (`💬 Codex（…）：`), since one chat may get both.
const SOURCE = 'CoDiscuss';

/**
 * Chat channels show plain text: turn common Markdown into readable text, keeping code and link targets. Copied from
 * coder_notifier's `weixin_text`.
 */
export function plain_text(text) {
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

/**
 * A notice as Weixin shows it: the source and room on the first line, a blank line, then plain-text paragraphs.
 * Weixin folds single line breaks into spaces, so `paragraphs` are joined by blank lines.
 */
export function format_notice(title, paragraphs) {
  const body = paragraphs.filter(Boolean).map(part => plain_text(part)).join('\n\n');
  return `💬 ${SOURCE}${title ? `（${title}）` : ''}：\n\n${body}`;
}

/** A reply the receiver writes itself, not from a room. */
export function system_text(text) {
  return `🔔 ${SOURCE} 系统通知：\n\n${text}`;
}

/** Split text on code points so each chunk stays under iLink's payload size. */
export function split_text(text, limit = CHUNK_BYTES) {
  const chunks = [];
  let chunk = '', bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > limit) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += character;
    bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}
