#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for a confined task (`task.tool_lockdown`): a Bash or PowerShell command runs only when it
 * is one plain `codiscuss <listed subcommand> …` call. Claude Code 2.1.332 approves its own read-only commands (`echo`,
 * `whoami`, `hostname`, `date`, `netstat`, `Write-Output`, `Get-Location`, and `ls` / `cat` inside the working
 * directories) whatever the allow list and permission mode say (measured 2026-11-27, Ref_外部软件通信.md §2.11); a hook's
 * refusal is the one check that comes before that, and it is our own code.
 *
 * Input: the hook event as JSON on standard input (`tool_name`, `tool_input.command`). Output: exit 0 lets Claude's own
 * permission rules decide (which still allow only the codiscuss subcommands); exit 2 refuses the call, its standard
 * error going back to the model. Anything unreadable is refused.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { TASK_SUBCOMMANDS } from '../expert_prompts.mjs';

/**
 * The characters an argument may hold, quoted or not (#15153, #15154): ASCII letters and digits, `_ - . / : = , + #`,
 * and any non-ASCII character except white space and the curly quotes PowerShell takes as quote marks. Everything
 * else is refused even inside quotes, because on Windows the line may reach cmd.exe through `codiscuss.cmd`, which reads
 * `& | < > ( ) ^ % !` inside quoted text again; such text goes in a draft file passed with `--body-file`.
 */
const SAFE = String.raw`[A-Za-z0-9_\-./:=,+#]|[^\x00-\x7F\s‘-‟]`;
/**
 * An unquoted word: safe characters only, no backslash (Bash reads it as an escape), not starting with `#` (a comment).
 * Three more forms reach a program changed when PowerShell calls `codiscuss.ps1` (measured 2026-11-27): a comma (`甲,乙`
 * arrives as `甲 乙`), a lone `--` (dropped) and `-name:value` (split in two); they must be quoted.
 */
const BARE = new RegExp(String.raw`^(?!#)(?!--$)(?!-[^,]*:)(?:(?!,)${SAFE})+$`, 'u');
/**
 * The inside of a quoted string: safe characters, spaces, and single backslashes as in a Windows path, never two in a
 * row and never last (where Bash reads an escaped quote and PowerShell 5.1 passes a broken quote on). Not empty:
 * PowerShell 5.1 drops an empty argument when it calls a program.
 */
const QUOTED = new RegExp(String.raw`^(?:${SAFE}| |\\(?![\\]))+$`, 'u');

/**
 * Split a command line into words, each a bare word, a quoted string, or a bare `--name=` followed by one quoted
 * string; returns null for anything else (a quote left open, quoted parts joined to more text, other characters,
 * white space other than plain spaces).
 */
export function literal_words(command) {
  const text = String(command ?? '').trim();
  if (!text || /[^\S ]/.test(text)) return null;
  const words = [];
  for (const raw of text.match(/(?:[^ '"]+|'[^']*'|"[^"]*")+|['"]/g) || []) {
    const quote = raw.search(/['"]/);
    const head = quote < 0 ? raw : raw.slice(0, quote), tail = quote < 0 ? '' : raw.slice(quote);
    if (head && !BARE.test(head)) return null;
    if (!tail) { words.push(head); continue; }
    if (head && !head.endsWith('=')) return null;
    const inner = tail.slice(1, -1);
    if (tail.length < 2 || tail.at(-1) !== tail[0] || !QUOTED.test(inner) || inner.endsWith('\\')) return null;
    words.push(head + inner);
  }
  return words;
}

/**
 * Whether a command line is one call of a listed codiscuss subcommand whose every argument is a literal value in both
 * Bash and PowerShell: no variable prefix, no other program, nothing a shell would expand, substitute, glob or chain.
 * Text with such symbols goes in a draft file and is passed with `--body-file`, as the participant skill already says.
 * @param {string} command The Bash or PowerShell command line.
 * @returns {boolean}
 */
export function allowed_command(command) {
  const words = literal_words(command);
  if (!words || !['codiscuss', 'codiscuss.cmd'].includes(words[0])) return false;
  return TASK_SUBCOMMANDS.some(sub => sub.split(' ').every((part, index) => words[index + 1] === part));
}

/** Decide one hook event; returns the exit code and the message for a refusal. */
export function decide(event) {
  if (!['Bash', 'PowerShell'].includes(event?.tool_name)) return { code: 0, message: '' };
  if (allowed_command(event.tool_input?.command)) return { code: 0, message: '' };
  return { code: 2, message: `本次运行已收窄，只能运行单独一条 codiscuss 子命令（${TASK_SUBCOMMANDS.join('、')}）。`
    + '参数不论在不在引号里，只能含字母、数字、中文等非 ASCII 字符和 _ - . / : = , + #；空格和单个反斜杠只能在引号里。'
    + '正文含其他符号（如 & | < > ( ) ^ % ! ; $ 反引号、中文引号）时，写进草稿目录的文件，用 --body-file 传入 / '
    + 'This run is restricted to one codiscuss subcommand. Arguments, quoted or not, may hold only letters, digits, non-ASCII text '
    + 'and _ - . / : = , + #; spaces and single backslashes only inside quotes. Put text with any other symbol in a draft file and pass it with --body-file' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let event = null;
  try { event = JSON.parse(readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { /* Refused below. */ }
  const { code, message } = event ? decide(event) : { code: 2, message: 'unreadable hook input' };
  if (message) process.stderr.write(`${message}\n`);
  process.exitCode = code;
}
