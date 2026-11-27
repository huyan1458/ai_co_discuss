/**
 * Local-only Canvas PNG card for the Analytics report: the promotional half of the page (2026-11-27 rework).
 * It tells the labour story in counts an outsider understands without context — hours the AI team worked, how many
 * experts ran at once, a timeline of that concurrency — and keeps ratios to one supporting line.
 * Draws only aggregate numbers, the date range and the statistical scope: never member names, room titles, folder
 * names or message text.
 */
import { format_ratio, inclusive_date_range } from "./analytics-state.js";
import { t } from "./i18n.js";

const WIDTH = 750;
const SCALE = 2;
const PAD = 56;
const INNER = WIDTH - PAD * 2;
const CHART_HEIGHT = 150;
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", -apple-system, "Segoe UI", sans-serif';
const COLORS = {
  paper: "#fbf5e9",
  ink: "#162f30",
  muted: "#4f625c",
  green: "#206052",
  area_top: "rgba(32, 96, 82, 0.42)",
  area_bottom: "rgba(32, 96, 82, 0.04)",
  rule: "#dfd3bc",
  footer: "#183c38",
  footer_text: "#fff7e7",
  footer_muted: "#c6d8ce",
};

function round_rect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/** Hours as the headline number: whole hours from ten up, one decimal below, so the figure reads at a glance. */
function hours_text(seconds) {
  const hours = (seconds || 0) / 3600;
  return hours >= 10 ? String(Math.round(hours)) : hours.toFixed(1);
}

/** Area chart of experts running at once over the period; the peak is marked with its value. */
function paint_timeline(ctx, series, x, y, width, height) {
  const points = series?.points || [];
  ctx.fillStyle = COLORS.rule;
  ctx.fillRect(x, y + height, width, 1.5);
  if (points.length < 2) return;
  const peak = Math.max(1, ...points);
  const step = width / (points.length - 1);
  const at = (index) => [x + index * step, y + height - (points[index] / peak) * height];
  ctx.beginPath();
  ctx.moveTo(x, y + height);
  points.forEach((_, index) => ctx.lineTo(...at(index)));
  ctx.lineTo(x + width, y + height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, y, 0, y + height);
  gradient.addColorStop(0, COLORS.area_top);
  gradient.addColorStop(1, COLORS.area_bottom);
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  points.forEach((_, index) => (index ? ctx.lineTo(...at(index)) : ctx.moveTo(...at(index))));
  ctx.strokeStyle = COLORS.green;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  const top = points.indexOf(Math.max(...points));
  const [px, py] = at(top);
  ctx.fillStyle = COLORS.green;
  ctx.beginPath();
  ctx.arc(px, py, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `600 18px ${FONT}`;
  ctx.textAlign = px > x + width - 120 ? "right" : "left";
  ctx.fillText(t("{count} 位同时", { count: points[top] }), px + (ctx.textAlign === "right" ? -10 : 10), py - 8);
  ctx.textAlign = "left";
}

/** Paint the card and return its total height; `scope_text` is the page footer sentence, so both agree. */
function paint(ctx, report, heading, scope_text, height) {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, WIDTH, height);
  const overview = report.overview || {};
  const time = report.time || {};

  let y = PAD;
  // Brand mark (same three bars as share-card.js)
  ctx.fillStyle = COLORS.green;
  [16, 28, 22].forEach((bar, index) => {
    round_rect(ctx, PAD + index * 10, y + 28 - bar, 6, bar, 3);
    ctx.fill();
  });
  ctx.font = `600 23px ${FONT}`;
  ctx.fillText(t("共议 AI CoDiscuss"), PAD + 42, y + 2);
  ctx.textAlign = "right";
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 20px ${FONT}`;
  ctx.fillText(`${heading} · ${inclusive_date_range(report.range?.from, report.range?.to)}`, WIDTH - PAD, y + 4);
  ctx.textAlign = "left";
  y += 92;

  // Headline: the hours the AI team worked.
  ctx.fillStyle = COLORS.muted;
  ctx.font = `500 24px ${FONT}`;
  ctx.fillText(t("AI 团队累计为你工作"), PAD, y);
  y += 40;
  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 120px ${FONT}`;
  const hours = hours_text(time.execution_seconds);
  ctx.fillText(hours, PAD - 4, y);
  const hours_width = ctx.measureText(hours).width;
  ctx.font = `700 40px ${FONT}`;
  ctx.fillStyle = COLORS.green;
  ctx.fillText(t("小时"), PAD + hours_width + 10, y + 66);
  y += 142;
  ctx.fillStyle = COLORS.ink;
  ctx.font = `600 26px ${FONT}`;
  ctx.fillText(t("最多 {count} 位 AI 专家同时在跑", { count: time.peak?.members || 0 }), PAD, y, INNER);
  y += 58;

  // Concurrency over the period.
  paint_timeline(ctx, time.concurrency, PAD, y, INNER, CHART_HEIGHT);
  y += CHART_HEIGHT + 14;
  ctx.fillStyle = COLORS.muted;
  ctx.font = `400 17px ${FONT}`;
  ctx.fillText(t("同时在运行的专家数"), PAD, y);
  y += 54;

  // Supporting counts, one line each; the ratio stays a footnote.
  const unassisted = format_ratio(overview.unassisted, overview.ended);
  const facts = [
    [t("发起任务"), t("{count} 个", { count: overview.initiated || 0 })],
    // Delivery time needs explaining to outsiders; rooms pushed at once does not (Fable #14109).
    [t("同时推进"), t("{count} 个房间", { count: time.peak?.rooms || 0 })],
    [t("不用再管"), unassisted.primary],
  ];
  const column = INNER / facts.length;
  facts.forEach(([label, value], index) => {
    const fx = PAD + index * column;
    ctx.fillStyle = COLORS.muted;
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(label, fx, y);
    ctx.fillStyle = COLORS.ink;
    ctx.font = `700 30px ${FONT}`;
    ctx.fillText(value, fx, y + 30, column - 16);
  });
  y += 104;

  // Footer with statistical scope
  const footer_h = 112;
  if (height > 0) {
    ctx.fillStyle = COLORS.footer;
    ctx.fillRect(0, y, WIDTH, footer_h);
    ctx.fillStyle = COLORS.footer_text;
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(scope_text, PAD, y + 28, INNER);
    ctx.fillStyle = COLORS.footer_muted;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText(t("本图在本地生成 · 仅含汇总统计 · codiscuss.com"), PAD, y + 64, INNER);
  }
  return y + footer_h;
}

/** Render the aggregate analytics card onto a canvas element at 2x resolution. */
export function draw_analytics_card(canvas, report, heading, scope_text) {
  const height = paint(canvas.getContext("2d"), report, heading, scope_text, 0);
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  paint(ctx, report, heading, scope_text, height);
  return canvas;
}

/** Export the rendered canvas as a PNG blob. */
export function analytics_card_blob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("生成分享图失败")))), "image/png");
  });
}
