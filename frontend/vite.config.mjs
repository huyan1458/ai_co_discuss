import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, writeFile } from "node:fs/promises";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

const VIDEOJS_ELEMENTS = new Set(["video-player", "video-skin", "audio-player", "audio-skin"]);

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
    const style = "body{margin:0;background:#121416;color:#e6e8ea;font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif}"
      + "@media (prefers-color-scheme:light){body{background:#fff;color:#1b1d1f}}"
      + "#join-root{max-width:560px;margin:0 auto;padding:40px 16px}h1{font-size:22px;line-height:1.35;margin:0 0 20px}"
      + "dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 20px}dt{opacity:.65}dd{margin:0;overflow-wrap:anywhere}"
      + ".note{margin:0 0 8px}.fine{margin:8px 0 0;font-size:13px;opacity:.65}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0 8px}"
      + ".actions a,.actions button{display:inline-flex;align-items:center;min-height:40px;padding:0 16px;border-radius:8px;font:inherit;text-decoration:none;cursor:pointer}"
      + ".primary{background:#10b981;color:#fff;border:0}.secondary{background:transparent;color:inherit;border:1px solid currentColor}";
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
<style>${style}</style>
</head>
<body>
<main id="join-root"></main>
<script>const JOIN_DICTIONARY = ${dictionary};
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
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version) },
  // The Video.js players are custom elements, which Vue leaves to the browser.
  plugins: [join_page(), videojs_single_locale(), vue({ template: { compilerOptions: { isCustomElement: (tag) => VIDEOJS_ELEMENTS.has(tag) } } }), ui({
    colorMode: false,
    router: false,
    dts: false,
    autoImport: false,
    // Elevated panels are white in the light theme; placeholders need a distinct surface in both themes.
    ui: { colors: { primary: "emerald", neutral: "zinc" }, skeleton: { base: "animate-pulse rounded-md bg-accented" } },
    icon: { clientBundle: { scan: true } },
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
