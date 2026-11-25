/**
 * Pi extension loaded into the `pi --mode rpc` process of one model API execution (api_pi.mjs starts it). It registers
 * the member's provider and exactly the tools the old in-runner loop offered: room tools bound to this execution,
 * project file tools, registered commands and image tools (api.mjs, api_files.mjs, api_commands.mjs, api_images.mjs).
 * A writable member also has Pi's own read, bash, edit and write in place of our file tools and registered commands;
 * otherwise Pi's built-in tools are off, so the model has no shell and every path still goes through our checks.
 *
 * Input: `CODISCUSS_PI_CONTEXT` names the execution's private context file; `CODISCUSS_PI_KEY` holds the API key, which
 * the model never sees. Output to the runner: each tool result's `details.codiscuss` says whether it saved the answer
 * (`terminal`) or hit an uncertain write that must end the run (`fatal`).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_SUBCOMMANDS } from '../expert_prompts.mjs';
import { execute_tool, extension_context, participant_tools, wrap_up_note } from './api.mjs';
import { PI_PROVIDER, pi_provider } from './api_pi.mjs';
import { web_tools } from './api_web.mjs';

const NEVER = new AbortController().signal;

// A read-only run's shell may only run the codiscuss subcommands, and only as one plain command: the same symbols a CLI
// member's read-only run refuses (expert_prompts.mjs INLINE_BODY_RULE), so no command can be chained onto one.
const SHELL_SYMBOLS = /[`()$;&|<>\r\n]/;

// Pi's own tool path rules (dist/utils/paths.js normalizePath, as its tools call it): unicode spaces, a leading @,
// Git Bash drive paths (/c/…, /mnt/c/…, /cygdrive/c/…), ~ for the home folder and file:// URLs.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * The absolute path a Pi tool would open for the path the model gave, as Pi's tools compute it, with links and
 * junctions followed so a folder linked from inside the project cannot reach outside it. For a path not there yet,
 * its nearest existing parent is followed.
 */
