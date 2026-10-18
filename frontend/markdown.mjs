import MarkdownIt from "markdown-it";
import { katex } from "@mdit/plugin-katex";

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true })
  .use(katex, { delimiters: "all", throwOnError: false, trust: false, logger: () => "ignore" });
const MENTION_PATTERN = /(@(?:Codex|Claude|Gemini|DeepSeek|Qwen|用户)(?!\w))/g;

// Work on text tokens so mentions never alter code, URLs, or generated math.
markdown.renderer.rules.text = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content)
  .replace(MENTION_PATTERN, '<span class="mention">$1</span>');
markdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.table_open = () => '<div class="markdown-table" role="region" aria-label="表格，可横向滚动" tabindex="0"><table>\n';
markdown.renderer.rules.table_close = () => "</table></div>\n";

/** Render stored Markdown as safe HTML; the source text remains unchanged. */
export function render_markdown(text) {
  return markdown.render(text);
}
