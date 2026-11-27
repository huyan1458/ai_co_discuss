# 交互式可视化示例

写页面前按需读一个，照结构改，不必照抄题材。优先用统一样式（`cd-*` 类，见规则页），示例 3 的权重滑块要在轨道上画“第一名不变”的区间，统一滑块表达不了，才自己画。规则与约束见 [交付交互式可视化](interactive-html.md)。

## 1. 展示：一个量变了，图跟着变

全部用统一样式：`cd-stats` 放关键数字，`cd-field` 放滑块，几乎不写自己的 CSS。

````markdown
年数越长，复利效果越明显：默认 20 年，1000 元变成约 3870 元。

```visual
<style>
.bar { height: 6px; margin: .9em 0; border-radius: 3px; background: color-mix(in srgb, var(--codiscuss-border, #d4d4d8) 70%, transparent); }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--codiscuss-accent, #2563eb); }
</style>
<div class="cd-wrap">
  <div class="cd-stats">
    <div class="cd-stat"><b id="result"></b><span>到期金额（元）</span></div>
    <div class="cd-stat"><b id="times"></b><span>本金倍数</span></div>
  </div>
  <div class="bar"><i id="fill"></i></div>
  <label class="cd-field"><span>年数</span><input id="years" type="range" min="1" max="40" value="20"><output id="out"></output></label>
  <p class="cd-hint">本金 1000，年化 7%</p>
</div>
<script>
const PRINCIPAL = 1000, RATE = 0.07, MAX_YEARS = 40;
const years = document.getElementById('years');
function render() {
  const count = Number(years.value), value = PRINCIPAL * (1 + RATE) ** count;
  document.getElementById('out').textContent = count + ' 年';
  document.getElementById('result').textContent = Math.round(value).toLocaleString();
  document.getElementById('times').textContent = (value / PRINCIPAL).toFixed(1) + '×';
  document.getElementById('fill').style.width = 100 * value / (PRINCIPAL * (1 + RATE) ** MAX_YEARS) + '%';
}
years.oninput = render;
render();
</script>
```

拖到 40 年约 14975 元：后 20 年多赚的钱，是前 20 年的近 4 倍。
````

## 2. 静态图示：流程或结构

图文并茂不一定要能操作。用 SVG 加 `cd-*` 类画，`viewBox` 宽度取 400–480；没有脚本也行。

````markdown
一条消息从发出到被回答，经过三步：

```visual
<svg class="cd-chart" viewBox="0 0 460 104" role="img" aria-label="消息处理流程">
  <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="cd-fill-muted"/></marker></defs>
  <rect x="4" y="14" width="120" height="48" rx="8" class="cd-box"/>
  <text x="64" y="38" text-anchor="middle" dominant-baseline="central" class="cd-label">用户发消息</text>
  <rect x="170" y="14" width="120" height="48" rx="8" class="cd-box"/>
  <text x="230" y="38" text-anchor="middle" dominant-baseline="central" class="cd-label">主持人分派</text>
  <rect x="336" y="14" width="120" height="48" rx="8" class="cd-box-accent"/>
  <text x="396" y="38" text-anchor="middle" dominant-baseline="central" class="cd-label" style="font-weight:600">成员回答</text>
  <path d="M126 38H166M292 38H332" class="cd-axis" marker-end="url(#arrow)"/>
  <text x="230" y="90" text-anchor="middle" class="cd-tick">点名某位成员时跳过分派</text>
</svg>
```
````

节点默认用中性的 `cd-box`，只给关键节点 `cd-box-accent` 加粗体文字；文字不要压在实心强调色（`cd-fill`）上，深色主题下看不清。图里的文字在手机上不随图形缩小，所以文字与相邻图形之间留出余量（这里说明文字离节点底边 20 多个单位），文字用 `dominant-baseline="central"` 对准节点中线。

## 3. 提问面板：调权重看方案排名

属于问题卡做不到的“联动计算”：用户拖权重，排名当场重算，每个权重的轨道上标出第一名不变的区间；点按钮交回权重与选择。要点：

- 得分附依据（展开“得分与依据”），主观折算的写明是假设；交回的文字带上前提。
- 没有 `window.codiscuss?.submit` 时隐藏按钮，改为提示打字回复。

````markdown
按你“质量和中文更重要”的偏好，Neon 与 Opus 几乎打平；中文表达权重超过 3.1 时 Opus 第一。也可以直接回复四个权重。

