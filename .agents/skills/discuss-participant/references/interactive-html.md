# 交付可操作的演示（HTML）

只在你判断回答需要用户亲手操作（拖动参数看变化、点开分步讲解、可点的界面原型）时读本页。怎么设计页面由你决定；本页只写房间网页怎样显示它、给了页面什么、有哪些限制。

## 三种交付方式

| 方式 | 适用 | 用户看到什么 |
|---|---|---|
| 正文引用的附件 | 回答里的一张图：一个量变了，图跟着变 | 在正文写 `[文件 #n]` 的位置直接显示，没有边框和底色，高度随内容；下方一行小字可收起、放大、看源码、下载 |
| 未引用的附件 | 篇幅大、不必打断阅读的页面 | 回答下方的文件卡片，点“在消息内展开”或点开预览窗口才运行 |
| 项目文件 | 要随项目保留、反复修改的页面 | 用户在“项目文件”里打开；按相对路径引用的样式、脚本、图片由电脑内联后一起显示 |

附件：`attachment upload ROOM --file 页面.html` 后 `message post --attachment ID`，见主技能“回答”；演示是给人看的成品，默认作为附件交付。项目文件：用户要它留在项目里时写在任务 `cwd` 的项目里，正文用反引号写明路径，同时仍附上附件。

`[文件 #n]` 的 n 从 1 起，按本条消息 `--attachment` 的先后顺序数；提交后程序换成房间内的统一编号。

直接显示的条件：文件名以 `.html` 结尾，不超过 2 MiB，引用写在正文里（不在代码或链接里）。同一附件只在第一次引用处显示。手机上同样就地显示，宽度窄到 320px 左右，页面要能用。

## 房间给页面的东西

直接显示和“在消息内展开”时，房间往页面里注入一份基础样式和下面的变量。变量在页面载入后送到，用户切换深浅色时再送一次。

| 变量 | 含义 |
|---|---|
| `--codiscuss-text` | 正文色 |
| `--codiscuss-text-muted` | 次要文字 |
| `--codiscuss-text-hint` | 提示文字、刻度 |
| `--codiscuss-border` | 边框、分隔线、坐标轴 |
| `--codiscuss-accent` | 强调色 |
| `--codiscuss-card` | 卡片底色（控件底、需要与背景区分的色块） |
| `--codiscuss-font-family`、`--codiscuss-font-size` | 房间正文的字体与字号 |
| `--codiscuss-radius` | 圆角 |
| `--codiscuss-color-scheme` | `light` 或 `dark` |

已由房间设好、页面改不了的：`html` 和 `body` 透明底、外边距为 0；`body` 的文字颜色、字体、字号；深浅色。

已有默认外观、可以覆盖的：`button`、`select`、文本类 `input` 有边框、圆角、底色和内边距；滑块、复选框、单选框用强调色；键盘焦点有描边。

## 约束

- **不设页面底色，不设 `body` 字体和颜色**：设了也不生效。需要色块时用 `--codiscuss-card`。
- **颜色只用变量，并写兜底值**：如 `var(--codiscuss-accent, #2563eb)`。放大的预览窗口、手机全屏和新标签页也注入房间主题，兜底值用于变量到达前或在房间之外直接打开文件时。不写 `prefers-color-scheme`，深浅色由房间决定。
- **颜色写在 CSS 里**（SVG 用 `fill`、`stroke` 引用变量），不在脚本里读一次存起来：变量晚于页面脚本到达，切换主题时还会变。
- **不写固定高度**：房间测量 `body` 的实际高度来定显示高度，上限是视口的 80%，超出时在框内滚动。不用 `100vh` 撑满：框的高度就是上次量到的内容高度，撑满后不会再缩回去。
- **不写固定宽度**：显示宽度等于正文栏，随窗口变化；预览窗口更宽。内容设宽度上限并居中，窄到 320px 时仍能用。字号用 `em`，跟随房间字号。
- **直接显示时没有网络**：外部脚本、样式、字体、图片和 `fetch` 都被拦截，CDN 上的库载不进来。CSS、JS、数据都写进文件；图片用 data URL 或内联 SVG。
- **直接显示时只能运行脚本**：`alert`、`confirm`、打开新窗口、提交表单都不可用。页面读不到房间、网站接口和 Cookie，`localStorage` 不可用（读写放进 `try`）。页面不能写回房间，也不能唤醒成员。
- **滚出视口后页面会卸载**，滚回来重新运行，用户调过的参数回到初始值。默认参数要能说明问题。
- **大小**：附件超过 2 MiB 不运行，只显示截断的源码；项目文件连同内联的引用不超过 8 MiB。
- **结论写在正文**：只读分享页不带附件，语音播报只读摘要或正文。页面只承载可操作的部分，结论、关键数字、默认参数下看到的结果写在回答正文里。
- **自查**：交付前读一遍源码，确认没有引用本机路径、没有写入密钥；能打开浏览器的先自己打开试一次。

## 最小示例

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>复利演示</title>
<style>
.wrap { max-width: 560px; margin: 0 auto; }
.muted { color: var(--codiscuss-text-muted, #6b7280); }
.result { font-size: 1.8em; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }
.bar { height: 6px; margin: .8em 0; border-radius: 3px; background: var(--codiscuss-border, #d4d4d8); }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--codiscuss-accent, #2563eb); }
.row { display: flex; gap: 1em; align-items: center; }
.row input { flex: 1; }
</style>
</head>
<body>
<div class="wrap">
  <p class="result" id="result"></p>
  <p class="muted">本金 1000，年化 7%</p>
  <div class="bar"><i id="fill"></i></div>
  <label class="row"><span>年数</span><input id="years" type="range" min="1" max="40" value="20"><output id="out" class="muted"></output></label>
</div>
<script>
const PRINCIPAL = 1000, RATE = 0.07, MAX_YEARS = 40;
const years = document.getElementById('years');
function render() {
  const count = Number(years.value), value = PRINCIPAL * (1 + RATE) ** count;
  document.getElementById('out').textContent = count + ' 年';
  document.getElementById('result').textContent = Math.round(value).toLocaleString();
  document.getElementById('fill').style.width = 100 * value / (PRINCIPAL * (1 + RATE) ** MAX_YEARS) + '%';
}
years.oninput = render;
render();
</script>
</body>
</html>
```
