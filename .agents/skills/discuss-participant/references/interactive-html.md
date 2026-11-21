# 交付可操作的演示（HTML）

只在你判断回答需要用户亲手操作（拖动参数看变化、点开分步讲解、可点的界面原型）时读本页。怎么设计页面由你决定；本页只写房间网页能怎样打开它、有哪些限制。

## 两种交付方式

| 方式 | 适用 | 用户怎么打开 |
|---|---|---|
| 附件 | 一次性演示、讲解 | 你回答下方的文件卡片，点开后在预览窗口运行，可切换源码或在新标签页打开 |
| 项目文件 | 要随项目保留、反复修改的页面 | 用户在“项目文件”里打开；按相对路径引用的样式、脚本、图片由电脑内联后一起显示 |

附件：`attachment upload ROOM --file 页面.html` 后 `message post --attachment ID`，见主技能“回答”。项目文件：写在任务 `cwd` 的项目里，正文写明路径，项目只读时改用附件。

## 限制

- **大小**：附件只有不超过 2 MiB 的才会运行，超过只显示截断的源码；项目文件连同内联的引用不超过 8 MiB。
- **附件必须自包含**：附件没有所在目录，相对路径引用的样式、脚本、图片不会载入。CSS、JS、数据都写进文件；图片用 data URL 或内联 SVG。
- **外部资源**：页面可以从 CDN 加载库，但能否加载取决于用户设备的网络；没有外部库也要能用时，宁可手写。
- **沙箱**：页面在没有同源权限的沙箱 iframe 里运行，读不到房间、网站接口和 Cookie，`localStorage` 可能不可用（读写放进 `try`）。页面不能写回房间，也不能唤醒成员。
- **外观**：页面不继承房间主题，深浅色自己用 `prefers-color-scheme` 适配；加 `<meta name="viewport">`，手机端以全屏打开。
- **结论写在正文**：只读分享页不带附件，语音播报只读摘要或正文。页面只承载可操作的部分，结论、关键数字、默认参数下看到的结果写在回答正文里，正文用 `[文件 #n]` 指向附件。
- **自查**：交付前在本机读一遍源码，确认没有引用本机路径、没有写入密钥；能打开浏览器的可先自己打开试一次。

## 最小示例

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>复利演示</title>
<style>
:root{--bg:#fff;--fg:#1f1e1d;--muted:#6b6a66}
@media (prefers-color-scheme:dark){:root{--bg:#1f1e1d;--fg:#ecebe6;--muted:#a3a19a}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif}
.row{display:flex;gap:12px;align-items:center}
input[type=range]{flex:1}
</style>
</head>
<body>
<div class="row"><label for="years">年数</label><input id="years" type="range" min="1" max="40" value="20"><span id="out"></span></div>
<p style="color:var(--muted)">本金 1000，年化 7%</p>
<p id="result" style="font-size:24px"></p>
<script>
const years = document.getElementById('years');
function render() {
  const n = Number(years.value);
  document.getElementById('out').textContent = n + ' 年';
  document.getElementById('result').textContent = Math.round(1000 * 1.07 ** n).toLocaleString();
}
years.oninput = render;
render();
</script>
</body>
</html>
```
