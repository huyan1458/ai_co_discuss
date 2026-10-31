import { cp, mkdir, readdir } from "node:fs/promises";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

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
} : mode === "backup" ? {
  build: {
    outDir: "web", emptyOutDir: false,
    lib: { entry: "frontend/backup.mjs", name: "discuss_backup", formats: ["iife"], fileName: () => "backup.js" },
  },
} : {
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [vue(), ui({
    colorMode: false,
    router: false,
    dts: false,
    autoImport: false,
    ui: { colors: { primary: "emerald", neutral: "zinc" } },
    icon: { clientBundle: { scan: true } },
  })],
  build: {
    outDir: "web",
    emptyOutDir: false,
    lib: { entry: "frontend/main.js", formats: ["es"], fileName: () => "modern.js", cssFileName: "modern" },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
