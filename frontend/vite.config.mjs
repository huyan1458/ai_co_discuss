import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

// Nuxt UI enlarges field text below md (768px) to 14px/16px to prevent iOS focus zoom; web/index.html already locks
// touch zoom, so keep desktop sizes on phones too (Design_UI设计说明.md).
const FIELD_SIZES = { variants: { size: { xs: { base: "text-xs/4" }, sm: { base: "text-xs/4" }, md: { base: "text-sm/5" }, lg: { base: "text-sm/5" } } } };
const FIELD_UI = {
  input: FIELD_SIZES, textarea: FIELD_SIZES, select: FIELD_SIZES, selectMenu: FIELD_SIZES, inputMenu: FIELD_SIZES, inputTags: FIELD_SIZES,
  inputNumber: { variants: { size: { xs: "text-xs/4", sm: "text-xs/4", md: "text-sm/5", lg: "text-sm/5" } } },
};

const VIDEOJS_ELEMENTS = new Set(["video-player", "video-skin", "audio-player", "audio-skin"]);

// The changelog shown from the version number: each language's file, its item prefixes mapped to one set of kinds.
const CHANGELOG_FILES = { en: "../CHANGELOG.md", "zh-CN": "../CHANGELOG.zh-CN.md" };
const CHANGELOG_KINDS = { "新增": "new", "调整": "change", "修复": "fix", New: "new", Changed: "change", Fixed: "fix" };

/** Read the versions of each changelog, newest first: `{ version, date, items: [{ kind, text }] }`. */
function read_changelog() {
  const result = {};
  for (const [language, path] of Object.entries(CHANGELOG_FILES)) {
    const versions = [];
    for (const line of readFileSync(new URL(path, import.meta.url), "utf8").split(/\r?\n/)) {
      const heading = line.match(/^## (\d+\.\d+\.\d+)\s*[（(]([^）)]*)[）)]/);
      if (heading) { versions.push({ version: heading[1], date: heading[2], items: [] }); continue; }
      const item = line.match(/^- ([^：:]+)[：:]\s*(.+)$/);
      if (item && versions.length) versions.at(-1).items.push({ kind: CHANGELOG_KINDS[item[1].trim()] || "change", text: item[2].trim() });
    }
    result[language] = versions;
  }
  return result;
}

/**
 * Video.js loads its 50-odd interface languages lazily, and a single-file build inlines every one of them; the page
 * registers the Chinese pack itself (MediaViewer.vue), so the loader is left with none.
 */
function videojs_single_locale() {
  return { name: "videojs-single-locale", transform(code, id) {
    if (!id.replaceAll("\\", "/").endsWith("@videojs/core/dist/default/core/i18n/load-locale.js")) return null;
    const stripped = code.replace(/const loaders = \{[\s\S]*?\n\};/, "const loaders = {};");
    if (stripped === code) throw new Error("Video.js 语言加载器的写法变了，请更新 videojs_single_locale");
    return stripped;
  } };
}

/** Bundle PDF.js and its fonts/decoders locally so previews do not depend on a CDN. */
function pdf_assets() {
  return { name: "local-pdf-assets", async closeBundle() {
    await mkdir("web/pdfjs", { recursive: true });
    for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs"]) await cp(`node_modules/pdfjs-dist/build/${name}`, `web/pdfjs/${name}`);
    for (const name of ["cmaps", "standard_fonts", "wasm", "iccs", "LICENSE"]) {
      await cp(`node_modules/pdfjs-dist/${name}`, `web/pdfjs/${name}`, { recursive: true });
    }
  } };
}

/**
 * Serve KaTeX's stylesheet and fonts as separate files: library mode would inline every font into markdown.css
 * (1.4 MB for all three formats), while a browser only fetches the woff2 fonts a formula on screen actually uses.
 */
function katex_assets() {
  return { name: "local-katex-assets", async closeBundle() {
    await mkdir("web/katex/fonts", { recursive: true });
    for (const name of ["katex.min.css", "../LICENSE"]) await cp(`node_modules/katex/dist/${name}`, `web/katex/${name.replace("../", "")}`);
    for (const name of await readdir("node_modules/katex/dist/fonts")) {
      if (name.endsWith(".woff2")) await cp(`node_modules/katex/dist/fonts/${name}`, `web/katex/fonts/${name}`);
    }
  } };
}

const JOIN_KEY_PATTERN = /(?<![\w.$])t\(\s*"((?:\\.|[^"\\])*)"/g;

