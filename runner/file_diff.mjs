/**
 * Line diffs of the files one execution changed, for the "edited N files +a -b" card on its message: each file's added
 * and removed line counts and a unified patch, measured against the file as it stood when the execution began (the
 * Git version when it was clean then). Node built-ins only; large or binary files report no lines.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Files larger than this are listed without lines; patches are kept short enough to travel with the room.
// 1 MiB: the project's own largest sources (about 290 KB) still get lines (user 2026-11-17).
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_PATCH_LINES = 400;
const MAX_TOTAL_PATCH_CHARS = 400 * 1024;
const MAX_FILES = 200;
// Above this many differing lines the middle of a file is shown as replaced whole rather than aligned line by line.
const MAX_EDIT_DISTANCE = 4000;
const CONTEXT_LINES = 3;
const GIT_TIMEOUT_MS = 15_000;

/** A file's text, or a marker why it has no lines: missing, too large, or binary. */
function read_text(file) {
  let stat;
  try { stat = statSync(file); } catch { return { missing: true }; }
  // Git lists a changed submodule by its directory; like anything else that is not a readable file it has no line diff
  // (reading it threw EISDIR, which failed every delivery in a project with a modified submodule, 2026-11-19 #5719).
  if (!stat.isFile()) return { skipped: 'binary' };
  if (stat.size > MAX_DIFF_BYTES) return { skipped: 'large' };
  let bytes;
  try { bytes = readFileSync(file); } catch { return { skipped: 'binary' }; }
  return bytes.includes(0) ? { skipped: 'binary' } : { text: bytes.toString('utf8') };
}

/**
 * Keep the text of every file already changed when an execution begins (the snapshot's paths), so its diff counts only
 * what the execution itself did to it. Files clean then are compared with Git at the end.
 * @returns {Map<string, {text?: string, missing?: boolean, skipped?: string}>}
 */
export function capture_base(directory, before) {
  const base = new Map();
  if (!directory || !before) return base;
  for (const path of before.keys()) base.set(path, read_text(join(directory, path)));
  return base;
}

/** The file as Git has it (the last commit), or missing when Git does not track it. */
function committed(directory, path) {
  const result = spawnSync('git', ['-C', directory, 'show', `HEAD:./${path}`], { maxBuffer: MAX_DIFF_BYTES * 2, windowsHide: true, timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) return { missing: true };
  if (result.stdout.length > MAX_DIFF_BYTES) return { skipped: 'large' };
  return result.stdout.includes(0) ? { skipped: 'binary' } : { text: result.stdout.toString('utf8') };
}

const lines_of = (text) => (text ? text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);

/** Myers' shortest edit script between two line arrays, as ['=', '-', '+', line] steps; null once it grows too long. */
function edit_script(a, b) {
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return null;
}

function backtrack(trace, a, b, offset, last) {
  const steps = [];
  let x = a.length, y = b.length;
  for (let d = last; d >= 0; d--) {
    const v = trace[d], k = x - y;
    const previous = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? k + 1 : k - 1;
    const px = d === 0 ? 0 : v[offset + previous], py = d === 0 ? 0 : px - previous;
    while (x > px && y > py) { steps.push(['=', a[x - 1]]); x--; y--; }
    if (d > 0) steps.push(x === px ? ['+', b[y - 1]] : ['-', a[x - 1]]);
    if (d > 0) { x = px; y = py; }
  }
  return steps.reverse();
}

/** The steps from one text to the other: common ends kept, the middle aligned, or replaced whole when too different. */
function steps_between(before, after) {
  const a = lines_of(before), b = lines_of(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const middle_a = a.slice(start, a.length - end), middle_b = b.slice(start, b.length - end);
  const middle = edit_script(middle_a, middle_b)
    || [...middle_a.map(line => ['-', line]), ...middle_b.map(line => ['+', line])];
  return [...a.slice(0, start).map(line => ['=', line]), ...middle, ...a.slice(a.length - end).map(line => ['=', line])];
}

/** Unified-diff hunks with a few lines of context, cut at MAX_PATCH_LINES. */
function patch_of(steps) {
  const lines = [];
  let old_line = 1, new_line = 1, truncated = false;
  const changed = steps.map(step => step[0] !== '=');
  for (let index = 0; index < steps.length;) {
    if (!changed[index]) { old_line++; new_line++; index++; continue; }
    const from = Math.max(0, index - CONTEXT_LINES);
    let to = index;
    // A hunk runs on while changes come within twice the context of each other.
    while (to < steps.length) {
      let next = to;
      while (next < steps.length && changed[next]) next++;
      let gap = next;
      while (gap < steps.length && !changed[gap] && gap - next < CONTEXT_LINES * 2) gap++;
      if (gap < steps.length && changed[gap]) { to = gap; continue; }
      to = Math.min(steps.length, next + CONTEXT_LINES);
      break;
    }
    const lead = index - from;
    let old_start = old_line - lead, new_start = new_line - lead, old_count = 0, new_count = 0;
    const body = [];
    for (let at = from; at < to; at++) {
      const [kind, text] = steps[at];
      body.push(`${kind === '=' ? ' ' : kind}${text}`);
      if (kind !== '+') old_count++;
      if (kind !== '-') new_count++;
    }
    for (let at = index; at < to; at++) {
      if (steps[at][0] !== '+') old_line++;
      if (steps[at][0] !== '-') new_line++;
    }
    lines.push(`@@ -${old_start},${old_count} +${new_start},${new_count} @@`, ...body);
    index = to;
    if (lines.length >= MAX_PATCH_LINES) { truncated = true; break; }
  }
  return { patch: lines.slice(0, MAX_PATCH_LINES).join('\n'), truncated: truncated || lines.length > MAX_PATCH_LINES };
}

/**
 * Each changed path's `{path, added, removed, patch, truncated}`, or `{path, skipped}` for a large or binary file.
 * @param {string} directory The working tree the paths are relative to.
 * @param {string[]} paths The paths the execution changed.
 * @param {Map} base What capture_base kept when the execution began.
 */
export function file_diffs(directory, paths, base = new Map()) {
  const results = [];
  let total = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    const before = base.has(path) ? base.get(path) : committed(directory, path);
    const after = read_text(join(directory, path));
    const skipped = before.skipped || after.skipped;
    if (skipped) { results.push({ path, skipped }); continue; }
    const steps = steps_between(before.text || '', after.text || '');
    const added = steps.filter(step => step[0] === '+').length, removed = steps.filter(step => step[0] === '-').length;
    let { patch, truncated } = patch_of(steps);
    if (total + patch.length > MAX_TOTAL_PATCH_CHARS) { patch = ''; truncated = true; }
    total += patch.length;
    results.push({ path, added, removed, patch, truncated, ...(before.missing ? { created: true } : {}), ...(after.missing ? { deleted: true } : {}) });
  }
  return results;
}
