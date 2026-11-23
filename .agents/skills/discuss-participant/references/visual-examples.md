# 交互式可视化示例

写页面前按需读一个，照结构改，不必照抄题材。规则与约束见 [交付交互式可视化](interactive-html.md)。

## 1. 展示：一个量变了，图跟着变

````markdown
年数越长，复利效果越明显：默认 20 年，1000 元变成约 3870 元。

```visual
<style>
.wrap { max-width: 560px; margin: 0 auto; }
.muted { color: var(--codiscuss-text-muted, #6b7280); }
.result { font-size: 1.8em; font-weight: 600; font-variant-numeric: tabular-nums; margin: 0; }
.bar { height: 6px; margin: .8em 0; border-radius: 3px; background: var(--codiscuss-border, #d4d4d8); }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--codiscuss-accent, #2563eb); }
.row { display: flex; gap: 1em; align-items: center; }
.row input { flex: 1; }
</style>
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
```

拖到 40 年约 14975 元：后 20 年多赚的钱，是前 20 年的近 4 倍。
````

## 2. 提问面板：调权重看方案排名

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
.slider input::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: 4px; border-radius: 50%; background: var(--codiscuss-accent, #2563eb); border: 2px solid var(--codiscuss-card, #fff); box-shadow: 0 0 0 1px var(--codiscuss-accent, #2563eb); }
.slider input::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--codiscuss-accent, #2563eb); border: 2px solid var(--codiscuss-card, #fff); box-shadow: 0 0 0 1px var(--codiscuss-accent, #2563eb); }
.slider input:focus-visible { outline: none; }
.slider input:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 1px var(--codiscuss-accent, #2563eb), 0 0 0 5px color-mix(in srgb, var(--codiscuss-accent, #2563eb) 25%, transparent); }
.weight .note { margin-top: .15em; font-size: .78em; color: var(--codiscuss-text-hint, #9ca3af); }
details { margin-top: 1.2em; font-size: .85em; color: var(--codiscuss-text-muted, #6b7280); }
summary { cursor: pointer; width: fit-content; }
table { width: 100%; margin-top: .5em; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: .3em .4em; text-align: left; border-bottom: 1px solid color-mix(in srgb, var(--codiscuss-border, #e5e7eb) 70%, transparent); font-weight: 400; }
th { color: var(--codiscuss-text-hint, #9ca3af); }
.basis { margin: .5em 0 0; line-height: 1.6; }
.foot { display: flex; gap: 1em; align-items: center; justify-content: space-between; flex-wrap: wrap; margin-top: 1.2em; }
.foot .hint { font-size: .82em; color: var(--codiscuss-text-hint, #9ca3af); }
.primary { border-color: var(--codiscuss-accent, #2563eb) !important; background: var(--codiscuss-accent, #2563eb) !important; color: #fff; padding: .4em 1em !important; }
.primary:hover { filter: brightness(1.08); }
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
    <button id="submit" class="primary" type="button">按这组权重交给主持人</button>
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