```visual
<style>
.wrap { max-width: 600px; margin: 0 auto; }
.eyebrow { margin: 0; font-size: .78em; letter-spacing: .04em; color: var(--codiscuss-text-hint, #9ca3af); }
.lead { margin: .1em 0 0; font-size: 1.45em; font-weight: 600; line-height: 1.3; color: var(--codiscuss-accent, #2563eb); }
.sub { margin: .25em 0 0; font-size: .88em; color: var(--codiscuss-text-muted, #6b7280); font-variant-numeric: tabular-nums; }
.ranks { list-style: none; margin: 1em 0 0; padding: 0; display: grid; gap: .55em; }
.ranks li { display: grid; grid-template-columns: 1.2em 7.2em 1fr 2.4em; gap: .7em; align-items: center; font-size: .95em; }
.ranks .pos { color: var(--codiscuss-text-hint, #9ca3af); font-size: .8em; text-align: right; }
.ranks .track { height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--codiscuss-border, #e5e7eb) 70%, transparent); overflow: hidden; }
.ranks .fill { height: 100%; border-radius: 3px; background: var(--codiscuss-text-hint, #9ca3af); opacity: .7; transition: width .25s ease; }
.ranks .score { text-align: right; font-variant-numeric: tabular-nums; color: var(--codiscuss-text-muted, #6b7280); }
.ranks li.win { font-weight: 600; }
.ranks li.win .fill { background: var(--codiscuss-accent, #2563eb); opacity: 1; }
.ranks li.win .score { color: inherit; }
.section { display: flex; align-items: baseline; justify-content: space-between; margin: 1.4em 0 .4em; padding-top: 1em; border-top: 1px solid color-mix(in srgb, var(--codiscuss-border, #e5e7eb) 70%, transparent); }
.section span { font-size: .78em; letter-spacing: .04em; color: var(--codiscuss-text-hint, #9ca3af); }
.weights { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 1em 1.6em; }
.weight, .slider, .weight .note { display: block; }
.weight .head { display: flex; justify-content: space-between; align-items: baseline; }
.weight .value { font-variant-numeric: tabular-nums; font-weight: 600; }
.slider { position: relative; height: 22px; margin-top: .2em; }
.slider .rail, .slider .zone { position: absolute; top: 50%; height: 4px; margin-top: -2px; border-radius: 2px; }
.slider .rail { left: 0; right: 0; background: color-mix(in srgb, var(--codiscuss-border, #e5e7eb) 80%, transparent); }
.slider .zone { background: var(--codiscuss-accent, #2563eb); opacity: .4; transition: left .2s ease, width .2s ease; }
.slider input { position: absolute; inset: 0; width: 100%; margin: 0; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
.slider input::-webkit-slider-runnable-track { height: 22px; background: transparent; }
.slider input::-moz-range-track { height: 22px; background: transparent; }
.slider input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: 4px; border: 0; border-radius: 50%; background: var(--codiscuss-accent, #2563eb); }
.slider input::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--codiscuss-accent, #2563eb); }
.slider input:focus-visible { outline: none; }
.slider input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 5px color-mix(in srgb, var(--codiscuss-accent, #2563eb) 24%, transparent); }
.weight .note { margin-top: .15em; font-size: .78em; color: var(--codiscuss-text-hint, #9ca3af); }
details { margin-top: 1.2em; font-size: .85em; color: var(--codiscuss-text-muted, #6b7280); }
summary { cursor: pointer; width: fit-content; }
table { width: 100%; margin-top: .5em; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: .3em .4em; text-align: left; border-bottom: 1px solid color-mix(in srgb, var(--codiscuss-border, #e5e7eb) 70%, transparent); font-weight: 400; }
th { color: var(--codiscuss-text-hint, #9ca3af); }
.basis { margin: .5em 0 0; line-height: 1.6; }
.foot { display: flex; gap: 1em; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: 1.2em; }
.foot .hint { font-size: .82em; color: var(--codiscuss-text-hint, #9ca3af); }
</style>
<div class="wrap">
  <p class="eyebrow">按你的权重，主持人最适合</p>
  <p class="lead" id="winner"></p>
  <p class="sub" id="margin"></p>
  <ol class="ranks" id="ranks" aria-label="加权得分排名"></ol>

  <div class="section"><span>你的权重</span><span>浅色区间内拖动，第一名不变</span></div>
  <div class="weights" id="weights"></div>

  <details>
    <summary>得分与依据</summary>
    <table id="table"></table>
    <p class="basis">质量、省钱、速度按成员分工参考里的公开跑分、每套题成本与耗时折算；中文表达按你的使用经验：Codex 中文偏防御腔，Gemini 排版差。都是主观折算，结论只在这组得分成立时成立。</p>
  </details>

  <div class="foot">
    <span class="hint" id="hint">满分 10 分，按权重加权平均</span>
    <button id="submit" class="cd-primary" type="button">按这组权重交给主持人</button>
  </div>
</div>
<script>
const CRITERIA = [
  { key: "quality", label: "质量", weight: 5 },
  { key: "cost", label: "省钱", weight: 1 },
  { key: "speed", label: "速度", weight: 1 },
  { key: "chinese", label: "中文表达", weight: 3 },
];
const OPTIONS = [
  { label: "Opus 5.5", scores: { quality: 9, cost: 3, speed: 4, chinese: 9 } },
  { label: "Sonnet 5.5", scores: { quality: 7.5, cost: 5, speed: 4, chinese: 8 } },
  { label: "GPT-6.2 Sol", scores: { quality: 7.5, cost: 9.5, speed: 7.5, chinese: 5 } },
  { label: "Gemini Neon", scores: { quality: 8.5, cost: 8.5, speed: 9, chinese: 6.5 } },
];
const MAX_WEIGHT = 10, STEP = 0.1;
const $ = (id) => document.getElementById(id);

function ranking(weights) {
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0) || 1;
  return OPTIONS.map((option) => ({
    label: option.label,
    score: CRITERIA.reduce((sum, item) => sum + option.scores[item.key] * weights[item.key], 0) / total,
  })).sort((left, right) => right.score - left.score);
}

/** The range of one weight, the others held, in which the current first place stays first. */
function stable_range(weights, key, winner) {
  let low = null, high = null;
  for (let value = 0; value <= MAX_WEIGHT + 1e-9; value += STEP) {
    if (ranking({ ...weights, [key]: value })[0].label !== winner) continue;
    if (low === null) low = value;
    high = value;
  }
  return [low ?? 0, high ?? 0];
}

const current = () => Object.fromEntries(CRITERIA.map((item) => [item.key, Number($("w-" + item.key).value)]));

$("weights").innerHTML = CRITERIA.map((item) => `<label class="weight">
  <span class="head"><span>${item.label}</span><span class="value" id="o-${item.key}"></span></span>
  <span class="slider"><span class="rail"></span><span class="zone" id="z-${item.key}"></span>
    <input id="w-${item.key}" type="range" min="0" max="${MAX_WEIGHT}" step="1" value="${item.weight}" aria-label="${item.label}的权重"></span>
  <span class="note" id="n-${item.key}"></span></label>`).join("");
$("table").innerHTML = `<tr><th>方案</th>${CRITERIA.map((item) => `<th>${item.label}</th>`).join("")}</tr>`
  + OPTIONS.map((option) => `<tr><td>${option.label}</td>${CRITERIA.map((item) => `<td>${option.scores[item.key]}</td>`).join("")}</tr>`).join("");

function render() {
  const weights = current(), ranked = ranking(weights), winner = ranked[0].label;
  $("winner").textContent = winner;
  $("margin").textContent = `${ranked[0].score.toFixed(2)} 分，领先 ${ranked[1].label} ${(ranked[0].score - ranked[1].score).toFixed(2)} 分`;
  $("ranks").replaceChildren(...ranked.map((entry, index) => {
    const row = document.createElement("li");
    row.className = index === 0 ? "win" : "";
    row.innerHTML = `<span class="pos">${index + 1}</span><span></span><span class="track"><span class="fill" style="display:block;width:${entry.score * 10}%"></span></span><span class="score">${entry.score.toFixed(1)}</span>`;
    row.children[1].textContent = entry.label;
    return row;
  }));
  for (const item of CRITERIA) {
    $("o-" + item.key).textContent = weights[item.key];
    const [low, high] = stable_range(weights, item.key, winner);
    const zone = $("z-" + item.key);
    zone.style.left = low / MAX_WEIGHT * 100 + "%";
    zone.style.width = Math.max((high - low) / MAX_WEIGHT * 100, 1.5) + "%";
    $("n-" + item.key).textContent = high - low >= MAX_WEIGHT - STEP ? "怎么调都不影响第一名" : `${low.toFixed(1)} – ${high.toFixed(1)} 之间不变`;
  }
}

CRITERIA.forEach((item) => { $("w-" + item.key).oninput = render; });
$("submit").onclick = () => {
  const weights = current(), ranked = ranking(weights);
  const text = `权重：${CRITERIA.map((item) => `${item.label} ${weights[item.key]}`).join("、")}。主持人选 ${ranked[0].label}（${ranked[0].score.toFixed(2)} 分，领先 ${ranked[1].label} ${(ranked[0].score - ranked[1].score).toFixed(2)} 分；得分为主观折算）。`;
  window.codiscuss.submit(text, { weights, ranking: ranked });
};
if (!window.codiscuss?.submit) {
  $("submit").hidden = true;
  $("hint").textContent = "这里不能直接提交，请把四个权重和选择打字回复";
}
render();
</script>
```
````
