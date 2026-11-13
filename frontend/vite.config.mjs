import { readFileSync } from "node:fs";
import { cp, mkdir, readdir } from "node:fs/promises";

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
} : {
  // The npm package version, shown under the brand; the release script publishes the site and the package together.
  define: { "process.env.NODE_ENV": JSON.stringify("production"),
    __APP_VERSION__: JSON.stringify(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version) },
  // The Video.js players are custom elements, which Vue leaves to the browser.
  plugins: [videojs_single_locale(), vue({ template: { compilerOptions: { isCustomElement: (tag) => VIDEOJS_ELEMENTS.has(tag) } } }), ui({
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
