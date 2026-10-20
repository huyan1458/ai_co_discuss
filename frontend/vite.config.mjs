import { cp, mkdir } from "node:fs/promises";

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

export default defineConfig(({ mode }) => mode === "markdown" ? {
  plugins: [pdf_assets()],
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
