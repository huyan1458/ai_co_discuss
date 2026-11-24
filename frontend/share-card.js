/**
 * The share card: one portrait image for chats and social posts, with the room's title, who worked in it, the question,
 * a line of its outcome, the link and a QR code to it. Drawn on a canvas so it can be saved or copied as a picture.
 */
import { encode } from "uqr";
import { t } from "./i18n.js";

// Layout in CSS pixels; the canvas is drawn at SCALE for sharp text on phones.
const WIDTH = 750;
// A data URL is already base64. The signed, encrypted relay request encodes it once more.
const MAX_COVER_DATA_URL_LENGTH = 360 * 1024;
const SCALE = 2;
const PAD = 60;
const INNER = WIDTH - PAD * 2;
// Chinese fonts first: a canvas picks one font per run, and a Latin font first left some characters (量) as boxes.
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", -apple-system, "Segoe UI", sans-serif';
const COLORS = { paper: "#fbf5e9", ink: "#162f30", green: "#206052", bottom: "#183c38", text: "#fff7e7",
  muted: "#c6d8ce", faint: "#bdd0c7", line: "#52736a" };
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

/** Draw the QR code of `url` as dark modules on a white tile at (x, y). */
function draw_qr(context, url, x, y, size) {
  const { data, size: count } = encode(url, { border: 4 });
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
  context.fillStyle = COLORS.paper;
  context.fillRect(0, 0, WIDTH, height);
  let y = PAD;
  context.fillStyle = COLORS.green;
  [16, 28, 22].forEach((bar, index) => {
    round_rect(context, PAD + index * 10, y + 28 - bar, 6, bar, 3);
    context.fill();
  });
  context.font = `600 24px ${FONT}`;
  context.fillText(t("共议 AI CoDiscuss"), PAD + 42, y + 2);
  y += 76;
  context.fillStyle = COLORS.ink;
  context.font = `700 54px ${FONT}`;
  y = draw_lines(context, wrap(context, card.title, INNER, 3), PAD, y, 68) + 18;
  if (card.members.length) {
    context.font = `500 21px ${FONT}`;
    context.fillStyle = COLORS.green;
    y = draw_lines(context, wrap(context, card.members.slice(0, MAX_MEMBERS).join("  ·  "), INNER, 1), PAD, y, 32) + 16;
  }
  context.fillStyle = COLORS.green;
  context.fillRect(PAD, y, INNER, 2);
  y += 36;
  if (card.question) {
    context.font = `400 26px ${FONT}`;
    context.fillStyle = "#475a54";
    y = draw_lines(context, wrap(context, card.question, INNER, 3), PAD, y, 38) + 30;
  }
  if (card.outcome) {
    context.font = `600 21px ${FONT}`;
    context.fillStyle = COLORS.green;
    context.fillText(t("成果"), PAD, y);
    y += 36;
    context.font = `600 34px ${FONT}`;
    context.fillStyle = COLORS.ink;
    y = draw_lines(context, wrap(context, card.outcome, INNER, 6), PAD, y, 49) + 30;
  }
  if (card.stats) {
    context.font = `400 22px ${FONT}`;
    context.fillStyle = COLORS.green;
    context.fillText(card.stats, PAD, y);
    y += 32;
  }
  y += 20;
  return y;
}

/** The live link and expiry belong to the share even when the owner supplies the entire cover. */
function paint_footer(context, card, y) {
  context.textBaseline = "top";
  context.fillStyle = COLORS.bottom;
  context.fillRect(0, y, WIDTH, 36 + QR_SIZE + PAD);
  context.fillStyle = COLORS.line;
  context.fillRect(PAD, y, INNER, 1);
  y += 36;
  draw_qr(context, card.url, PAD, y, QR_SIZE);
  const text_x = PAD + QR_SIZE + 30;
  context.fillStyle = COLORS.text;
  context.font = `600 26px ${FONT}`;
  context.fillText(t("扫码阅读完整协作记录"), text_x, y + 16);
  context.fillStyle = COLORS.muted;
  context.font = `400 19px ${FONT}`;
  context.fillText(new URL(card.url).host, text_x, y + 62);
  context.fillStyle = COLORS.faint;
  context.fillText(card.expires, text_x, y + 96);
  return y + QR_SIZE + PAD;
}

/**
 * Draw `card` ({ title, members: [names], question, outcome, stats, url, expires }) onto `canvas`, sizing it to fit.
 */
export function draw_share_card(canvas, card, cover) {
  // The first pass only measures: sizing the canvas afterwards clears what it drew.
  const cover_height = cover ? Math.round(WIDTH * cover.height / cover.width) : paint(canvas.getContext("2d"), card, 0);
  const height = cover_height + 36 + QR_SIZE + PAD;
  canvas.width = WIDTH * SCALE;
  canvas.height = height * SCALE;
  const context = canvas.getContext("2d");
  context.scale(SCALE, SCALE);
  if (cover) context.drawImage(cover, 0, 0, WIDTH, cover_height);
  else paint(context, card, cover_height);
  paint_footer(context, card, cover_height);
  return canvas;
}

/** Make a self-contained cover that also fits a paired device's 512 KiB relay request. */
export function encode_cover(image, offset = 0) {
  const source_height = Math.min(image.height, image.width * 2);
  const source_top = Math.round((image.height - source_height) * offset);
  const canvas = document.createElement("canvas");
  for (let width = Math.min(WIDTH * SCALE, image.width); width >= 1; width = Math.floor(width * 0.8)) {
    canvas.width = width;
    canvas.height = Math.max(1, Math.round(width * source_height / image.width));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, source_top, image.width, source_height, 0, 0, width, canvas.height);
    const data = canvas.toDataURL("image/webp", 0.9);
    if (data.startsWith("data:image/") && data.length <= MAX_COVER_DATA_URL_LENGTH) return data;
  }
  throw new Error(t("生成分享卡图片失败"));
}

/** The card as a PNG blob. */
export function share_card_blob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t("生成分享卡图片失败")))), "image/png"));
}

/** Build a copyable diagnostic using only allowlisted counters and rendering states. */
export function share_card_diagnostic(draft, render) {
  const card = draft.link?.card;
  const materials = card?.materials ?? draft.materials;
  const publication = card?.publication ?? draft.publication ?? (draft.upload?.revision ? draft.upload : null);
  const summary = { phase: draft.phase };
  if (Number.isInteger(materials?.count)) {
    summary.materials = { count: materials.count, through: Number.isInteger(materials.through) ? materials.through : null };
  }
  if (card && render) {
    summary.preview = { selected: card.cover ? "custom" : "default", stage: render.stage };
    if (render.stage === "drawn") Object.assign(summary.preview, { rendered: render.rendered, width: render.width, height: render.height });
  }
  if (publication || draft.phase === "published") {
    summary.publication = { state: "published" };
    if (/^[\w-]{22}$/.test(publication?.revision ?? "")) summary.publication.revision = publication.revision;
  }
  const total = publication?.total ?? draft.upload?.total;
  const done = publication?.done ?? draft.upload?.done;
  if (Number.isInteger(total)) {
    summary.attachments = { total };
    if (Number.isInteger(done)) summary.attachments.done = done;
    if (draft.phase === "publishing" && (!draft.upload?.step || draft.upload.step === "uploading") && draft.upload) {
      summary.attachments.state = "uploading";
    } else if (Number.isInteger(done) && publication) summary.attachments.state = done === total ? "complete" : "incomplete";
  }
  return summary;
}
