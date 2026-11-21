/**
 * The share card: one portrait image for chats and social posts, with the room's title, who worked in it, the question,
 * a line of its outcome, the link and a QR code to it. Drawn on a canvas so it can be saved or copied as a picture.
 */
import { encode } from "uqr";
import { t } from "./i18n.js";

// Layout in CSS pixels; the canvas is drawn at SCALE for sharp text on phones.
const WIDTH = 750;
const SCALE = 2;
const PAD = 60;
const INNER = WIDTH - PAD * 2;
// Chinese fonts first: a canvas picks one font per run, and a Latin font first left some characters (量) as boxes.
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", -apple-system, "Segoe UI", sans-serif';
const COLORS = { top: "#12141c", bottom: "#1b1f2e", text: "#f1f3f8", body: "#d5d9e3", muted: "#949cad", faint: "#6a7283", accent: "#8791ff",
  glow: "#8791ff", warm: "#d97757", line: "#ffffff14", chip: "#ffffff10", panel: "#8791ff17", panel_edge: "#8791ff3d" };
const MEMBER_COLORS = ["#d97757", "#8791ff", "#4fb286", "#e0a83b", "#c46fd1", "#4aa3d8"];
const QR_SIZE = 152;
const MAX_MEMBERS = 6;
const CLOSING_PUNCTUATION = "，。、；：！？）》」』”’,.;:!?)";

/** Lines of `text` that fit `width` at the context's font, at most `max` of them, the last ending in "…" when cut. */
function wrap(context, text, width, max) {
  const lines = [];
  let line = "";
  for (const char of String(text || "").replace(/\s+/g, " ").trim()) {
    // Closing punctuation stays at the end of its line rather than opening the next one.
    if (context.measureText(line + char).width > width && line && !CLOSING_PUNCTUATION.includes(char)) {
      lines.push(line);
      line = char.trim();
      if (lines.length === max) break;
    } else line += char;
  }
  if (lines.length < max && line) lines.push(line);
  else if (lines.length === max && line) lines[max - 1] = `${lines[max - 1].slice(0, -1)}…`;
  return lines;
}

/** Draw lines from `y`, returning the y after them. */
function draw_lines(context, lines, x, y, height) {
  for (const line of lines) { context.fillText(line, x, y); y += height; }
  return y;
}

/** A rounded rectangle path. */
function round_rect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

