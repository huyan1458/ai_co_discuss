/**
 * Project file tools of a model API member: read, glob and grep, and at 可写 also write and edit.
 *
 * Ported from the read / write / edit (packages/fs/tool-fs) and glob / grep (packages/fs/tool-fs-search) tools of
 * DeepSeek Harness, https://github.com/deepseek-ai/deepseek-harness at ce7073d, MIT License, Copyright (c) 2026 DeepSeek:
 * the same tool names, parameters, descriptions, result formats, limits and read-before-modify rule, rebuilt on Node
 * built-ins. Differences: every path stays inside the room's project directories (the main one, where relative paths
 * resolve, and the extra ones by absolute path, each read-only or writable); grep takes JavaScript regular
 * expressions and reads the files Git does not ignore, where DSH runs ripgrep; secrets, version-control metadata and the
 * runner's private files are refused; a result over the cap is cut instead of saved to a spill file.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const LINE_ENDING_SAMPLE = 4096;
const GLOB_MAX_RESULTS = 100;
const GREP_MAX_MATCHES = 250;
const GREP_MAX_LINE_LENGTH = 2000;
const MAX_WALK_ENTRIES = 100_000;
const GIT_TIMEOUT_MS = 15_000;
const VCS_DIRECTORIES = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
// Their content would reach the model provider and could be posted into the room, which has no read isolation.
const SECRET_NAMES = [/^\.env(\..+)?$/i, /\.(pem|key|p12|pfx|jks|keystore)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.(npmrc|pypirc|netrc)$/i];
const SECRET_EXAMPLES = /^\.env\.(example|sample|template)$/i;
const READ_TOOLS = ['read', 'glob', 'grep'];
export const WRITE_TOOLS = ['write', 'edit'];
const TEXT = { type: 'string' };
const NUMBER = { type: 'integer', minimum: 1 };

/** Describe a file tool with an explicit input schema. */
function tool(name, description, properties, required) {
  return { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

const DEFINITIONS = {
  read: tool('read', 'Read a UTF-8 text file and return line-numbered content.', {
    file_path: { ...TEXT, description: 'Path to read, relative to the project directory, or absolute inside another listed project directory.' },
    offset: { ...NUMBER, description: '1-based first line to return. Defaults to 1.' },
    limit: { ...NUMBER, maximum: READ_LIMIT, description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
  }, ['file_path']),
  glob: tool('glob', 'Find files, not directories, whose paths match a glob pattern, including hidden and ignored files. '
    + `Returns up to ${GLOB_MAX_RESULTS} paths in modification-time order; a larger result keeps the first paths.`, {
    pattern: { ...TEXT, description: 'Glob pattern to match file paths against (e.g. "**/*.ts", "src/**/*.test.js"). '
      + 'A pattern with no "/" matches the basename at any depth, so "*" and "*.ts" both search the whole tree; include a separator to anchor the depth.' },
    path: { ...TEXT, description: 'Directory to search in. Defaults to the project directory; a relative path resolves against it, an absolute one may name another listed project directory.' },
  }, ['pattern']),
  grep: tool('grep', 'Search file contents with a JavaScript regular expression. Returns matching lines with line numbers, grouped by file. '
    + `Returns up to ${GREP_MAX_MATCHES} matches.`, {
    pattern: { ...TEXT, description: 'Regular expression to search for (JavaScript syntax).' },
    path: { ...TEXT, description: 'File or directory to search. Defaults to the project directory; a relative path resolves against it, an absolute one may name another listed project directory.' },
    include: { ...TEXT, description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}"). Not a list; negation is not supported.' },
  }, ['pattern']),
  write: tool('write', 'Create or fully replace a UTF-8 text file.', {
    file_path: { ...TEXT, description: 'Path to write, relative to the project directory, or absolute inside another listed project directory. Provide `file_path` before `content` in the arguments.' },
    content: { ...TEXT, description: 'Full UTF-8 text content to write.' },
  }, ['file_path', 'content']),
  edit: tool('edit', 'Edit an existing UTF-8 text file by replacing literal text.', {
    file_path: { ...TEXT, description: 'Path to edit, relative to the project directory, or absolute inside another listed project directory. Provide `file_path` before `old_string` and `new_string` in the arguments.' },
    old_string: { ...TEXT, description: 'Literal text to replace.' },
    new_string: { ...TEXT, description: 'Literal replacement text. Use an empty string to delete the match.' },
    replace_all: { type: 'boolean', description: 'Replace all matches. Defaults to false; when false, old_string must appear exactly once.' },
  }, ['file_path', 'old_string', 'new_string']),
};

/** Whether `path` is `root` or lies under it; Windows paths compare without case. */
function inside(root, path) {
  const rest = relative(root, path);
  return rest === '' || (!rest.startsWith('..') && !isAbsolute(rest));
}

/** The real path of a file that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
function real_path(path) {
  try { return realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(real_path(dirname(path)), basename(path));
  }
}

/**
 * The project an API member may work in, or null when the room names none. Without its own directory (it joined before
 * the room had a project), the first of the room's directories is where relative paths resolve.
 * @param {{cwd?: string, project_access?: string, extra_directories?: {path: string, access: string}[]}} options - the
 *   member's project directory, its access, and the room's other directories with its access to each.
 * @param {string[]} private_paths - runner directories holding credentials, never readable through these tools.
 * @returns {{root: string, roots: {root: string, writable: boolean}[], writable: boolean, private_paths: string[],
 *   observed: Map<string, string>} | null} `root` is the main directory; `writable` is whether any directory is.
 */
export function open_project({ cwd, project_access, extra_directories = [] }, private_paths = []) {
  const roots = cwd ? [{ root: realpathSync(cwd), writable: project_access === 'write' }] : [];
  for (const item of extra_directories) {
    // A folder moved away since it was added is left out rather than failing the whole execution.
    try { roots.push({ root: realpathSync(item.path), writable: project_access === 'write' && item.access === 'write' }); } catch { /* Gone. */ }
  }
  if (!roots.length) return null;
  return { root: roots[0].root, roots, writable: roots.some(item => item.writable), observed: new Map(),
    private_paths: private_paths.filter(Boolean).map(path => real_path(resolve(path))) };
}

/** The project directory holding a real path, or undefined outside all of them. */
function owner(project, path) {
  return project.roots.find(item => inside(item.root, path));
}

/** The tools this member gets for its project; none without a project. */
export function file_tools(project) {
  if (!project) return [];
  return [...READ_TOOLS, ...(project.writable ? WRITE_TOOLS : [])].map(name => DEFINITIONS[name]);
}

/** The path shown to the model, with forward slashes: relative in the main directory, absolute in the others. */
function display(project, path) {
  if (!inside(project.root, path)) return path.split(sep).join('/');
  return relative(project.root, path).split(sep).join('/') || '.';
}

/** Why a path inside the project is still refused, or '' when it may be used. */
function refusal(project, path) {
  if (relative(owner(project, path)?.root ?? project.root, path).split(sep).some(part => VCS_DIRECTORIES.includes(part.toLowerCase()))) return 'version control metadata';
  const name = basename(path);
  if (!SECRET_EXAMPLES.test(name) && SECRET_NAMES.some(rule => rule.test(name))) return 'a secret file';
  if (project.private_paths.some(root => inside(root, path))) return "the runner's private files";
  return '';
}

/** Resolve a requested path to a real path inside the project, refusing protected files and, to modify, read-only directories. */
function target(project, requested, exists = true, modify = false) {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('file_path must be a non-empty string');
  const absolute = resolve(project.root, requested);
  let path;
  try { path = exists ? realpathSync(absolute) : real_path(absolute); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`cannot resolve "${requested}": not found`);
    throw error;
  }
  const root = owner(project, path);
  if (!root) throw new Error(`cannot access "${requested}": outside the project directories`);
  if (modify && !root.writable) throw new Error(`cannot modify "${requested}": its directory is read-only for you`);
  const reason = refusal(project, path);
  if (reason) throw new Error(`cannot access "${requested}": ${reason} is not available to API members`);
  return { path, shown: display(project, path) };
}

/** An existing file or directory the member may read, as its real path; throws the reason it may not. */
export function project_path(project, requested) {
  return target(project, requested).path;
}

/** A file's observed version: a later mutation fails when it changed since the read. */
function version(info) {
  return `${info.mtimeMs}:${info.size}`;
}

/** Decode a file as strict UTF-8, refusing binary content. */
function decode(file, buffer, verb) {
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new Error(`cannot ${verb} "${file.shown}": binary file`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(`cannot ${verb} "${file.shown}": invalid UTF-8 text`); }
}

/** Stat a regular file within the size limit. */
function regular_file(file, verb) {
  const info = statSync(file.path);
  if (!info.isFile()) throw new Error(`cannot ${verb} "${file.shown}": not a regular file`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`cannot ${verb} "${file.shown}": ${info.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`);
  return info;
}

function positive(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** The text lines of a file, without line terminators; an empty file has none. */
function text_lines(text) {
  if (!text) return [];
  const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function read(project, args) {
  const offset = positive(args.offset, 'offset', 1), limit = positive(args.limit, 'limit', READ_LIMIT);
  if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`);
  const file = target(project, args.file_path);
  const info = regular_file(file, 'read');
  const lines = text_lines(decode(file, readFileSync(file.path), 'read'));
  if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
    throw new Error(`offset ${offset} is out of range for "${file.shown}" (${lines.length} lines)`);
  }
  const shown = [];
  let bytes = 0, capped = false;
  for (let number = offset; number <= lines.length && shown.length < limit; number++) {
    const raw = lines[number - 1];
    const text = raw.length > READ_MAX_LINE_LENGTH ? `${raw.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)` : raw;
    bytes += Buffer.byteLength(text, 'utf8') + (shown.length ? 1 : 0);
    if (bytes > READ_MAX_BYTES) { capped = true; break; }
    shown.push(`${number}: ${text}`);
  }
  project.observed.set(file.path, version(info));
  const end = offset + shown.length - 1;
  const footer = capped ? `(Output capped. Showing lines ${offset}-${end}. Use offset=${end + 1} to continue.)`
    : end < lines.length ? `(Showing lines ${offset}-${end} of ${lines.length}. Use offset=${end + 1} to continue.)`
      : `(End of file - total ${lines.length} lines)`;
  return `<path>${file.shown}</path>\n<type>file</type>\n<content>\n${shown.length ? `${shown.join('\n')}\n\n${footer}` : footer}\n</content>`;
}

/** Refuse a mutation of a file this execution has not read, or that changed since. */
function check_observed(project, file, info) {
  const seen = project.observed.get(file.path);
  if (!seen) throw new Error(`cannot modify "${file.shown}": file has not been read — read the file, then retry`);
  if (seen !== version(info)) throw new Error(`"${file.shown}" changed since it was read — re-read the file, then retry`);
  // The containment check is by path; another name of the same file may lie outside the project.
  if (info.nlink > 1) throw new Error(`cannot modify "${file.shown}": it has ${info.nlink} hard links, so writing would also change it outside the project`);
}

/** Write through a temporary sibling and a rename, so a crash never leaves a half-written file. */
function atomic_write(file, content, info) {
  mkdirSync(dirname(file.path), { recursive: true });
  const temporary = join(dirname(file.path), `.${basename(file.path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: 'wx', ...(info ? { mode: info.mode & 0o777 } : {}) });
    renameSync(temporary, file.path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return statSync(file.path);
}

function write(project, args) {
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  const file = target(project, args.file_path, false, true);
  let info = null;
  try { info = statSync(file.path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info && !info.isFile()) throw new Error(`cannot write "${file.shown}": not a regular file`);
  if (info) check_observed(project, file, info);
  project.observed.set(file.path, version(atomic_write(file, args.content, info)));
  return `<path>${file.shown}</path>\n<type>file</type>\n<content>\n${info ? 'Updated' : 'Created'} file\n</content>`;
}

function edit(project, args) {
  for (const field of ['old_string', 'new_string']) if (typeof args[field] !== 'string') throw new Error(`${field} must be a string`);
  if (!args.old_string) throw new Error('old_string must be a non-empty string');
  if (args.old_string === args.new_string) throw new Error('old_string and new_string must differ');
  const file = target(project, args.file_path, true, true);
  const info = regular_file(file, 'edit');
  check_observed(project, file, info);
  const raw = decode(file, readFileSync(file.path), 'edit');
  // Edits match on LF text, and the file keeps its prevailing line ending.
  const sample = raw.slice(0, LINE_ENDING_SAMPLE), crlf = sample.split('\r\n').length - 1;
  const content = raw.replaceAll('\r\n', '\n');
  const [before, after] = [args.old_string, args.new_string].map(text => text.replaceAll('\r\n', '\n'));
  const count = content.split(before).length - 1;
  if (!count) throw new Error(`old_string was not found in "${file.shown}"`);
  if (count > 1 && args.replace_all !== true) {
    throw new Error(`old_string matched ${count} times in "${file.shown}"; provide a more specific old_string or set replace_all to true`);
  }
  const next = content.split(before).join(after);
  const lf = sample.split('\n').length - 1 - crlf;
  project.observed.set(file.path, version(atomic_write(file, crlf > lf ? next.split('\n').join('\r\n') : next, info)));
  return args.replace_all === true ? `The file ${file.shown} has been updated. All occurrences were successfully replaced.`
    : `The file ${file.shown} has been updated successfully.`;
}

/** Translate one glob (`*`, `**`, `?`, `[...]`, `{a,b}`) to an anchored regular expression over `/` paths. */
export function glob_regex(glob) {
  const pattern = glob.replace(/^\.\//, '');
  let out = '', braces = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { index++; out += '(?:.*/)?'; } else out += '.*';
    } else if (char === '*') out += '[^/]*';
    else if (char === '?') out += '[^/]';
    else if (char === '{') { braces++; out += '(?:'; }
    else if (char === '}' && braces) { braces--; out += ')'; }
    else if (char === ',' && braces) out += '|';
    else if (char === '[' && pattern.indexOf(']', index + 1) > index + 1) {
      const end = pattern.indexOf(']', index + 1);
      out += `[${pattern.slice(index + 1, end).replace(/^!/, '^').replaceAll('\\', '\\\\')}]`;
      index = end;
    } else out += char.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}

/** A glob with no `/` matches the basename at any depth. */
function path_matcher(glob) {
  if (typeof glob !== 'string' || !glob.trim()) throw new Error('pattern must be a non-empty string');
  return glob_regex(glob.includes('/') ? glob : `**/${glob}`);
}

/** Every file under a directory, version-control metadata and protected files left out; links are not followed. */
function walk(project, directory) {
  const files = [], pending = [directory];
  let seen = 0;
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (++seen > MAX_WALK_ENTRIES) throw new Error(`search stopped after ${MAX_WALK_ENTRIES} entries; narrow path to search less`);
      const path = join(current, entry.name);
      if (entry.isDirectory() && !VCS_DIRECTORIES.includes(entry.name.toLowerCase())) pending.push(path);
      else if (entry.isFile() && !refusal(project, path)) files.push(path);
    }
  }
  return files;
}

/** The files Git does not ignore under a directory, or null outside a Git working tree. */
function unignored_files(project, directory) {
  const result = spawnSync('git', ['-C', directory, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean).map(path => join(directory, path)).filter(path => {
    try { return lstatSync(path).isFile() && !refusal(project, path); } catch { return false; }
  });
}

function directory_target(project, requested = '.') {
  const base = target(project, requested);
  if (!statSync(base.path).isDirectory()) throw new Error(`cannot search "${base.shown}": not a directory`);
  return base;
}

function glob(project, args) {
  const matcher = path_matcher(args.pattern);
  const base = directory_target(project, args.path);
  const paths = walk(project, base.path).filter(path => matcher.test(relative(base.path, path).split(sep).join('/')))
    .map(path => ({ path, time: statSync(path).mtimeMs })).sort((left, right) => left.time - right.time)
    .map(({ path }) => display(project, path));
  if (!paths.length) return 'No files found';
  if (paths.length <= GLOB_MAX_RESULTS) return paths.join('\n');
  return `${paths.slice(0, GLOB_MAX_RESULTS).join('\n')}\n\n(Showing ${GLOB_MAX_RESULTS} of ${paths.length} paths. Narrow pattern or path to see more.)`;
}

function grep(project, args) {
  if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern must be a non-empty string');
  let regex;
  try { regex = new RegExp(args.pattern); } catch (error) { throw new Error(`invalid regular expression: ${error.message}`); }
  const include = args.include === undefined ? null : path_matcher(args.include);
  const base = target(project, args.path ?? '.');
  const single = statSync(base.path).isFile();
  const files = single ? [base.path] : unignored_files(project, base.path) ?? walk(project, base.path);
  const groups = [];
  let seen = 0, kept = 0;
  for (const path of files.sort()) {
    if (include && !single && !include.test(relative(base.path, path).split(sep).join('/'))) continue;
    let buffer;
    try { buffer = statSync(path).size <= MAX_FILE_BYTES ? readFileSync(path) : null; } catch { continue; }
    if (!buffer || buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) continue;
    const matches = [];
    text_lines(buffer.toString('utf8')).forEach((line, index) => {
      if (!regex.test(line)) return;
      seen++;
      if (kept >= GREP_MAX_MATCHES) return;
      kept++;
      matches.push(`Line ${index + 1}: ${line.length > GREP_MAX_LINE_LENGTH ? `${line.slice(0, GREP_MAX_LINE_LENGTH)}…` : line}`);
    });
    if (matches.length) groups.push(`${display(project, path)}\n${matches.join('\n')}`);
  }
  if (!seen) return 'No matches found';
  const body = groups.join('\n\n');
  if (seen === kept) return `Found ${seen} ${seen === 1 ? 'match' : 'matches'}\n\n${body}`;
  return `Found ${kept} of ${seen} matches\n\n${body}\n\n(The complete result could not be saved; narrow pattern, path, or include to see more.)`;
}

/** The bytes of a project file the member may read, up to `limit` bytes, for tools that take binary input such as images. */
export function read_project_bytes(project, requested, limit) {
  const file = target(project, requested);
  const info = statSync(file.path);
  if (!info.isFile()) throw new Error(`cannot read "${file.shown}": not a regular file`);
  if (info.size > limit) throw new Error(`cannot read "${file.shown}": ${info.size} bytes exceeds the ${limit}-byte limit`);
  return { data: readFileSync(file.path), shown: file.shown };
}

/**
 * Save new binary content, such as a generated image, at a path the member may write. It never replaces an existing
 * file, since a binary file cannot be read first. Returns the real path and the path shown to the model.
 */
export function write_new_project_file(project, requested, data) {
  const file = target(project, requested, false, true);
  try { statSync(file.path); throw new Error(`cannot write "${file.shown}": it already exists; choose a new path`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  atomic_write(file, data, null);
  return file;
}

const RUNNERS = { read, glob, grep, write, edit };

/** Whether a tool name is one of the file tools. */
export function is_file_tool(name) {
  return Object.hasOwn(RUNNERS, name);
}

/**
 * Run one file tool. A refused or failed call returns its reason to the model, which can correct the call.
 * @returns {string | {error: string}} the model-facing text, or the error.
 */
export function run_file_tool(project, name, args) {
  try { return RUNNERS[name](project, args); }
  catch (error) { return { error: error.message }; }
}
