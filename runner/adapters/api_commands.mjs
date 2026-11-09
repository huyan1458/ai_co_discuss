/**
 * The `run_command` tool of a model API member: it runs only commands the room's workflow registered in
 * `commands.json`, never a command line the model writes. The model picks a command by ID and, when the command says
 * what it means, passes one path inside the project.
 *
 * The result follows the pwsh / bash tools of DeepSeek Harness (packages/shell/tool-pwsh/src/render.ts and the
 * pwsh-local executor defaults), https://github.com/deepseek-ai/deepseek-harness at fcc0ad4, MIT License,
 * Copyright (c) 2026 DeepSeek: stdout, then a `[stderr]` section, `(no output)` when both are empty, then
 * `[timed out after Nms]` and `[exit code: N]` markers, each on its own line, the exit marker last; a non-zero exit is
 * reported, not an error. Each stream keeps its last 64,000 bytes. Differences: no shell, so the workflow's argument
 * list is passed as is; no background jobs and no sandbox; the timeout is the command's own; a cut stream is noted
 * instead of saved to a spill file.
 */
import { spawn } from 'node:child_process';
import { project_path } from './api_files.mjs';
import { kill_process_tree } from './common.mjs';

const MAX_OUTPUT_BYTES = 64_000;
const TOOL_NAME = 'run_command';

/** The commands this member may run: read-only ones always, ones that change files only with write access. */
function usable(commands, project) {
  if (!project || !commands?.list?.length) return [];
  return commands.list.filter(item => item.access === 'read' || project.writable);
}

/** The tool definition, or nothing when the room's workflow registers no command this member may run. */
export function command_tools(commands, project) {
  const list = usable(commands, project);
  if (!list.length) return [];
  const lines = list.map(item => `- ${item.id}: ${item.description}${item.path ? `（path：${item.path}）` : ''}`).join('\n');
  return [{ name: TOOL_NAME, description: `Run one command the room's workflow registered and return its stdout/stderr. `
    + `You cannot change the command line; a command that takes a path gets it through \`path\`. `
    + `Long output keeps its tail. A non-zero exit code is reported, not an error.\nCommands:\n${lines}`,
  parameters: { type: 'object', additionalProperties: false, required: ['command'], properties: {
    command: { type: 'string', enum: list.map(item => item.id), description: 'ID of the registered command.' },
    path: { type: 'string', description: 'Only for a command that takes a path: an existing file or directory, relative to the project directory.' },
  } } }];
}

/** Whether a tool name is this module's. */
export function is_command_tool(name) { return name === TOOL_NAME; }

/** Whether a member may run a command that changes files, so its file tools no longer list every edit. */
export function runs_write_commands(commands, project) {
  return usable(commands, project).some(item => item.access === 'write');
}

/** Keep a stream's last bytes as they arrive. */
function collector() {
  let chunks = [], size = 0, truncated = false;
  return {
    add(chunk) {
      chunks.push(chunk);
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES * 2) return;
      const joined = Buffer.concat(chunks);
      chunks = [joined.subarray(joined.length - MAX_OUTPUT_BYTES)];
      size = MAX_OUTPUT_BYTES;
      truncated = true;
    },
    text() {
      const joined = Buffer.concat(chunks);
      const cut = joined.length > MAX_OUTPUT_BYTES;
      const body = new TextDecoder('utf-8').decode(cut ? joined.subarray(joined.length - MAX_OUTPUT_BYTES) : joined);
      return truncated || cut ? `[output truncated; showing the last ${MAX_OUTPUT_BYTES} bytes]\n${body}` : body;
    },
  };
}

/** Shape a finished run into the text the model sees, as DeepSeek Harness's shell tools do. */
export function render_result({ stdout, stderr, exit_code, signal, timed_out, timeout_ms }) {
  let body = stdout;
  if (stderr) {
    if (body && !body.endsWith('\n')) body += '\n';
    body += `[stderr]\n${stderr}`;
  }
  if (!body) body = '(no output)';
  const markers = [];
  if (timed_out) markers.push(`[timed out after ${timeout_ms}ms]`);
  if (signal) markers.push(`[killed by signal: ${signal}]`);
  else if (exit_code !== 0) markers.push(`[exit code: ${exit_code}]`);
  return markers.length ? `${body.replace(/\n$/, '')}\n${markers.join('\n')}` : body;
}

/** The argument list with `{workflow}`, `{project}` and `{path}` filled in. */
function command_line(command, commands, project, path) {
  return command.run.map(arg => arg.replaceAll('{workflow}', commands.directory).replaceAll('{project}', project.root).replaceAll('{path}', path));
}

/**
 * Run one registered command in the project directory. A refused or failed call returns its reason to the model.
 * @param {{root: string, writable: boolean}} project - the member's project, from `open_project`.
 * @param {{directory: string, list: object[]}} commands - the workflow folder and its parsed commands.
 * @param {{command?: string, path?: string}} args - the model's arguments.
 * @param {AbortSignal} [signal] - stops the command when the execution is stopped.
 * @returns {Promise<string | {error: string}>}
 */
export function run_command(project, commands, args, signal) {
  const command = usable(commands, project).find(item => item.id === args.command);
  if (!command) return Promise.resolve({ error: `"${args.command}" is not a command registered for you; use one of the listed IDs` });
  let path = '';
  if (command.path) {
    if (typeof args.path !== 'string' || !args.path.trim()) return Promise.resolve({ error: `"${command.id}" needs path: ${command.path}` });
    try { path = project_path(project, args.path); } catch (error) { return Promise.resolve({ error: error.message }); }
  } else if (args.path !== undefined) return Promise.resolve({ error: `"${command.id}" takes no path` });
  const [program, ...rest] = command_line(command, commands, project, path);
  const timeout_ms = command.timeout_seconds * 1000;
  return new Promise(settle => {
    const stdout = collector(), stderr = collector();
    let timed_out = false, done = false;
    const child = spawn(program, rest, { cwd: project.root, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => kill_process_tree(child, () => child.kill());
    const timer = setTimeout(() => { timed_out = true; stop(); }, timeout_ms);
    signal?.addEventListener('abort', stop, { once: true });
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      settle(value);
    };
    child.stdout.on('data', chunk => stdout.add(chunk));
    child.stderr.on('data', chunk => stderr.add(chunk));
    child.on('error', error => finish({ error: `cannot run "${program}": ${error.message}` }));
    child.on('close', (exit_code, kill_signal) => finish(render_result({ stdout: stdout.text(), stderr: stderr.text(),
      exit_code, signal: timed_out ? null : kill_signal, timed_out, timeout_ms })));
  });
}
