/**
 * List interface strings passed to t() that have no English entry, and English entries no source uses any more.
 * Usage: node scripts/check_locales.mjs [--strict]   (--strict exits 1 when anything is missing)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIRS = ["frontend"];
const SOURCE_FILES = ["web/app.js", "runner/relay_health_text.mjs"];
const SOURCE_PATTERN = /\.(vue|js|mjs)$/;
const SKIP_DIRS = new Set(["locales", "node_modules"]);
const SKIP_FILES = new Set(["i18n-runtime.js", "i18n.js"]);
// t("…") / t('…') with a plain literal; template literals with ${} cannot be dictionary keys.
const CALL_PATTERN = /(?<![\w.$])t\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
// Backend user-facing text: Text("…") in backend/*.py, shown by the page through frontend/locales/en/backend.json.
const BACKEND_DIR = "backend";
const BACKEND_PATTERN = /(?<![\w.])Text\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1/g;
const BACKEND_JS_FILES = ["backend/worker.mjs", "backend/entry_worker.mjs", "runner/admin_panel.mjs", "runner/free_runner.mjs", "runner/adapters/api_pi.mjs", "runner/scheduler.mjs", "runner/session_driver.mjs"];
const BACKEND_JS_PATTERN = /(?<![\w.])(?:new HttpError\([^,\n]+,|panel_error\(|entry_error\(|room_text\()\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function source_files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : source_files(path);
    return SOURCE_PATTERN.test(entry.name) && !SKIP_FILES.has(entry.name) ? [path] : [];
  });
}

function unescape(text) {
  return text.replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}

function load_dictionary(language) {
  const dir = join(ROOT, "frontend", "locales", language);
  return Object.assign({}, ...readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8"))));
}

const used = new Map();
const files = [...SOURCE_DIRS.flatMap((dir) => source_files(join(ROOT, dir))), ...SOURCE_FILES.map((file) => join(ROOT, file))];
for (const file of files) {
  for (const match of readFileSync(file, "utf8").matchAll(CALL_PATTERN)) {
    if (match[1] === "`" && match[2].includes("${")) continue;
    const key = unescape(match[2]);
    if (!used.has(key)) used.set(key, relative(ROOT, file));
  }
}

for (const name of readdirSync(join(ROOT, BACKEND_DIR)).filter((entry) => entry.endsWith(".py"))) {
  const file = join(ROOT, BACKEND_DIR, name);
  for (const match of readFileSync(file, "utf8").matchAll(BACKEND_PATTERN)) {
    const key = unescape(match[2]);
    if (!used.has(key)) used.set(key, relative(ROOT, file));
  }
}

const english = load_dictionary("en");
for (const name of BACKEND_JS_FILES) {
  for (const match of readFileSync(join(ROOT, name), "utf8").matchAll(BACKEND_JS_PATTERN)) {
    const key = unescape(match[2]);
    if (!used.has(key)) used.set(key, name);
  }
}
const missing = [...used].filter(([key]) => !english[key]);
const unused = Object.keys(english).filter((key) => !used.has(key));
for (const [key, file] of missing) console.log(`missing  ${file}  ${JSON.stringify(key)}`);
for (const key of unused) console.log(`unused   ${JSON.stringify(key)}`);
console.log(`${used.size} strings, ${missing.length} missing English, ${unused.length} unused English entries`);
if (process.argv.includes("--strict") && missing.length) process.exit(1);
