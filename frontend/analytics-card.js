/**
 * Local-only Canvas PNG card for the Analytics report.
 * Draws only aggregate summary numbers, date range and statistical scope:
 * never member names, room titles, folder names or message text.
 */
import { format_duration, format_ratio, inclusive_date_range } from "./analytics-state.js";
import { t } from "./i18n.js";

const WIDTH = 750;
const SCALE = 2;
const PAD = 56;
const INNER = WIDTH - PAD * 2;
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", -apple-system, "Segoe UI", sans-serif';
const COLORS = {
  paper: "#fbf5e9",
  card: "#f3ead8",
  card_border: "#dfd3bc",
  ink: "#162f30",
  muted: "#4f625c",
  green: "#206052",
  footer: "#183c38",
  footer_text: "#fff7e7",
  footer_muted: "#c6d8ce",
  line: "#52736a",
};

function round_rect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

/** Paint a 2x2 summary grid card and return total height; `scope_text` is the page footer sentence, so both agree. */
function paint(ctx, report, heading, scope_text, height) {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, WIDTH, height);

  let y = PAD;
  // Brand mark (same three bars as share-card.js)
  ctx.fillStyle = COLORS.green;
  [16, 28, 22].forEach((bar, index) => {
    round_rect(ctx, PAD + index * 10, y + 28 - bar, 6, bar, 3);
    ctx.fill();
  });
  ctx.font = `600 23px ${FONT}`;
  ctx.fillText(t("共议 AI CoDiscuss"), PAD + 42, y + 2);
  y += 66;

  // Report title + inclusive date range
  ctx.fillStyle = COLORS.ink;
  ctx.font = `700 46px ${FONT}`;
  ctx.fillText(heading, PAD, y);
  y += 62;

  const range_text = inclusive_date_range(report.range?.from, report.range?.to);
  ctx.fillStyle = COLORS.green;
  ctx.font = `500 22px ${FONT}`;
  ctx.fillText(`${range_text}  ·  ${report.range?.tz || "UTC"}`, PAD, y);
  y += 42;

  ctx.fillStyle = COLORS.green;
  ctx.fillRect(PAD, y, INNER, 2);
  y += 32;

  // Four aggregate summary tiles (strictly no member names, room titles, or folder names)
  const overview = report.overview || {};
  const unassisted = format_ratio(overview.unassisted, overview.ended);
  const peak = report.time?.peak || {};

  const tiles = [
    {
      label: t("免介入率"),
      value: unassisted.primary,
      sub: overview.ended > 0
        ? t("{total} 个已结束任务中 {count} 个没再插手", { count: overview.unassisted || 0, total: overview.ended || 0 })
        : t("这段时间还没有已结束的任务"),
    },
    {
      label: t("发起"),
      value: t("{count} 次", { count: overview.initiated || 0 }),
      sub: t("其中 {count} 次已获回复", { count: overview.answered || 0 }),
    },
    {
      label: t("同时运行的专家"),
      value: t("{count} 位", { count: Number(peak.members || 0) }),
      sub: t("最多同时推进 {count} 个房间", { count: Number(peak.rooms || 0) }),
    },
    {
      label: t("AI 执行总时长"),
      value: format_duration(report.time?.execution_seconds || 0),
      sub: t("各成员执行时长相加"),
    },
  ];

  const gap = 20;
  const tile_w = (INNER - gap) / 2;
  const tile_h = 166;
  tiles.forEach((tile, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const tx = PAD + col * (tile_w + gap);
    const ty = y + row * (tile_h + gap);

    ctx.fillStyle = COLORS.card;
    round_rect(ctx, tx, ty, tile_w, tile_h, 16);
    ctx.fill();
    ctx.strokeStyle = COLORS.card_border;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = COLORS.green;
    ctx.font = `600 20px ${FONT}`;
    ctx.fillText(tile.label, tx + 24, ty + 24);

    ctx.fillStyle = COLORS.ink;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillText(tile.value, tx + 24, ty + 62, tile_w - 48);

    ctx.fillStyle = COLORS.muted;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText(tile.sub, tx + 24, ty + 122, tile_w - 48);
  });

  y += tile_h * 2 + gap + 36;

  // Footer with statistical scope
  const footer_h = 112;
  if (height > 0) {
    ctx.fillStyle = COLORS.footer;
    ctx.fillRect(0, y, WIDTH, footer_h);
    ctx.fillStyle = COLORS.line;
    ctx.fillRect(PAD, y, INNER, 1);

    ctx.fillStyle = COLORS.footer_text;
    ctx.font = `500 20px ${FONT}`;
    ctx.fillText(scope_text, PAD, y + 28, INNER);

    ctx.fillStyle = COLORS.footer_muted;
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText(t("本图在本地生成 · 仅含汇总统计 · codiscuss.com"), PAD, y + 64, INNER);
  }
  return y + footer_h;
}

/** Render the aggregate analytics report card onto a canvas element at 2x resolution. */
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
