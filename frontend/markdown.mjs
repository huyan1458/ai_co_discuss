import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";
import markdown_it_cjk_friendly from "markdown-it-cjk-friendly";

// CJK-friendly emphasis lets `**结论。**后文` close after Chinese punctuation.
const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(markdown_it_cjk_friendly)
  .use(katex, { delimiters: "all", throwOnError: false, trust: false, logger: () => "ignore" });

// Work on text tokens so mentions never alter code, URLs, or generated math.
markdown.renderer.rules.text = (tokens, index, options, environment) => {
  const html = markdown.utils.escapeHtml(tokens[index].content);
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
