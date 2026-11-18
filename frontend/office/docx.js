/**
 * Word (.docx) preview, loaded only when one is opened: docx-preview (Apache-2.0) lays the document out as pages of
 * HTML. The caller passes a container inside a sandboxed frame without scripts, so nothing in the file can run.
 * The parsed document is corrected before it is drawn, for the Word layout rules docx-preview drops.
 */
import { parseAsync, renderDocument } from "docx-preview";

const OPTIONS = { inWrapper: true, breakPages: true, ignoreLastRenderedPageBreak: true,
  renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, renderComments: false,
  renderChanges: false, useBase64URL: true, experimental: false, keepOrigin: true };
// Word's "single" spacing follows the font's own height, about this many times its size for Chinese text.
const AUTO_LINE_FACTOR = 1.25;
// docx-preview writes automatic line spacing as a bare multiple such as "1.00".
const AUTO_LINE_VALUE = /^\d+\.\d{2}$/;
// Word border widths are in eighths of a point.
const BORDER_UNITS_PER_POINT = 8;
const DEFAULT_BORDER_UNITS = 4;
const BORDER_STYLES = { double: "double", dashed: "dashed", dotted: "dotted" };
const PADDING_SIDES = { top: "padding-top", bottom: "padding-bottom", left: "padding-left", right: "padding-right" };
// Phones enlarge text they judge too small, which breaks a page laid out at fixed line heights.
const FRAME_STYLE = "html,body{-webkit-text-size-adjust:100%;text-size-adjust:100%}";

const child = (node, name) => [...(node?.children || [])].find(item => item.localName === name);
const children = (node, name) => [...(node?.children || [])].filter(item => item.localName === name);
const attribute = (node, name) => node?.getAttributeNS(node.namespaceURI, name) ?? null;

/** The block elements under `parent`, in the same order docx-preview parses them. */
function raw_blocks(parent) {
  return [...parent.children].flatMap((item) => {
    if (item.localName === "sdt") return raw_blocks(child(item, "sdtContent") || { children: [] });
    return ["p", "tbl", "altChunk"].includes(item.localName) ? [item] : [];
  });
}

/** One Word border element as a CSS border. */
function css_border(border) {
  const type = attribute(border, "val");
  if (!type || type === "none" || type === "nil") return "none";
  const color = attribute(border, "color");
  const width = Number(attribute(border, "sz") || DEFAULT_BORDER_UNITS) / BORDER_UNITS_PER_POINT;
  return `${width}pt ${BORDER_STYLES[type] || "solid"} ${!color || color === "auto" ? "#000" : `#${color}`}`;
}

/** Keep the gap Word leaves between a paragraph's text and its borders. */
function apply_border_gap(paragraph_props, values) {
  const borders = child(paragraph_props, "pBdr");
  for (const [side, property] of Object.entries(PADDING_SIDES)) {
    const space = attribute(child(borders, side), "space");
    if (space) values[property] = `${space}pt`;
  }
}

/** Give each cell the table's outer borders on the table's edge and its inner borders everywhere else. */
function apply_table_borders(raw_table, table) {
  const borders = child(child(raw_table, "tblPr"), "tblBorders");
  if (!borders) return;
  const edge = (...names) => {
    const border = names.map(name => child(borders, name)).find(Boolean);
    return border ? css_border(border) : "none";
  };
  const rows = children(raw_table, "tr");
  rows.forEach((raw_row, row_index) => {
    const cells = children(raw_row, "tc");
    cells.forEach((raw_cell, cell_index) => {
      const own = child(child(raw_cell, "tcPr"), "tcBorders");
      const sides = {
        top: row_index === 0 ? edge("top") : edge("insideH"),
        bottom: row_index === rows.length - 1 ? edge("bottom") : edge("insideH"),
        left: cell_index === 0 ? edge("left", "start") : edge("insideV"),
        right: cell_index === cells.length - 1 ? edge("right", "end") : edge("insideV"),
      };
      const cell = table.children[row_index].children[cell_index];
      cell.cssStyle ||= {};
      for (const [side, value] of Object.entries(sides)) {
        if (!child(own, side)) cell.cssStyle[`border-${side}`] = value;
      }
    });
  });
}

/** Whether the parsed table has the same rows and cells as its XML. */
function same_table_shape(raw_table, table) {
  const rows = children(raw_table, "tr");
  return rows.length === table.children?.length
    && rows.every((row, index) => children(row, "tc").length === table.children[index].children?.length);
}

/** Walk the XML and the parsed blocks side by side; a part that does not line up keeps docx-preview's own result. */
function correct_blocks(raw_parent, blocks) {
  const raw = raw_blocks(raw_parent);
  if (raw.length !== blocks.length) return;
  raw.forEach((item, index) => {
    const block = blocks[index];
    if (item.localName === "p") {
      block.cssStyle ||= {};
      apply_border_gap(child(item, "pPr"), block.cssStyle);
    } else if (item.localName === "tbl" && same_table_shape(item, block)) {
      apply_table_borders(item, block);
      children(item, "tr").forEach((row, row_index) => children(row, "tc").forEach((cell, cell_index) => {
        correct_blocks(cell, block.children[row_index].children[cell_index].children || []);
      }));
    }
  });
}

/** Scale automatic line spacing so Chinese lines are as far apart as they are in Word. */
function loosen_line_height(values) {
  const line = values?.["line-height"];
  if (AUTO_LINE_VALUE.test(line || "")) values["line-height"] = (Number(line) * AUTO_LINE_FACTOR).toFixed(2);
}

function loosen_paragraphs(element) {
  if (element.type === "paragraph") loosen_line_height(element.cssStyle);
  element.children?.forEach(loosen_paragraphs);
}

/** Apply the paragraph corrections carried by the document's named styles. */
function correct_styles(document) {
  const raw_styles = document.stylesPart?._xmlDocument?.documentElement;
  const by_id = new Map(children(raw_styles, "style").map(style => [attribute(style, "styleId"), style]));
  for (const style of document.stylesPart?.styles || []) {
    for (const entry of style.styles) {
      if (entry.target !== "p") continue;
      loosen_line_height(entry.values);
      apply_border_gap(child(by_id.get(style.id), "pPr"), entry.values);
    }
  }
}

/** Correct the parsed document in place before it is drawn. */
function correct_document(document) {
  correct_styles(document);
  const body = document.documentPart?.body;
  if (!body) return;
  loosen_paragraphs(body);
  const raw_body = child(document.documentPart._xmlDocument?.documentElement, "body");
  if (raw_body) correct_blocks(raw_body, body.children || []);
}

/** Render `data` (ArrayBuffer) into `body`, with its styles in `styles`; comments and tracked changes stay hidden. */
export async function render_docx(data, body, styles) {
  const parsed = await parseAsync(data, OPTIONS);
  correct_document(parsed);
  const nodes = await renderDocument(parsed, OPTIONS);
  styles.innerHTML = "";
  body.innerHTML = "";
  for (const node of nodes) (node.nodeName === "STYLE" ? styles : body).appendChild(node);
  const frame_style = body.ownerDocument.createElement("style");
  frame_style.textContent = FRAME_STYLE;
  styles.append(frame_style);
}
