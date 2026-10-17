import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";

export default defineConfig(({ mode }) => mode === "markdown" ? {
  build: {
    outDir: "web",
    emptyOutDir: false,
    lib: { entry: "web/modern/markdown-entry.js", name: "discuss_markdown", formats: ["iife"], fileName: () => "markdown.js", cssFileName: "markdown" },
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
    lib: { entry: "web/modern/main.js", formats: ["es"], fileName: () => "modern.js", cssFileName: "modern" },
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
