/** Parts every software adapter shares: running programs, ending process trees, reading session logs and model catalogs. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { TASK_SUBCOMMANDS } from '../expert_prompts.mjs';
import { atomic_json } from '../files.mjs';
import { t } from '../i18n.mjs';

// The room defines which website subcommands a task may run; adapters turn them into each software's permission rules.
export { TASK_SUBCOMMANDS };
export const CALL_TIMEOUT_MS = 30_000;
export const CLI_MAX_RUN_MS = 2 * 60 * 60_000;
/** The shared headless process limit, including the operator's override. */
export function cli_max_run_ms() { return Number(process.env.CODISCUSS_CLI_MAX_MS) || CLI_MAX_RUN_MS; }
/** Explain the total runtime limit in the CLI's selected language. */
export function cli_timeout_reason(milliseconds) {
  return t('CLI 运行超过 {seconds} 秒仍未结束，已终止', { seconds: Math.round(milliseconds / 1000) });
}
/** Tool names that edit files, across the softwares' event streams. */
const SHELL_WRAPPER_PREFIX = /^"?[^"]*?(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?"?\s+(?:(?:-[A-Za-z]+(?:\s+(?!-Command\b|\/c\b|-lc\b|-c\b)[^\s'"]+)?)\s+)*(?:-Command|\/c|-lc|-c)\s+([\s\S]*)$/i;
const NULL_DEVICES = new Set(['/dev/null', '$null', 'nul', 'con', 'prn', 'aux']);
const PS_SWITCH_FLAGS = new Set(['-force', '-nonewline', '-passthru', '-append', '-noclobber', '-whatif', '-confirm', '-asbytestream', '-raw', '-recurse']);
const PS_PATH_FLAGS = new Set(['-path', '-literalpath', '-filepath']);

/** Decode a shlex-style single/double-quoted shell argument string back into its inner script text. */
function unquote_shell_arg(raw) {
  const text = raw.trim();
  if (!text || !['\'', '"'].includes(text[0])) return text;
  let result = '', i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\'') {
      const end = text.indexOf('\'', i + 1);
      if (end < 0) return text;
      result += text.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length && ['"', '\\', '$', '`'].includes(text[i + 1])) {
          result += text[i + 1];
          i += 2;
        } else if (text[i] === '"') {
          i += 1;
          closed = true;
          break;
        } else {
          result += text[i++];
        }
      }
      if (!closed) return text;
    } else {
      return text;
    }
  }
  return result;
}

/** Strip an outer shell wrapper (`powershell -Command …`, `bash -lc …`, `cmd /c …`) to inspect the real command. */
function unwrap_shell_command(command) {
  const text = String(command || '').trim();
  const match = text.match(SHELL_WRAPPER_PREFIX);
  return match ? unquote_shell_arg(match[1]) : text;
}

