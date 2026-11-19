import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import markdown_it_cjk_friendly from "markdown-it-cjk-friendly";
import { FILE_MENTION_PATTERN } from "./file-mention.mjs";

// CJK-friendly emphasis lets `**结论。**后文` close after Chinese punctuation.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(markdown_it_cjk_friendly)
  .use(katex, { delimiters: "all", throwOnError: false, trust: false, logger: () => "ignore" });

// Platform skills the "/" menu inserts as `$id` (keep in step with PLATFORM_SKILL_COMMANDS in ChannelDiscussion.vue).
const PLATFORM_SKILLS = ["workflow-creator"];
const SKILL_PATTERN = new RegExp(`(^|[\\s(（，,。；;：:])(\\$(?:${PLATFORM_SKILLS.join("|")}))(?![\\w-])`, "gu");
const SKILL_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';

// `#123` in room text names message 123; the page opens it on a delegated click on [data-message-ref].
// The lookbehind keeps escaped entities (`&#39;`) and words like `abc#1` plain, and leaves the number of an attachment
// placeholder (`[图片 #1]` / `[文件 #1]`) to the page, which links the whole placeholder to its file.
const MESSAGE_REF_PATTERN = /(?<![\w&#])(?<!\[(?:图片|文件) )#(\d{1,9})(?![\w-])/gu;

/** Whether a text token sits inside a Markdown link, where a nested button would break the link. */
function inside_link(tokens, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (tokens[cursor].type === "link_close") return false;
    if (tokens[cursor].type === "link_open") return true;
  }
  return false;
}

// Work on text tokens so mentions, skill and message references never alter code, URLs, or generated math.
markdown.renderer.rules.text = (tokens, index, options, environment) => {
  let html = markdown.utils.escapeHtml(tokens[index].content).replace(SKILL_PATTERN, `$1<span class="skill-ref">${SKILL_ICON}$2</span>`);
  if (environment?.message_refs && !inside_link(tokens, index)) html = html.replace(MESSAGE_REF_PATTERN, '<button type="button" class="message-ref" data-message-ref="$1">#$1</button>');
  if (!environment?.mention) return html;
  return html.replace(FILE_MENTION_PATTERN, '$1<span class="mention">$2</span>').replace(environment.mention, '$1<span class="mention">$2</span>');
};
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
// On request, block elements carry the 1-based source lines they come from, so a selection can be quoted by line.
// A file's leading YAML front matter (`---` … `---` on the first lines) is metadata, not text: shown as a small muted
// block, as Typora and other editors do, instead of a rule and a large setext heading. Only at the very top of a file.
markdown.block.ruler.before("hr", "front_matter", (state, start, end, silent) => {
  if (start !== 0 || state.blkIndent !== 0 || state.src.slice(state.bMarks[0], state.eMarks[0]).trim() !== "---") return false;
  let line = 1;
  while (line < end && state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]).trim() !== "---") line++;
  if (line >= end || line === 1) return false;
  if (silent) return true;
  const token = state.push("front_matter", "div", 0);
  token.block = true;
  token.map = [0, line + 1];
  token.content = state.getLines(1, line, 0, false).replace(/\n$/, "");
  state.line = line + 1;
  return true;
});
markdown.renderer.rules.front_matter = (tokens, index) => {
  const token = tokens[index];
  const lines = token.attrGet("data-source-lines");
  return `<pre class="markdown-front-matter"${lines ? ` data-source-lines="${lines}"` : ""}>${markdown.utils.escapeHtml(token.content)}</pre>\n`;
};
markdown.core.ruler.push("source_lines", (state) => {
  if (!state.env?.source_lines) return;
  for (const token of state.tokens) {
    if (token.map && token.block && token.nesting !== -1 && token.type !== "inline") token.attrSet("data-source-lines", `${token.map[0] + 1}-${token.map[1]}`);
  }
});
markdown.renderer.rules.table_open =() => '<div class="markdown-table" role="region" aria-label="表格，可横向滚动" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";
// Cell content sits in a width-capped block, so a table keeps its natural width (scrolling sideways when wider than the card)
// while long cells still wrap instead of stretching into one line.
for (const cell of ["th", "td"]) {
  markdown.renderer.rules[`${cell}_open`] = (tokens, index, options, environment, renderer) => `${renderer.renderToken(tokens, index, options)}<div class="markdown-cell">`;
  markdown.renderer.rules[`${cell}_close`] = (tokens, index, options, environment, renderer) => `</div>${renderer.renderToken(tokens, index, options)}`;
}
// Code blocks carry a copy button; the page copies the adjacent <pre> text through a delegated click on [data-copy-code].
const render_fence = markdown.renderer.rules.fence;
const COPY_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';
markdown.renderer.rules.fence = (...args) => `<div class="markdown-code"><button type="button" class="markdown-copy" data-copy-code title="复制代码" aria-label="复制代码">${COPY_ICON}</button>${render_fence(...args)}</div>\n`;

/**
 * Render stored Markdown as safe HTML; the source text remains unchanged.
 * `mentions` are the names @ calls members by (their display names); any other @text, such as a member ID, stays plain.
 * The boundaries match the page's own @ parsing, so only what names a member looks like a mention.
 * With `source_lines`, block elements get `data-source-lines="first-last"` (a file preview quotes selections by line).
 * With `message_refs`, `#123` outside code and links becomes a button carrying `data-message-ref="123"`.
 */
export function render_markdown(text, mentions = [], { source_lines = false, message_refs = false } = {}) {
  const handles = [...new Set(mentions.filter(Boolean))].sort((left, right) => right.length - left.length)
    .map(handle => markdown.utils.escapeHtml(handle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const mention = handles.length ? new RegExp(`(^|[\\s(（，,。；;：:])(@(?:${handles.join("|")}))(?![\\w-])`, "gu") : null;
  return markdown.render(text, { mention, source_lines, message_refs });
}
