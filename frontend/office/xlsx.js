/**
 * Excel (.xlsx, .xls, .ods) preview, loaded only when one is opened: SheetJS Community Edition (Apache-2.0) reads the
 * values and merged cells of each sheet as an HTML table. The community edition reads no cell styles or charts.
 */
import { read, utils } from "xlsx";

// Rows read per sheet; a larger sheet is cut so the page stays responsive.
const MAX_ROWS = 5000;

/** Every sheet of the workbook in `data` (ArrayBuffer) as `{ name, html, cut }`; `html` is SheetJS's escaped table. */
export function workbook_sheets(data) {
  const workbook = read(data, { type: "array", sheetRows: MAX_ROWS + 1, cellHTML: false, cellStyles: false });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const rows = sheet["!ref"] ? utils.decode_range(sheet["!ref"]).e.r + 1 : 0;
    return { name, html: utils.sheet_to_html(sheet, { header: "", footer: "", editable: false }), cut: rows > MAX_ROWS };
  });
}

// The same built module is the worker entry; importing it in tests still exposes the pure parser.
if (typeof document === "undefined" && typeof self !== "undefined") {
  self.onmessage = ({ data }) => {
    try { self.postMessage({ sheets: workbook_sheets(data) }); }
    catch (error) { self.postMessage({ error: error.message || String(error) }); }
  };
}