/**
 * The online site's invitation page, /join (Pages serves web/join.html there): one self-contained file with its
 * script, styles and the English entries it uses inlined, so it never pairs with a stale cached asset.
 */
function join_page() {
  return { name: "join-page", async closeBundle() {
    const script = readFileSync(new URL("./join-page.js", import.meta.url), "utf8");
    const english = Object.assign({}, ...readdirSync(new URL("./locales/en/", import.meta.url)).filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(new URL(`./locales/en/${name}`, import.meta.url), "utf8"))));
    const used = Object.fromEntries([...script.matchAll(JOIN_KEY_PATTERN)].map((match) => JSON.parse(`"${match[1]}"`))
      .filter((key) => english[key]).map((key) => [key, english[key]]));
    // Colors follow the site's channel theme (frontend/channel.css): dark by default, light from the system or the
    // site's saved theme (join-page.js sets data-theme).
    const dark = "--bg:#232428;--card:#2b2d31;--text:#d8dce3;--strong:#f2f3f5;--muted:#a6adb7;--border:#42454d;"
      + "--primary:#5865f2;--primary-hover:#6874fa;--ghost-hover:#ffffff0f;--warning:#e5a50a;color-scheme:dark";
    const light = "--bg:#f6f6f6;--card:#fff;--text:#242424;--strong:#171717;--muted:#666;--border:#dedede;"
      + "--primary:#0969da;--primary-hover:#075bbd;--ghost-hover:#0000000a;--warning:#9a6700;color-scheme:light";
    const style = `:root{${dark}}:root[data-theme=light]{${light}}`
      + `@media (prefers-color-scheme:light){:root:not([data-theme]){${light}}}`
      + "body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;-webkit-font-smoothing:antialiased}"
      + "#join-root{box-sizing:border-box;max-width:600px;margin:0 auto;padding:48px 16px}"
      + ".brand{display:flex;align-items:baseline;gap:8px;margin:0 0 16px;padding:0 4px}.brand img{align-self:center;width:24px;height:24px;border-radius:6px}.brand strong{color:var(--strong);font-size:16px}.brand span{color:var(--muted);font-size:12px}"
      + ".card{padding:28px;border:1px solid var(--border);border-radius:12px;background:var(--card)}"
      + "h1{margin:0 0 20px;color:var(--strong);font-size:20px;line-height:1.4;font-weight:600}.empty h1{margin-bottom:8px}.empty p{margin:0}"
      + "dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 20px}dt{color:var(--muted)}dd{margin:0;color:var(--strong);overflow-wrap:anywhere}"
      + ".warning{margin:0 0 16px;color:var(--warning);font-weight:600}"
      + ".notes{margin:0;padding-left:18px;display:grid;gap:4px}"
      + ".fine{margin:12px 0 0;color:var(--muted);font-size:12px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:24px 0 4px}"
      + ".button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 16px;border-radius:6px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;transition:background .12s}"
      + ".primary{border:1px solid transparent;background:var(--primary);color:#fff}.primary:hover{background:var(--primary-hover)}"
      + ".secondary{border:1px solid var(--border);background:transparent;color:var(--text)}.secondary:hover{background:var(--ghost-hover)}"
      + ".button:focus-visible{outline:2px solid var(--primary);outline-offset:2px}"
      + "@media (max-width:480px){#join-root{padding:24px 12px}.card{padding:20px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:8px}.actions .button{flex:1 1 100%}}";
    // The site's own icon (the data URI in web/index.html), reused as the favicon and the brand mark.
    const icon = (readFileSync("web/index.html", "utf8").match(/<link rel="icon" href="(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)">/) || [])[1] || "";
    // "<" is escaped inside the inline script so no dictionary text can close it.
    const dictionary = JSON.stringify(used).replaceAll("<", `${String.fromCharCode(92)}u003c`);
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>AI CoDiscuss</title>
${icon ? `<link rel="icon" href="${icon}">` : ""}
<style>${style}</style>
</head>
<body>
<main id="join-root"></main>
<script>const JOIN_DICTIONARY = ${dictionary};
const JOIN_ICON = ${JSON.stringify(icon)};
${script}</script>
</body>
</html>
`;
    await writeFile("web/join.html", html);
  } };
}

export default defineConfig(({ mode }) => mode === "markdown" ? {
  plugins: [pdf_assets(), katex_assets()],
  build: {
    outDir: "web",
    emptyOutDir: false,
    lib: { entry: "frontend/markdown-entry.js", name: "discuss_markdown", formats: ["iife"], fileName: () => "markdown.js", cssFileName: "markdown" },
  },
} : mode === "office" ? {
  // Office previews are separate modules the page imports on demand from /office/, with their WebAssembly and workers
  // as files beside them, so the page itself stays small.
  base: "/office/",
  build: {
    outDir: "web/office",
    emptyOutDir: true,
    modulePreload: false,
    rolldownOptions: {
      input: { docx: "frontend/office/docx.js", xlsx: "frontend/office/xlsx.js", pptx: "frontend/office/pptx.js" },
      preserveEntrySignatures: "exports-only",
      output: { format: "es", entryFileNames: "[name].js", chunkFileNames: "chunks/[name]-[hash].js", assetFileNames: "assets/[name]-[hash][extname]" },
    },
  },
  worker: { format: "es" },
} : mode === "video" ? {
  // Compressing a video before upload is a module of its own, imported only when a video is attached.
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/video-compress.js", formats: ["es"], fileName: () => "video-compress.js" },
    rolldownOptions: { output: { codeSplitting: false, minify: true, comments: false,
      postBanner: "/*! Includes Mediabunny (MPL-2.0), source at https://github.com/Vanilagy/mediabunny */" } },
  },
} : mode === "admin" ? {
  // The computer owner's management panel (runner/admin_panel.mjs): its own page and bundle, light theme only.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [vue(), ui({ colorMode: false, router: false, dts: false, autoImport: false,
    ui: { colors: { primary: "blue", neutral: "zinc" } }, icon: { clientBundle: { scan: true } } })],
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/admin/main.js", formats: ["es"], fileName: () => "admin.js", cssFileName: "admin" },
    rolldownOptions: { output: { codeSplitting: false, minify: true, comments: false } },
  },
} : mode === "guest" ? {
  // The external user's page on the owner's online site (/guest/, web/guest/index.html): its own small bundle, so a
  // visitor never loads the owner's full page.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [vue(), ui({ colorMode: false, router: false, dts: false, autoImport: false,
    ui: { colors: { primary: "emerald", neutral: "zinc" }, ...FIELD_UI }, icon: { clientBundle: { scan: true } } })],
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/guest/main.js", formats: ["es"], fileName: () => "guest.js", cssFileName: "guest" },
    rolldownOptions: { output: { codeSplitting: false, minify: true, comments: false } },
  },
} : mode === "backup" ? {
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/backup.mjs", name: "discuss_backup", formats: ["iife"], fileName: () => "backup.js" },
  },
} : mode === "i18n" ? {
  // A classic script every page loads first, so web/app.js and the Vue bundles share one copy of the dictionaries.
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/i18n-runtime.js", name: "codiscuss_i18n", formats: ["iife"], fileName: () => "i18n.js" },
  },
} : {
  // The npm package version, shown under the brand; the release script publishes the site and the package together.
  define: { "process.env.NODE_ENV": JSON.stringify("production"),
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version),
    __CHANGELOG__: JSON.stringify(read_changelog()) },
  // The Video.js players are custom elements, which Vue leaves to the browser.
  plugins: [join_page(), videojs_single_locale(), vue({ template: { compilerOptions: { isCustomElement: (tag) => VIDEOJS_ELEMENTS.has(tag) } } }), ui({
    colorMode: false,
    router: false,
    dts: false,
    autoImport: false,
    // Elevated panels are white in the light theme; placeholders need a distinct surface in both themes.
    ui: { colors: { primary: "emerald", neutral: "zinc" }, skeleton: { base: "animate-pulse rounded-md bg-accented" }, ...FIELD_UI },
    // The scan reads only templates by default; icon names chosen in script files (file kinds in file-preview.js and
    // the like) would otherwise load from the Iconify API at run time, which a share page's CSP blocks.
    icon: { clientBundle: { scan: { globInclude: ["**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}", "frontend/**/*.{js,mjs}"] } } },
  })],
  build: {
    outDir: "web",
    emptyOutDir: false,
    lib: { entry: "frontend/main.js", formats: ["es"], fileName: () => "modern.js", cssFileName: "modern" },
    // Library mode keeps whitespace and pure annotations in ES output for downstream tree shaking; this bundle is the
    // page itself, so minify it fully (a quarter of the bytes the browser must download and parse).
    rolldownOptions: { output: { codeSplitting: false, minify: true, comments: false } },
  },
});
