/** Package the existing backend and built web assets as one Pages deployment. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_PARTS = ["dist", "pages"];

/** Exclude hidden files and source directories in older release snapshots. */
function is_web_asset(web_root, file_path) {
  const parts = relative(web_root, file_path).split(sep);
  return parts[0] !== "modern" && !parts.some((part) => part.startsWith("."));
}

/** Clear only the fixed Pages output under the supplied project directory. */
async function prepare_output(output_root) {
  const root = resolve(output_root);
  const output = resolve(root, ...OUTPUT_PARTS);
  if (relative(root, output) !== join(...OUTPUT_PARTS)) throw new Error("Invalid Pages output path");
  const entry = await lstat(output).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (entry?.isSymbolicLink()) throw new Error("Pages output must not be a symbolic link");
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  return output;
}

/** Copy one backend source and prebuilt assets; an optional snapshot pins a release. */
export async function build_pages(source_root = PROJECT_ROOT, output_root = PROJECT_ROOT) {
  const source = resolve(source_root);
  const web_root = join(source, "web");
  // Older pinned releases keep these two files at the repository root.
  const worker = join(source, existsSync(join(source, "backend", "worker.mjs")) ? "backend/worker.mjs" : "worker.mjs");
  const notices = join(source, existsSync(join(source, "docs", "THIRD_PARTY_NOTICES.md")) ? "docs/THIRD_PARTY_NOTICES.md" : "THIRD_PARTY_NOTICES.md");
  await Promise.all([readFile(worker), readFile(join(web_root, "index.html"))]);
  const output = await prepare_output(output_root);
  await cp(web_root, output, { recursive: true, filter: (file_path) => is_web_asset(web_root, file_path) });
  await cp(join(source, "pages", "public"), output, { recursive: true });
  await cp(join(source, "LICENSE"), join(output, "LICENSE"));
  await cp(notices, join(output, "THIRD_PARTY_NOTICES.md"));
  await cp(worker, join(output, "_worker.js"));
  await stamp_asset_versions(output);
  return output;
}

/** Assets referenced by fixed URLs; scoped Vue styles in modern.css only match the modern.js built with them. */
const VERSIONED_ASSETS = ["modern.css", "modern.js", "markdown.css", "markdown.js", "backup.js", "app.js"];

/**
 * Append a content hash to each fixed asset URL so a browser never pairs a cached stylesheet or script
 * from an older deployment with the current one (iOS Safari did, dropping every changed component's styles).
 */
async function stamp_asset_versions(output) {
  const versions = new Map();
  for (const name of VERSIONED_ASSETS) {
    const content = await readFile(join(output, name)).catch(() => null);
    if (content) versions.set(name, createHash("sha256").update(content).digest("hex").slice(0, 12));
  }
  if (!versions.size) return;
  const pattern = new RegExp(`(["'])/(${[...versions.keys()].map((name) => name.replace(".", "\\.")).join("|")})\\1`, "g");
  // app.js is stamped first so index.html points at its final content; app.js itself loads modern.js.
  for (const name of ["app.js", "index.html"]) {
    const path = join(output, name);
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) continue;
    await writeFile(path, text.replace(pattern, (_match, quote, asset) => `${quote}/${asset}?v=${versions.get(asset)}${quote}`));
    if (name === "app.js" && versions.has("app.js")) {
      versions.set("app.js", createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 12));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = await build_pages(process.argv[2]);
  process.stdout.write(`Pages build: ${output}\n`);
}
