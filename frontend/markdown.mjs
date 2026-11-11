import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import markdown_it_cjk_friendly from "markdown-it-cjk-friendly";

// CJK-friendly emphasis lets `**结论。**后文` close after Chinese punctuation.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(markdown_it_cjk_friendly)
  .use(katex, { delimiters: "all", throwOnError: false, trust: false, logger: () => "ignore" });

// Platform skills the "/" menu inserts as `$id` (keep in step with PLATFORM_SKILL_COMMANDS in ChannelDiscussion.vue).
const PLATFORM_SKILLS = ["workflow-creator"];
const SKILL_PATTERN = new RegExp(`(^|[\\s(（，,。；;：:])(\\$(?:${PLATFORM_SKILLS.join("|")}))(?![\\w-])`, "gu");
const SKILL_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/></svg>';

// Work on text tokens so mentions and skill references never alter code, URLs, or generated math.
markdown.renderer.rules.text = (tokens, index, options, environment) => {
  const html = markdown.utils.escapeHtml(tokens[index].content).replace(SKILL_PATTERN, `$1<span class="skill-ref">${SKILL_ICON}$2</span>`);
  return environment?.mention ? html.replace(environment.mention, '$1<span class="mention">$2</span>') : html;
};
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
// On request, block elements carry the 1-based source lines they come from, so a selection can be quoted by line.
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
 */
export function render_markdown(text, mentions = [], { source_lines = false } = {}) {
  const handles = [...new Set(mentions.filter(Boolean))].sort((left, right) => right.length - left.length)
    .map(handle => markdown.utils.escapeHtml(handle).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const mention = handles.length ? new RegExp(`(^|[\\s(（，,。；;：:])(@(?:${handles.join("|")}))(?![\\w-])`, "gu") : null;
  return markdown.render(text, { mention, source_lines });
}