export function pi_tool_path(given, cwd = process.cwd(), platform = process.platform, home = homedir()) {
  let path = String(given ?? '').replace(UNICODE_SPACES, ' ');
  if (path.startsWith('@')) path = path.slice(1);
  if (platform === 'win32' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\')) {
    const drive = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (drive) path = `${drive[1].toUpperCase()}:\\${(drive[2] || '').replaceAll('/', '\\')}`;
  }
  if (path === '~') path = home;
  else if (path.startsWith('~/') || (platform === 'win32' && path.startsWith('~\\'))) path = join(home, path.slice(2));
  if (/^file:\/\//.test(path)) path = fileURLToPath(path);
  return real(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
}

/** A path with its links followed, through its nearest existing parent when it does not exist yet. */
function real(path) {
  try { return realpathSync.native(path); } catch { /* Not there yet. */ }
  const parent = dirname(path);
  return parent === path ? path : join(real(parent), basename(path));
}

/** Whether an absolute path lies in one of the folders. */
function inside(target, folders) {
  return folders.some(folder => { const rest = relative(real(resolve(folder)), target); return !rest.startsWith('..') && !isAbsolute(rest); });
}

/**
 * Check the path a file tool would open and hand Pi that same absolute path, so the path checked and the path opened
 * are one string. Tools without a path (grep, find or ls in the working folder) are checked against the working folder.
 */
function checked_path(input, folders) {
  const field = Object.hasOwn(input, 'path') ? 'path' : Object.hasOwn(input, 'file_path') ? 'file_path' : '';
  const target = pi_tool_path(field ? input[field] : '.');
  if (!inside(target, folders)) return false;
  if (field) input[field] = target;
  return true;
}

/**
 * A read-only member (user 2026-11-25, as Claude's read-only level does with its permission rules): writes and edits only
 * in its draft and writable extra folders, its shell only `codiscuss <subcommand> …` without shell symbols; reading
 * stays free. A refused call goes back to the model with the reason.
 */
// Pi's reading tools; a read-only run may use only these, the checked writes and shell, and the tools we register.
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);

function confined_call(confine, event) {
  const input = event.input || {};
  // Reading is held to what Claude's read-only level may read (claude_permissions): the project, the extra folders, its
  // drafts and knowledge, the skills and its own runtime folder; never the service home with its keys and credentials.
  if (READ_TOOLS.has(event.toolName)) {
    return checked_path(input, confine.readable) ? undefined
      : { block: true, reason: '只读时只能读取项目、额外目录、草稿、技能与本成员自己的运行目录' };
  }
  if (['write', 'edit'].includes(event.toolName)) {
    return checked_path(input, confine.writable) ? undefined
      : { block: true, reason: '项目文件只读：只能写草稿目录（draft_directory）和可写的额外目录' };
  }
  if (['bash', 'powershell'].includes(event.toolName)) {
    const command = String(input.command || '').trim();
    const words = command.split(/\s+/);
    const allowed = words[0] === confine.cli && !SHELL_SYMBOLS.test(command)
      && TASK_SUBCOMMANDS.some(sub => `${words.slice(1, 1 + sub.split(' ').length).join(' ')}` === sub);
    return allowed ? undefined : { block: true, reason: `只读时命令只能是 ${confine.cli} 的 subcommands 子命令，且不能含反引号、英文括号、$、;、&、|、<、> 或换行；读文件用 read、grep、find、ls` };
  }
  // Any other tool, such as one a later Pi adds, is refused unless it is one of ours: a new writing tool cannot slip through.
  return confine.tools.includes(event.toolName) ? undefined : { block: true, reason: `只读时不能使用 ${event.toolName}` };
}

/** The model-facing text of one tool result: file tools return text, the rest JSON. */
function result_text(result) {
  return typeof result === 'string' ? result : JSON.stringify(result);
}

export default function codiscuss_room(pi) {
  const setup = JSON.parse(readFileSync(process.env.CODISCUSS_PI_CONTEXT, 'utf8'));
  const key = process.env.CODISCUSS_PI_KEY || '';
  // Pi's shell commands inherit this process's environment: the key leaves it once read, and the provider holds it.
  delete process.env.CODISCUSS_PI_KEY;
  const redact = text => (key ? String(text).replaceAll(key, '[已隐藏]') : String(text));
  const context = extension_context(setup, key);
  pi.registerProvider(PI_PROVIDER, pi_provider(setup.profile, setup.base_url, key));
  // A native run reaches the room through codiscuss and works with Pi's own tools; only web reading is added.
  const definitions = setup.native ? web_tools(context) : participant_tools(context);
  if (setup.confine) pi.on('tool_call', event => confined_call({ ...setup.confine, tools: definitions.map(item => item.name) }, event));
  for (const definition of definitions) {
    pi.registerTool({
      name: definition.name, label: definition.name, description: definition.description,
      promptSnippet: `${definition.name}: ${definition.description}`, parameters: definition.parameters,
      // Room writes and file edits keep the order the model gave them, as the in-runner loop ran them.
      executionMode: 'sequential',
      async execute(_id, params, signal, _on_update, ctx) {
        const edits = [];
        const call_context = { ...context, signal: signal || NEVER, on_edits: paths => edits.push(...paths) };
        try {
          const outcome = await execute_tool(call_context, { name: definition.name, arguments: params }, definitions);
          const terminal = Boolean(outcome.terminal);
          // An image read on demand goes with the result, through the same image input as the task's images.
          return { content: [{ type: 'text', text: redact(result_text(outcome.result)) }, ...(outcome.images || [])],
            details: { codiscuss: { terminal, ...(edits.length ? { edits } : {}) } },
            isError: Boolean(outcome.result?.error), terminate: terminal };
        } catch (error) {
          if (signal?.aborted) throw error;
          // An uncertain room write is never retried under a new submission: the run ends and the runner reports why.
          const reason = redact(error.message || error);
          ctx.abort();
          return { content: [{ type: 'text', text: reason }], details: { codiscuss: { fatal: reason } }, isError: true, terminate: true };
        }
      },
    });
  }
  // With few requests left, the model is told once per turn to submit what it has, as before.
  let turns = 0;
  let noted = 0;
  pi.on('turn_start', () => { turns += 1; });
  pi.on('tool_result', event => {
    const note = setup.native || noted === turns ? '' : wrap_up_note(context, turns);
    if (!note) return undefined;
    noted = turns;
    return { content: [...(event.content || []), { type: 'text', text: note }] };
  });
}
