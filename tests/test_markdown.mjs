import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { collapse_visual_fences, render_markdown } from "../frontend/markdown.mjs";

test("renders headings, emphasis, nested lists, quotes, tables, and line breaks", () => {
  const html = render_markdown("### 事实与假设\n\n**已知事实**与*假设*\n第二行\n\n- 第一项\n  - 子项\n\n1. 复核\n2. 收束\n\n> 引用原话\n\n| 项目 | 结果 |\n| --- | --- |\n| 检索 | 通过 |\n\n---");
  for (const part of ["<h3>事实与假设</h3>", "<strong>已知事实</strong>", "<em>假设</em>", "<br>", "<ul>", "<ol>", "<blockquote>", '<th><div class="markdown-cell" style="--cell-text-width:2.0em">项目</div></th>', '<td><div class="markdown-cell" style="--cell-text-width:2.0em">通过</div></td>', "<hr>"]) assert.ok(html.includes(part), part);
  assert.match(html, /class="markdown-table"[^>]+tabindex="0"/);
});

test("emphasis closes after Chinese punctuation followed by Chinese text", () => {
  assert.ok(render_markdown("**零解释成本。**末日片").includes("<strong>零解释成本。</strong>末日片"));
});

test("code preserves literal Markdown, mentions, math, and HTML", () => {
  const html = render_markdown('`@Codex **原文** $x$`\n\n```html\n<script>alert("test")</script>\n@Antigravity **不是强调**\n```');
  assert.match(html, /<code>@Codex \*\*原文\*\* \$x\$<\/code>/);
  assert.ok(html.includes('&lt;script&gt;alert(&quot;test&quot;)&lt;/script&gt;'));
  assert.doesNotMatch(html, /<script|class="mention"|class="katex"|<strong>/);
});

test("untrusted HTML and unsafe links never become executable markup", () => {
  const html = render_markdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n\n[危险](javascript:alert(1))\n\n[编码](jav&#x61;script:alert(1))\n\n[文件](file:///test)\n\n<svg onload=alert(1)>');
  assert.doesNotMatch(html, /<(script|img|svg)\b|href="(?:javascript:|file:)/i);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("safe links open separately and mentions do not rewrite destinations", () => {
  const html = render_markdown("@Codex [资料](https://example.com/@Antigravity) https://example.com\n\n@Codextra", ["Codex"]);
  assert.match(html, /<span class="mention">@Codex<\/span>/);
  assert.match(html, /href="https:\/\/example.com\/@Antigravity" target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /<span class="mention">@Codex<\/span>tra/);
});

test("only display-name mentions are marked; a member ID with a nickname stays plain text", () => {
  const html = render_markdown("@Gemini 请执笔，@Antigravity 也行；@Claude-review 评审，@Claude 汇总", ["Gemini", "Claude-review", "Claude"]);
  assert.match(html, /<span class="mention">@Gemini<\/span>/);
  assert.match(html, /<span class="mention">@Claude-review<\/span>/);
  assert.match(html, /<span class="mention">@Claude<\/span> 汇总/);
  assert.doesNotMatch(html, /class="mention">@Antigravity/);
});

test("renders both math delimiter styles while preserving currency", () => {
  const html = render_markdown(String.raw`工时 $\le 3$ 人日；延迟 \(x^2\)；价格 $500 与 $2,000。

$$
\frac{1}{2}
$$

\[
a^2+b^2=c^2
\]`);
  assert.equal((html.match(/class="katex"/g) || []).length, 4);
  assert.equal((html.match(/class="katex-display"/g) || []).length, 2);
  assert.ok(html.includes("价格 $500 与 $2,000"));
});

test("malformed or untrusted math stays readable without creating links", () => {
  const html = render_markdown(String.raw`$\frac{$ and $\href{javascript:alert(1)}{click}$`);
  assert.match(html, /katex-error/);
  assert.doesNotMatch(html, /<a\b|<script\b/);
  assert.doesNotThrow(() => render_markdown("**长文**\n".repeat(4000)));
});

test("browser bundle exports the same renderer without a Node runtime", () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL("../web/markdown.js", import.meta.url), "utf8"), context);
  assert.equal(context.discuss_markdown.render_markdown("**浏览器**"), render_markdown("**浏览器**"));
});

test("only a visual fence in a member answer becomes a slot; other code stays code", () => {
  const text = ["前文", "", "```visual", "<script>run()</script>", "```", "", "```html", "<b>源码</b>", "```"].join("\n");
  const blocks = [];
  const html = render_markdown(text, [], { visual_label: "交互式可视化", visual_blocks: blocks });
  assert.deepEqual(blocks, ["<script>run()</script>\n"]);
  assert.match(html, /<div class="channel-visual-slot" data-visual-slot="0"><span class="channel-visual-caption">交互式可视化<\/span><\/div>/);
  assert.ok(!html.includes("<script>run()"));
  assert.ok(html.includes("&lt;b&gt;源码&lt;/b&gt;"));
  // Without a label (a user's own message) the fence is ordinary code.
  const plain = render_markdown(text);
  assert.ok(plain.includes("&lt;script&gt;run()&lt;/script&gt;") && !plain.includes("channel-visual-slot"));
  // A page that cannot run visuals (the share page) shows only the label.
  assert.ok(!render_markdown(text, [], { visual_label: "交互式可视化" }).includes("data-visual-slot"));
});

test("collapsing visual fences keeps the prose and ordinary code", () => {
  const code = ["```html", "<b>x</b>", "```"].join("\n");
  const collapsed = collapse_visual_fences(["前文", "```visual", "<p>页面</p>", "```", code, "后文"].join("\n"), "交互式可视化");
  assert.ok(collapsed.includes("交互式可视化") && !collapsed.includes("<p>页面</p>"));
  assert.ok(collapsed.includes(code) && collapsed.startsWith("前文") && collapsed.endsWith("后文"));
});