/** Keep only plausible literal target file paths; reject options, variables, globs, URLs and null devices. */
function clean_target_path(raw) {
  let value = String(raw || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) value = value.slice(1, -1).trim();
  if (!value || value.startsWith('-') || value.startsWith('&') || NULL_DEVICES.has(value.toLowerCase())) return '';
  if (/[\r\n\t*?`$%]|^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value === '.' || value === '..') return '';
  return value;
}

/** Add one cleaned literal path into a target set. */
function collect_path(targets, raw) {
  const cleaned = clean_target_path(raw);
  if (cleaned) targets.add(cleaned);
}

/** Resolve a variable or literal argument against literal path bindings. */
function collect_bound(targets, literal, variable, bindings) {
  if (literal) return collect_path(targets, literal);
  for (const item of bindings.get(variable) || []) collect_path(targets, item);
}

/** Extract literal write targets from an embedded Python snippet in statement order; reads claim nothing. */
// Ignore write-like examples inside strings and comments.
function* script_calls(stmt, pattern, syntax) {
  const spans = [...stmt.matchAll(syntax)];
  for (const match of stmt.matchAll(pattern)) {
    if (!spans.some(span => span.index <= match.index && match.index < span.index + span[0].length)) yield match;
  }
}
const PYTHON_DATA = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|#.*/g;
const NODE_DATA = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|\x60(?:\\.|[^\x60\\])*\x60|\/\/.*/g;

function python_written_paths(script) {
  const bindings = new Map(), targets = new Set();
  for (const raw_line of String(script || '').split(/\r?\n/)) {
    if (/^\s*#/.test(raw_line)) continue;
    const loop = raw_line.match(/^\s*for\s+(\w+)(\s*,\s*\w+)*\s+in\s+\[([\s\S]*?)\]\s*:/);
    if (loop) {
      const pattern = loop[2] ? /\(\s*r?(['"])([^'"]+)\1/g : /(?:^|,)\s*r?(['"])([^'"]+)\1/g;
      const items = [...loop[3].matchAll(pattern)].map(item => item[2]);
      if (items.length) bindings.set(loop[1], items);
      else bindings.delete(loop[1]);
    }
    for (const stmt of raw_line.split(';')) {
      const assign = stmt.match(/^\s*(\w+)\s*=(?!=)\s*(.*)$/);
      if (assign) {
        const rhs = assign[2].trim();
        const literal = rhs.match(/^(?:(?:pathlib\.)?Path\(\s*)?r?(['"])([^'"]+)\1\s*\)?\s*(?:#.*)?$/)?.[2];
        const ref = !literal && rhs.match(/^(?:(?:pathlib\.)?Path\(\s*)?(\w+)\s*\)?\s*(?:#.*)?$/)?.[1];
        if (literal) bindings.set(assign[1], [literal]);
        else if (ref && bindings.has(ref)) bindings.set(assign[1], bindings.get(ref));
        else bindings.delete(assign[1]);
      }
      for (const m of script_calls(stmt, /(?:pathlib\.)?Path\(\s*(?:r?(['"])([^'"]+)\1|(\w+))\s*\)\.(?:write_text|write_bytes|unlink)\(/g, PYTHON_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /\b(\w+)\.(?:write_text|write_bytes|unlink)\(/g, PYTHON_DATA)) {
        collect_bound(targets, '', m[1], bindings);
      }
      for (const m of script_calls(stmt, /\bopen\(\s*(?:r?(['"])([^'"]+)\1|(\w+))\s*,\s*(?:mode\s*=\s*)?['"](?=[rwbta+x]*[wax+])[rwbta+x]+['"]/g, PYTHON_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /\b(\w+)\.open\(\s*(?:mode\s*=\s*)?['"][^'"]*[wax+][^'"]*['"]/g, PYTHON_DATA)) {
        collect_bound(targets, '', m[1], bindings);
      }
      for (const m of script_calls(stmt, /\bshutil\.(?:copy|copy2|copyfile)\(\s*[^,\n]+,\s*(?:r?(['"])([^'"]+)\1|(\w+))\s*[,)]/g, PYTHON_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /\bos\.(?:remove|unlink)\(\s*(?:r?(['"])([^'"]+)\1|(\w+))\s*\)/g, PYTHON_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /\bos\.(?:replace|rename)\(\s*(?:r?(['"])([^'"]+)\1|(\w+))\s*,\s*(?:r?(['"])([^'"]+)\4|(\w+))\s*\)/g, PYTHON_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
        collect_bound(targets, m[5], m[6], bindings);
      }
    }
  }
  return [...targets];
}

/** Extract literal write targets from an embedded Node snippet (`node -e` / `node -`); imports and reads claim nothing. */
function node_written_paths(script) {
  const bindings = new Map(), targets = new Set();
  for (const line of String(script || '').split(/\r?\n/)) {
    for (const stmt of line.split(';')) {
      const assign = stmt.match(/^\s*(?:(?:const|let|var)\s+)?(\w+)\s*=(?!=)\s*(.*)$/);
      if (assign) {
        const literal = assign[2].trim().match(/^(['"])([^'"]+)\1\s*(?:\/\/.*)?$/)?.[2];
        if (literal) bindings.set(assign[1], [literal]);
        else bindings.delete(assign[1]);
      }
      for (const m of script_calls(stmt, /(?:\bfs(?:\.promises)?\.)?(?:writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|unlink)\(\s*(?:(['"])([^'"]+)\1|(\w+))\s*[,)]/g, NODE_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /(?:\bfs(?:\.promises)?\.)?copyFileSync\(\s*[^,\n]+,\s*(?:(['"])([^'"]+)\1|(\w+))\s*[,)]/g, NODE_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
      }
      for (const m of script_calls(stmt, /(?:\bfs(?:\.promises)?\.)?renameSync\(\s*(?:(['"])([^'"]+)\1|(\w+))\s*,\s*(?:(['"])([^'"]+)\4|(\w+))\s*\)/g, NODE_DATA)) {
        collect_bound(targets, m[2], m[3], bindings);
        collect_bound(targets, m[5], m[6], bindings);
      }
    }
  }
  return [...targets];
}

/** Extract embedded PowerShell here-strings and bash heredocs so their bodies never pollute shell command parsing. */
function extract_embedded_scripts(text, targets) {
  let rest = text.replace(/@(['"])\r?\n([\s\S]*?)\r?\n\1@([ \t]*\|[ \t]*[^\r\n;]*)?/g, (full, _q, body, pipe = '') => {
    if (/^\s*\|\s*(?:python(?:3)?|py)(?:\.exe)?\b(?![^\r\n]*\s-c\b)/i.test(pipe)) {
      python_written_paths(body).forEach(path => targets.add(path));
      return '';
    }
    if (/^\s*\|\s*node(?:\.exe)?\b(?![^\r\n]*\s(?:-e|--eval)\b)/i.test(pipe)) {
      node_written_paths(body).forEach(path => targets.add(path));
      return '';
    }
    return pipe ? `''${pipe}` : '\'\'';
  });
  rest = rest.replace(/^([^\r\n]*<<-?\s*(['"]?)([A-Za-z_]\w*)\2[^\r\n]*)\r?\n([\s\S]*?)\r?\n[ \t]*\3(?=\r?\n|$)/gm, (_full, header, _q, _tag, body) => {
    if (/^\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:python(?:3)?|py)(?:\.exe)?\b/i.test(header)) {
      python_written_paths(body).forEach(path => targets.add(path));
      return '';
    }
    if (/^\s*(?:[A-Za-z_]\w*=\S+\s+)*node(?:\.exe)?\b/i.test(header)) {
      node_written_paths(body).forEach(path => targets.add(path));
      return '';
    }
    return header.replace(/<<-?\s*(['"]?)[A-Za-z_]\w*\1/, '');
  });
  return rest;
}

/** Extract PowerShell `[IO.File]::Write*` targets bound to literal paths or simple `$var = 'path'` assignments. */
function powershell_io_writes(text, targets) {
  const bindings = new Map();
  for (const line of text.split(/\r?\n/)) {
    const assign = line.match(/^\s*(\$\w+)\s*=\s*(.*)$/);
    if (assign) {
      const literal = assign[2].match(/^(?:Resolve-Path\s+)?(['"])([^'"]+)\1\s*;?\s*$/i)?.[2];
      if (literal) bindings.set(assign[1], [literal]);
      else bindings.delete(assign[1]);
    }
    for (const m of line.matchAll(/^\s*\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllBytes|WriteAllLines|AppendAllText|AppendAllLines)\(\s*(?:(['"])([^'"]+)\1|(\$\w+))\s*,/gi)) {
      collect_bound(targets, m[2], m[3], bindings);
    }
  }
}

/** Split a shell script into top-level command segments on `&&`, `||`, `;`, `|` and newlines, respecting quotes. */
function split_shell_segments(text) {
  const segments = [];
  let current = '', quote = '', depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], next = text[i + 1];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && next !== undefined) { current += next; i++; }
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '(') { depth++; current += ch; continue; }
    if (ch === ')' && depth > 0) { depth--; current += ch; continue; }
    if (!depth && (ch === '\n' || ch === '\r' || ch === ';' || ch === '|')) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      if (ch === '|' && next === '|') i++;
      continue;
    }
    if (!depth && ch === '&' && next === '&') {
      if (current.trim()) segments.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Tokenize one shell segment while preserving quoted arguments and separating redirection operators. */
function tokenize_segment(segment) {
  const tokens = [];
  let current = '', quote = '';
  const flush = () => { if (current) { tokens.push(current); current = ''; } };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i], next = segment[i + 1];
    if (quote) {
      if (ch === '\\' && quote === '"' && next !== undefined) { current += next; i++; }
      else if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { flush(); continue; }
    const redir = segment.slice(i).match(/^(?:[12&]?>>?|<<<?|<<)/);
    if (redir && (!current || /^[12&]$/.test(current))) {
      const op = current ? current + redir[0] : redir[0];
      current = '';
      if (/^(?:[12&]?>>?|<<<?|<<)$/.test(op)) { tokens.push({ redir: op }); i += redir[0].length - 1; continue; }
    }
    current += ch;
  }
  flush();
  return tokens;
}

/** Strip redirections from a tokenized segment, collecting only stdout/combined output targets (`>`, `>>`, `1>`, `&>`). */
function strip_redirections(tokens, targets) {
  const argv = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (typeof token === 'object' && token.redir) {
      const target = typeof tokens[i + 1] === 'string' ? tokens[++i] : '';
      if (/^(?:1|&)?>>?$/.test(token.redir) && target && !target.startsWith('&')) collect_path(targets, target);
    } else if (typeof token === 'string') {
      argv.push(token);
    }
  }
  return argv;
}

/** Extract write targets from one simple command's argv (already stripped of redirections). */
function command_written_paths(argv, targets) {
  let index = 0;
  while (index < argv.length && (/^[A-Za-z_]\w*=/.test(argv[index]) || argv[index] === '&')) index++;
  if (index >= argv.length) return;
  const cmd = argv[index].split(/[\\/]/).at(-1).replace(/\.exe$/i, '').toLowerCase();
  const args = argv.slice(index + 1);
  if (['python', 'python3', 'py'].includes(cmd)) {
    const c = args.indexOf('-c');
    if (c >= 0 && args[c + 1]) python_written_paths(args[c + 1]).forEach(path => targets.add(path));
    return;
  }
  if (cmd === 'node') {
    const e = args.findIndex(arg => arg === '-e' || arg === '--eval');
    if (e >= 0 && args[e + 1]) node_written_paths(args[e + 1]).forEach(path => targets.add(path));
    return;
  }
  if (cmd === 'cp' || cmd === 'copy') {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-t' || args[i] === '--target-directory') { i++; return; }
      if (args[i].startsWith('--target-directory=')) return;
      if (!args[i].startsWith('-')) positional.push(args[i]);
    }
    if (positional.length >= 2 && !/[\\/]$/.test(positional.at(-1))) collect_path(targets, positional.at(-1));
    return;
  }
  if (cmd === 'copy-item' || cmd === 'cpi') {
    const dest = args.findIndex(arg => arg.toLowerCase() === '-destination');
    if (dest >= 0 && args[dest + 1]) return collect_path(targets, args[dest + 1]);
    const positional = args.filter((arg, i) => !arg.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-') && !PS_SWITCH_FLAGS.has(args[i - 1].toLowerCase())));
    if (positional.length >= 2 && !/[\\/]$/.test(positional.at(-1))) collect_path(targets, positional.at(-1));
    return;
  }
  if (cmd === 'mv' || cmd === 'move' || cmd === 'move-item' || cmd === 'mi') {
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const lower = args[i].toLowerCase();
      if (['-path', '-literalpath', '-destination'].includes(lower) && args[i + 1]) { positional.push(args[++i]); continue; }
      if (args[i].startsWith('-')) { if (!PS_SWITCH_FLAGS.has(lower) && cmd.includes('-')) i++; continue; }
      positional.push(args[i]);
    }
    if (positional.length >= 2) positional.forEach(item => { if (!/[\\/]$/.test(item)) collect_path(targets, item); });
    return;
  }
  if (cmd === 'rename-item' || cmd === 'rni') {
    const path_flag = args.findIndex(arg => PS_PATH_FLAGS.has(arg.toLowerCase()));
    const positional = args.filter((arg, i) => !arg.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-') && !PS_SWITCH_FLAGS.has(args[i - 1].toLowerCase())));
    const source = path_flag >= 0 ? args[path_flag + 1] : positional[0];
    if (source) collect_path(targets, source);
    const name_flag = args.findIndex(arg => arg.toLowerCase() === '-newname');
    const renamed = name_flag >= 0 ? args[name_flag + 1] : positional[1];
    if (source && renamed && !/[\\/]/.test(renamed)) {
      const prefix = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1)
        : source.includes('\\') ? source.slice(0, source.lastIndexOf('\\') + 1) : '';
      collect_path(targets, `${prefix}${renamed}`);
    }
    return;
  }
  if (['rm', 'del', 'erase', 'remove-item', 'ri', 'touch', 'tee'].includes(cmd)) {
    for (let i = 0; i < args.length; i++) {
      const lower = args[i].toLowerCase();
      if (PS_PATH_FLAGS.has(lower) && args[i + 1]) { collect_path(targets, args[++i]); continue; }
      if (args[i].startsWith('-')) continue;
      collect_path(targets, args[i]);
    }
    return;
  }
  if (cmd === 'new-item' || cmd === 'ni') {
    const path_flag = args.findIndex(arg => PS_PATH_FLAGS.has(arg.toLowerCase()));
    const name_flag = args.findIndex(arg => arg.toLowerCase() === '-name');
    const positional = args.filter((arg, i) => !arg.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-') && !PS_SWITCH_FLAGS.has(args[i - 1].toLowerCase())));
    const base = path_flag >= 0 ? args[path_flag + 1] : positional[0];
    const name = name_flag >= 0 ? args[name_flag + 1] : '';
    if (base && name) collect_path(targets, `${base.replace(/[\\/]+$/, '')}/${name}`);
    else if (base || name) collect_path(targets, base || name);
    return;
  }
  if (['set-content', 'add-content', 'out-file', 'sc', 'ac'].includes(cmd)) {
    const path_flag = args.findIndex(arg => PS_PATH_FLAGS.has(arg.toLowerCase()));
    if (path_flag >= 0 && args[path_flag + 1]) return collect_path(targets, args[path_flag + 1]);
    for (let i = 0; i < args.length; i++) {
      const lower = args[i].toLowerCase();
      if (lower.startsWith('-')) { if (!PS_SWITCH_FLAGS.has(lower)) i++; continue; }
      return collect_path(targets, args[i]);
    }
    return;
  }
  if (cmd === 'sed') {
    let in_place = false, has_script_flag = false;
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place=')) {
        in_place = true;
        if (arg === '-i' && args[i + 1] === '') i++;
        continue;
      }
      if (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file') { has_script_flag = true; i++; continue; }
      if (arg.startsWith('-')) continue;
      positional.push(arg);
    }
    if (!in_place) return;
    (has_script_flag ? positional : positional.slice(1)).forEach(item => collect_path(targets, item));
    return;
  }
  if (cmd === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-c', '-C', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
    const sub = args[i]?.toLowerCase(), rest = args.slice(i + 1);
    if (sub === 'restore' || sub === 'rm') {
      for (let j = 0; j < rest.length; j++) {
        if (rest[j] === '--') { rest.slice(j + 1).forEach(item => collect_path(targets, item)); return; }
        if (rest[j] === '-s' || rest[j] === '--source') { j++; continue; }
        if (!rest[j].startsWith('-')) collect_path(targets, rest[j]);
      }
    } else if (sub === 'checkout') {
      const dash = rest.indexOf('--');
      if (dash >= 0) rest.slice(dash + 1).forEach(item => collect_path(targets, item));
    } else if (sub === 'mv') {
      rest.filter(item => !item.startsWith('-')).forEach(item => collect_path(targets, item));
    }
  }
}

/**
 * The literal target file paths a shell command writes to, parsed per segment and by write-target position so copy
 * sources, redirected inputs and read-only commands in compound lines are never blamed; unknown targets stay empty.
 */
export function shell_written_paths(command) {
  const text = unwrap_shell_command(command);
  if (!text) return [];
  const targets = new Set();
  const remaining = extract_embedded_scripts(text, targets);
  powershell_io_writes(remaining, targets);
  for (const segment of split_shell_segments(remaining)) {
    const argv = strip_redirections(tokenize_segment(segment), targets);
    command_written_paths(argv, targets);
  }
  return [...targets];
}
export const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/;
/** A refused operation's detail and rule are cut to this length; a run reports at most this many. */
export const DENIAL_FIELD = 300;
export const MAX_DENIALS = 20;

/** Only failures before a software invocation are safe for automatic redelivery. */
export function not_sent(error) { return Object.assign(error, { delivery_status: 'not_sent' }); }

/** Run an executable directly; user text is always an argv value, never shell code. */
export function run_program(executable, args, options = {}) {
  return new Promise((resolve_result, reject) => {
    let child;
    try { child = spawn(executable, args, { windowsHide: true, shell: false, ...options }); }
    catch (error) { reject(not_sent(error)); return; }
    let spawned = false;
    child.once('spawn', () => { spawned = true; });
    let output = '';
    let error_text = '';
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stderr?.on('data', chunk => { error_text += chunk; });
    child.once('error', error => reject(spawned ? error : not_sent(error)));
    child.once('close', code => code === 0 ? resolve_result(output) : reject(new Error(`软件退出码 ${code}: ${error_text.slice(-500)}`)));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin?.end();
  });
}

/** Bind returned software identities back to the private credential file. */
export function bind_access(path, session_id) {
  const access = JSON.parse(readFileSync(path, 'utf8'));
  atomic_json(path, { ...access, session_id });
}

/** Compare local directory identities without assuming case sensitivity on Windows. */
export function same_path(left, right) {
  if (!left || !right) return false;
  const normalize = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

/**
 * Folders a member may not write, with its own knowledge (`keep`) carved out (user 2026-11-22: an expert's skills live
 * in its card's folder inside the workflow, which stays protected). A folder holding `keep` is replaced by every entry
 * beside the path down to it, as they are on disk now, so deny rules, which win over allow rules in Claude Code and
 * agy, still cover the rest; an entry created later beside that path is not covered. Returns `{ path, directory }`.
 */
export function carve_protected(paths, keep) {
  const result = [];
  for (const path of paths.filter(Boolean)) {
    const rest = keep ? relative(resolve(path), resolve(keep)) : '';
    if (!rest || rest === '..' || rest.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rest)) {
      result.push({ path, directory: true });
      continue;
    }
    let current = resolve(path);
    for (const segment of rest.split(/[\\/]/)) {
      let names = [];
      try { names = readdirSync(current); } catch { break; }
      for (const name of names.filter(item => !same_path(join(current, item), join(current, segment)))) {
        result.push({ path: join(current, name), directory: lstatSync(join(current, name)).isDirectory() });
      }
      current = join(current, segment);
    }
  }
  return result;
}

/** The participant's discussion project directory; workdir is the legacy field name. */
export function project_directory(config) { return config.cwd || config.workdir || ''; }

/** Keep the requested project as cwd; without a project, use the separate answer directory. */
export function launch_directory(config, task) {
  return project_directory(config) || task.draft_directory;
}

/** Read optional native settings; malformed settings must not silently disable a permission check. */
export function read_json(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; }

/**
 * Windows leaves a killed process's descendants running, so a stopped Claude turn kept its tool commands working.
 * End the whole tree there; elsewhere, or when taskkill cannot run or fails, use the plain kill. taskkill runs without
 * being waited for: a service stopping many rooms would otherwise block on each tree in turn and miss its stop deadline.
 */
export function kill_process_tree(child, plain_kill, platform = process.platform, run = spawn) {
  if (platform === 'win32' && child.pid && child.exitCode === null && child.signalCode === null) {
    try {
      const killer = run('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => plain_kill());
      killer.once('exit', code => { if (code !== 0) plain_kill(); });
      return true;
    } catch { /* Fall through to the plain kill. */ }
  }
  return plain_kill();
}

/** Make a delivered process's kill end its whole tree on Windows, so a stopped turn leaves no tool commands running. */
export function tree_killable(child) {
  if (typeof child.kill === 'function') {
    const plain_kill = child.kill.bind(child);
    child.kill = () => kill_process_tree(child, plain_kill);
  }
  return child;
}

/**
 * Report the phase and any progress note of each complete JSON line, as the adapter's `events` read them; malformed
 * lines are left to the caller's own parsing.
 */
export function watch_events(adapter, stream, task) {
  if (!task.on_activity && !task.on_note && !task.on_edits) return;
  track_edits(adapter, task);
  const pending_edits = new Map();
  createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    const phase = adapter.events.phase(event);
    if (phase) task.on_activity?.(phase, adapter.events.tool(event), adapter.events.call?.(event));
    const note = adapter.events.note(event);
    if (note) task.on_note?.(note);
    report_edits(adapter, event, task, pending_edits);
  });
}

/**
 * Declare that this run's file edits are tracked, when the adapter reads them from its events: `on_edits([])` tells the
 * runner the edit list is known even if it stays empty. Writes the agent makes through commands are not seen.
 */
export function track_edits(adapter, task) {
  if (adapter.events.edits) task.on_edits?.([]);
}

/** Pass on the files one event says the agent edited with its own edit tools. */
export function report_edits(adapter, event, task, pending) {
  const paths = adapter.events.edits?.(event, pending) || [];
  if (paths.length) task.on_edits?.(paths);
}

/** The task file name an execution's prompt carries; it marks where that execution entered a session. */
export const execution_marker = id => `free-${id}.task.json`;

/** JSON lines of a session log; lines the software wrote in another shape are skipped. */
export function log_entries(file) {
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** The text of a prompt as the software stored it: a string, or text parts (tool results carry no prompt). */
export function prompt_text(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.filter(part => ['text', 'input_text'].includes(part?.type)).map(part => part.text || '').join('\n') : '';
}

/** Whether a prompt names any of the execution markers. */
export const marked = (text, markers) => markers.some(marker => text.includes(marker));

// Only the end of a session log is read; the latest request is there and long sessions stay cheap.
const SESSION_TAIL_BYTES = 4 * 1024 * 1024;

/** The lines at the end of a file, newest first; a line cut at the start of the tail fails to parse and is skipped. */
function tail_lines(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size, length = Math.min(size, SESSION_TAIL_BYTES), buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').reverse();
  } finally { closeSync(fd); }
}

/** Parse the newest log record that `pick` turns into settings. */
export function newest_record(file, marker, pick) {
  for (const line of tail_lines(file)) {
    if (!line.includes(marker)) continue;
    try { const found = pick(JSON.parse(line)); if (found) return found; } catch { /* A cut or foreign line says nothing. */ }
  }
  return null;
}

// Browsing stored conversations reads only the two ends of each log: where it was made and its first prompt are at the
// start, its latest title at the end.
const SESSION_EDGE_BYTES = 256 * 1024;
// A preview shows the end of a conversation: its last messages, read from this much of the log, each cut to a readable length.
const PREVIEW_TAIL_BYTES = 2 * 1024 * 1024;
const PREVIEW_MESSAGES = 40;
const PREVIEW_TEXT_LIMIT = 2000;
const SESSION_TITLE_LIMIT = 120;
export const SESSION_PAGE_SIZE = 30;
// One listing request describes at most this many logs, so a search with few matches still answers quickly.
const SESSION_SCAN_LIMIT = 600;

/** JSON entries of one byte range of a log; a line cut at either end of the range fails to parse and is skipped. */
function range_entries(fd, position, length) {
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, position);
  return buffer.toString('utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** The entries at the start and at the end of a session log (the same list for a short log), without reading its middle. */
export function edge_entries(file, bytes = SESSION_EDGE_BYTES) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= bytes * 2) { const all = range_entries(fd, 0, size); return { head: all, tail: all }; }
    return { head: range_entries(fd, 0, bytes), tail: range_entries(fd, size - bytes, bytes) };
  } finally { closeSync(fd); }
}

/** A prompt as its author typed it: without the software's injected reminders; '' when the software wrote all of it. */
export function typed_prompt(text) {
  const plain = String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return /^<[A-Za-z_-]+>/.test(plain) ? '' : plain;
}

/** One line naming a conversation that has no title of its own: the start of its first prompt. */
export function prompt_title(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  return line.length > SESSION_TITLE_LIMIT ? `${line.slice(0, SESSION_TITLE_LIMIT)}…` : line;
}

/**
 * One page of stored conversations for a browsing window. `files` are the logs newest first (`{file, id, updated_at,
 * size}`); `describe(file)` reads one into `{id, title, cwd, updated_at, size}`, or null for a log that is not a
 * conversation the owner can resume. `query` keeps those whose title, directory or ID contains it; `accept(cwd)` keeps
 * those the asker may see. Returns `{sessions, next_offset}`; `next_offset` is null once every log was looked at.
 */
export function page_sessions(files, describe, { query = '', offset = 0, limit = SESSION_PAGE_SIZE, accept = null } = {}) {
  const needle = String(query).trim().toLowerCase();
  const sessions = [];
  let index = offset;
  for (let scanned = 0; index < files.length && sessions.length < limit && scanned < SESSION_SCAN_LIMIT; index++, scanned++) {
    let found = null;
    try { found = describe(files[index]); } catch { /* A log being written or in another shape is not listed. */ }
    if (!found || (accept && !accept(found.cwd))) continue;
    if (needle && ![found.title, found.cwd, found.id].some(text => String(text || '').toLowerCase().includes(needle))) continue;
    sessions.push(found);
  }
  return { sessions, next_offset: index < files.length ? index : null };
}

/**
 * The end of a conversation for a preview: `message(entry)` turns one log entry into `{role: 'user'|'assistant', text,
 * at}` or null. Returns the last messages, each cut to a readable length; `truncated` says earlier ones were left out.
 */
export function preview_messages(file, message) {
  const fd = openSync(file, 'r');
  let entries, partial;
  try {
    const size = fstatSync(fd).size, length = Math.min(size, PREVIEW_TAIL_BYTES);
    partial = length < size;
    entries = range_entries(fd, size - length, length);
  } finally { closeSync(fd); }
  return trim_preview(entries.map(message).filter(Boolean), partial);
}

/** The last preview messages, each cut to a readable length; `partial` says earlier ones were not read at all. */
export function trim_preview(messages, partial = false) {
  return { truncated: partial || messages.length > PREVIEW_MESSAGES, messages: messages.slice(-PREVIEW_MESSAGES).map(item => item.text.length > PREVIEW_TEXT_LIMIT
    ? { ...item, text: item.text.slice(0, PREVIEW_TEXT_LIMIT), cut: true } : item) };
}

const QUERY_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;

/** Return only model identifiers, display names and supported effort values. */
export function model_entry(id, label, efforts) {
  if (typeof id !== 'string' || !MODEL_PATTERN.test(id)) return null;
  return { id, label: typeof label === 'string' && label.trim() ? label : id,
    ...(Array.isArray(efforts) ? { efforts: [...new Set(efforts.filter(item => typeof item === 'string'))] } : {}) };
}

/** Ignore non-protocol diagnostics while leaving malformed or missing catalogs visibly unavailable. */
export function json_line(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/**
 * Read one catalog through the software's own CLI without an agent turn: `args` start it noninteractively and
 * `reader(send, finish)` speaks its protocol. Its temporary process is killed on every outcome; size and time are bounded.
 */
export function query_catalog(profile, args, reader, options = {}) {
  return new Promise((resolve_result, reject) => {
    const label = options.catalog_label || '模型';
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const child = (options.spawn || spawn)(profile.executable, args, {
      cwd: options.cwd || tmpdir(), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false, bytes = 0;
    const finish = (error, models) => {
      if (finished) return;
      finished = true; clearTimeout(timer); lines.close(); child.stdin.destroy(); child.kill();
      if (error) reject(error); else resolve_result(models);
    };
    const timer = setTimeout(() => finish(new Error(`读取${label}列表超时，请检查软件登录和网络后重试`)), options.timeout_ms ?? QUERY_TIMEOUT_MS);
    const lines = createInterface({ input: child.stdout });
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    const receive = reader(send, finish);
    child.once('error', () => finish(new Error(`无法启动${label}查询，请检查 CLI 路径`)));
    child.stdin.on('error', () => finish(new Error(`${label}查询连接已关闭`)));
    child.stderr.on('data', () => {}); // CLI diagnostics can contain private account or configuration data.
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) finish(new Error(`${label}目录响应超出大小限制`));
    });
    lines.on('line', line => {
      if (finished) return;
      try { receive.line(line); } catch { finish(new Error(`软件${label}目录格式无法识别，请检查 CLI 版本`)); }
    });
    child.once('close', code => {
      if (!finished && code === 0 && receive.complete) finish(null, receive.complete());
      else if (!finished) finish(new Error(`软件未返回${label}目录（退出码 ${code ?? '未知'}），请检查版本、登录与网络`));
    });
    receive.start();
  });
}

/**
 * The Unix second of the next time a usage limit resets, from a clock time as a software writes it ("3pm",
 * "2:30pm (America/Los_Angeles)", "15:00"), in its named time zone or this computer's; 0 when the text is not such a
 * time. For the `reset_at` of a `quota` failure (`on_failure(reason, {failure_class, resets, reset_at})`), so the room
 * holds the member until then instead of a fixed while.
 */
export function clock_reset_at(text, now = Date.now()) {
  const match = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?\s*$/i.exec(String(text || ''));
  if (!match) return 0;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0), half = match[3]?.toLowerCase();
  if (half ? hour < 1 || hour > 12 : hour > 23) return 0;
  if (half) hour = hour % 12 + (half === 'pm' ? 12 : 0);
  const zone = match[4] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let parts;
  try { parts = zone_parts(now, zone); } catch { return 0; }
  for (const day of [0, 1]) {
    const wall = Date.UTC(parts.year, parts.month - 1, parts.day + day, hour, minute);
    // The zone's offset at that wall time, read back from the zone itself (daylight saving included).
    const guess = wall - zone_offset(wall, zone);
    const at = wall - zone_offset(guess, zone);
    if (at > now) return Math.floor(at / 1000);
  }
  return 0;
}

function zone_parts(instant, zone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(instant).map(part => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

/** Milliseconds the zone's wall clock is ahead of UTC at this instant. */
function zone_offset(instant, zone) {
  const parts = zone_parts(instant, zone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(instant / 1000) * 1000;
}

/**
 * Remove one session's own files and folders, then check nothing is left. Files the software shares between sessions
 * (indexes, prompt histories, databases) are never rewritten here; adapters report them as kept.
 *
 * @param {string[]} paths Files or folders holding only this session; missing ones are skipped.
 * @returns {number} How many files and folders were removed.
 * @throws When a path is still there (held by a running program, say).
 */
export function remove_session_files(paths) {
  let removed = 0;
  for (const path of paths.filter(path => path && existsSync(path))) {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    if (existsSync(path)) throw new Error(`会话文件仍在：${path}`);
    removed += 1;
  }
  return removed;
}

/** Kinds and states of the background work an adapter reports; the website and pages know only these. */
export const BACKGROUND_KINDS = ['agent', 'command', 'monitor', 'schedule'];
export const BACKGROUND_STATES = ['running', 'done', 'failed', 'stopped'];
/** At most this many items, and this long a title: the newest items are kept. */
export const MAX_BACKGROUND_TASKS = 20;
export const MAX_BACKGROUND_TITLE = 120;

/**
 * The background work one execution's software left running or finished (sub-agents, background commands, monitors,
 * schedules), as one generic list `[{id, kind, title, state, started_at, ended_at, next_at, schedule}]` (times in ms,
 * 0 when unknown), passed to `task.on_background_tasks(list)` whenever it changes. Adapters fill it from whatever their
 * software reports; the product layer never learns which software it was.
 */
export class BackgroundTasks {
  constructor(task) { this.task = task; this.items = new Map(); this.sent = ''; }
  /** Add or update one item by the adapter's own key; a missing field keeps its earlier value. */
  set(id, fields) {
    if (!this.task.on_background_tasks || !id) return;
    const earlier = this.items.get(id) || { id: String(id), kind: 'command', title: '', state: 'running', started_at: 0, ended_at: 0, next_at: 0, schedule: '' };
    const item = { ...earlier, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    item.title = String(item.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_BACKGROUND_TITLE).replace(/[\uD800-\uDBFF]$/, '');
    item.schedule = String(item.schedule || '').slice(0, MAX_BACKGROUND_TITLE);
    if (item.state !== 'running' && !item.ended_at) item.ended_at = Date.now();
    this.items.delete(id);
    this.items.set(id, item);
    while (this.items.size > MAX_BACKGROUND_TASKS) this.items.delete(this.items.keys().next().value);
    this.report();
  }
  /** End one item that is still running. */
  end(id, state, at = Date.now()) {
    if (this.items.get(id)?.state === 'running') this.set(id, { state, ended_at: at });
  }
  has(id) { return this.items.has(id); }
  list() { return [...this.items.values()]; }
  report() {
    const list = this.list(), text = JSON.stringify(list);
    if (text === this.sent) return;
    this.sent = text;
    this.task.on_background_tasks?.(list);
  }
}

/** The state a task notification's status means: completed, failed, or stopped (killed). */
export function background_state(status) {
  return status === 'completed' ? 'done' : status === 'failed' ? 'failed' : ['killed', 'stopped', 'cancelled'].includes(status) ? 'stopped' : 'done';
}
