/** Package the existing backend and built web assets as one Pages deployment. */
import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_PARTS = ["dist", "pages"];

/** Include deployable web assets without source components or hidden files. */
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
  await Promise.all([readFile(join(source, "worker.mjs")), readFile(join(web_root, "index.html"))]);
  const output = await prepare_output(output_root);
  await cp(web_root, output, { recursive: true, filter: (file_path) => is_web_asset(web_root, file_path) });
  await cp(join(source, "pages", "public"), output, { recursive: true });
  await cp(join(source, "LICENSE"), join(output, "LICENSE"));
  await cp(join(source, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));
  await cp(join(source, "worker.mjs"), join(output, "_worker.js"));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = await build_pages(process.argv[2]);
  process.stdout.write(`Pages build: ${output}\n`);
}