/** A soft round light centred at (x, y), fading out at `radius`. */
function glow(context, x, y, radius, color, strength) {
  const light = context.createRadialGradient(x, y, 0, x, y, radius);
  light.addColorStop(0, `${color}${strength}`);
  light.addColorStop(1, `${color}00`);
  context.fillStyle = light;
  context.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

/** Draw the QR code of `url` as dark modules on a white tile at (x, y). */
function draw_qr(context, url, x, y, size) {
  const { data, size: count } = encode(url, { border: 1 });
  context.fillStyle = "#ffffff";
  round_rect(context, x, y, size, size, 14);
  context.fill();
  const cell = (size - 16) / count;
  context.fillStyle = "#12141c";
  data.forEach((row, r) => row.forEach((dark, c) => { if (dark) context.fillRect(x + 8 + c * cell, y + 8 + r * cell, Math.ceil(cell), Math.ceil(cell)); }));
}

/** Paint the whole card from the top and return its height; painting twice (measure, then draw) keeps one layout. */
function paint(context, card, height) {
  context.textBaseline = "top";
  context.textAlign = "left";
  const background = context.createLinearGradient(0, 0, WIDTH * 0.4, height);
  background.addColorStop(0, COLORS.top);
  background.addColorStop(1, COLORS.bottom);
  context.fillStyle = background;
  context.fillRect(0, 0, WIDTH, height);
  glow(context, WIDTH - 40, 20, 460, COLORS.glow, "3d");
  glow(context, 0, height, 380, COLORS.warm, "1c");

  let y = PAD;
  // Brand: the three bars and the name, the tagline at the right.
  [16, 28, 22].forEach((bar, index) => { context.fillStyle = COLORS.accent; round_rect(context, PAD + index * 10, y + 28 - bar, 6, bar, 3); context.fill(); });
  context.fillStyle = COLORS.text;
  context.font = `600 24px ${FONT}`;
  context.fillText(t("共议 AI CoDiscuss"), PAD + 42, y + 2);
  context.fillStyle = COLORS.muted;
  context.font = `400 19px ${FONT}`;
  context.textAlign = "right";
  context.fillText(t("多个 AI 在同一个房间协作"), WIDTH - PAD, y + 6);
  context.textAlign = "left";
  y += 30 + 56;

  context.fillStyle = COLORS.text;
  context.font = `700 46px ${FONT}`;
  y = draw_lines(context, wrap(context, card.title, INNER, 2), PAD, y, 62) + 18;

  // Members as chips, each with its own colour.
  context.font = `500 21px ${FONT}`;
  let x = PAD;
  for (const [index, name] of card.members.slice(0, MAX_MEMBERS).entries()) {
    const width = Math.min(context.measureText(name).width, 180) + 44;
    if (x + width > WIDTH - PAD) break;
    context.fillStyle = COLORS.chip;
    round_rect(context, x, y, width, 40, 20);
    context.fill();
    context.fillStyle = MEMBER_COLORS[index % MEMBER_COLORS.length];
    context.beginPath();
    context.arc(x + 19, y + 20, 5, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = COLORS.body;
    context.fillText(wrap(context, name, 180, 1)[0] || "", x + 32, y + 9);
    x += width + 10;
  }
  y += 40 + 44;

  /** A small label over a block of text. */
  const label = (text) => {
    context.fillStyle = COLORS.accent;
    context.font = `600 19px ${FONT}`;
    context.fillText(text, PAD, y);
    y += 36;
  };
  // The question reads as a quote: an accent rule at its left, no box.
  context.font = `400 27px ${FONT}`;
  const question = card.question ? wrap(context, card.question, INNER - 26, 3) : [];
  if (question.length) {
    label(t("问题"));
    context.fillStyle = COLORS.accent;
    round_rect(context, PAD, y + 4, 4, question.length * 42 - 12, 2);
    context.fill();
    context.fillStyle = COLORS.body;
    context.font = `400 27px ${FONT}`;
    y = draw_lines(context, question, PAD + 26, y, 42) + 34;
  }
  // The outcome is what the card is for: the one tinted panel on it.
  context.font = `500 27px ${FONT}`;
  const outcome = card.outcome ? wrap(context, card.outcome, INNER - 56, 5) : [];
  if (outcome.length) {
    label(t("成果"));
    const box = outcome.length * 42 + 44;
    context.fillStyle = COLORS.panel;
    round_rect(context, PAD, y, INNER, box, 18);
    context.fill();
    context.strokeStyle = COLORS.panel_edge;
    context.lineWidth = 1;
    round_rect(context, PAD + 0.5, y + 0.5, INNER - 1, box - 1, 18);
    context.stroke();
    context.fillStyle = COLORS.text;
    context.font = `500 27px ${FONT}`;
    draw_lines(context, outcome, PAD + 28, y + 24, 42);
    y += box + 30;
  }

  context.fillStyle = COLORS.muted;
  context.font = `400 20px ${FONT}`;
  context.fillText(card.stats, PAD, y);
  y += 28 + 30;

  // The way in: a rule, then the code with the link beside it.
  context.fillStyle = COLORS.line;
  context.fillRect(PAD, y, INNER, 1);
  y += 36;
  draw_qr(context, card.url, PAD, y, QR_SIZE);
  const text_x = PAD + QR_SIZE + 30, text_width = WIDTH - PAD - text_x;
  context.fillStyle = COLORS.text;
  context.font = `600 26px ${FONT}`;
  context.fillText(t("扫码阅读完整协作记录"), text_x, y + 16);
  context.fillStyle = COLORS.muted;
  context.font = `400 19px ${FONT}`;
  const link_y = draw_lines(context, wrap(context, card.url.replace(/^https?:\/\//, ""), text_width, 2), text_x, y + 62, 27);
  context.fillStyle = COLORS.faint;
  context.fillText(card.expires, text_x, link_y + 10);
  return y + QR_SIZE + PAD;
}

/**
 * Draw `card` ({ title, members: [names], question, outcome, stats, url, expires }) onto `canvas`, sizing it to fit.
 */
export function draw_share_card(canvas, card) {
  // The first pass only measures: sizing the canvas afterwards clears what it drew.
  const height = paint(canvas.getContext("2d"), card, 0);
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  const context = canvas.getContext("2d");
  context.scale(SCALE, SCALE);
  paint(context, card, height);
  return canvas;
}

/** The card as a PNG blob. */
export function share_card_blob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("生成分享卡图片失败")))), "image/png"));
}
