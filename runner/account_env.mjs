#!/usr/bin/env node
/**
 * The AI environment of the Windows user this runs as: one skills folder shared by Claude Code, Codex and Antigravity,
 * laid out the way the computer owner's own is, and the prompt CoDiscuss sends to every member of this account.
 *
 *   skills   ~/.agents/skills (Codex reads it as is); ~/.claude/skills is a junction to it; Antigravity lists it in
 *            ~/.gemini/config/skills.json.
 *   prompt   the account's prompt for all members, `system_prompts.program` in launch-settings.json of its service home
 *            (request.home), sent only to members CoDiscuss wakes (user 2026-11-25). Earlier versions wrote it into
 *            ~/.codex/AGENTS.md with ~/.claude/CLAUDE.md and ~/.gemini/config/AGENTS.md as hard links; init and prompt
 *            move such a text to the account's prompt, keep a copy in the service home and remove those files.
 *
 * The management panel runs this as a hosted account's own Windows user, from the shared copy of this program, because
 * that user's files are its own and the owner cannot reach them. Usage: node account_env.mjs <action> <job folder>, the job
 * folder holding request.json; prints one JSON line.
 *   init     lay out the folders, set the prompt if there is none (request.prompt), install the discussion skills
 *            (an edited copy is kept) and the shipped workflows the instance lacks (request.home, its service home).
 *   status   the skills installed, the prompt, and whether the layout is complete.
 *   skills   install the skill folders in <job>/skills/ (replacing a copy of the same name) and remove request.remove.
 *   prompt   save request.prompt as the account's prompt for all members.
 *   direct   create (request.site, the owner's domain) or remove (request.remove) the direct identity of the service
 *            home request.home, with which external members reach this account on that domain; sealed for this user.
 *   site     bind the service home request.home to the online site request.site with the one-time child token
 *            request.setup_key, or remove that binding (request.unbind); the binding file is sealed for this user.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { SKILLS, install_skills, install_workflows, remove_legacy_skills, shipped_workflows } from './discussion_skills.mjs';
import { workflow_directory } from './workflows.mjs';

const HOME = homedir();
const SKILLS_DIR = join(HOME, '.agents', 'skills');
const CLAUDE_SKILLS = join(HOME, '.claude', 'skills');
const AGY_SKILL_CONFIG = join(HOME, '.gemini', 'config', 'skills.json');
// A folder an earlier version of the panel filled with its own copies; they move into the shared folder.
const OLD_AGY_SKILLS = join(HOME, '.gemini', 'config', 'skills');
const PROMPT = join(HOME, '.codex', 'AGENTS.md');
const PROMPT_LINKS = [join(HOME, '.claude', 'CLAUDE.md'), join(HOME, '.gemini', 'config', 'AGENTS.md')];
// Where a moved prompt's text is kept, in the service home, one copy per distinct file.
const PROMPT_BACKUPS = { [PROMPT]: 'account-prompt-backup.md', [PROMPT_LINKS[0]]: 'account-prompt-backup-claude.md',
  [PROMPT_LINKS[1]]: 'account-prompt-backup-gemini.md' };
const RECORD = 'skills-manifest.json';
// Starts with a letter, digit or underscore: "." and ".." would name the folder above when joined and removed.
const SKILL_NAME = /^\w[\w.-]{0,63}$/;

// ---- Layout ----

function is_link(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** Make ~/.claude/skills a junction to the shared folder, first moving in anything a real folder there held. */
function link_claude_skills() {
  if (is_link(CLAUDE_SKILLS) && resolve(readlinkSync(CLAUDE_SKILLS)).toLowerCase() === resolve(SKILLS_DIR).toLowerCase()) return;
  if (existsSync(CLAUDE_SKILLS) && !is_link(CLAUDE_SKILLS)) {
    for (const name of readdirSync(CLAUDE_SKILLS)) {
      const target = join(SKILLS_DIR, name);
      if (!existsSync(target)) renameSync(join(CLAUDE_SKILLS, name), target);
    }
    rmSync(CLAUDE_SKILLS, { recursive: true, force: true });
  } else if (is_link(CLAUDE_SKILLS)) unlinkSync(CLAUDE_SKILLS);
  mkdirSync(dirname(CLAUDE_SKILLS), { recursive: true });
  // A junction needs no administrator rights, unlike a symbolic link.
  symlinkSync(SKILLS_DIR, CLAUDE_SKILLS, 'junction');
}

/** List the shared folder in Antigravity's skills.json, keeping any other entries. */
function list_for_agy() {
  let config = {};
  try { config = JSON.parse(readFileSync(AGY_SKILL_CONFIG, 'utf8')); } catch { config = {}; }
  const entries = Array.isArray(config.entries) ? config.entries : [];
  const path = SKILLS_DIR.replaceAll('\\', '/');
  if (entries.some(entry => String(entry?.path || '').replaceAll('\\', '/').toLowerCase() === path.toLowerCase())) return;
  mkdirSync(dirname(AGY_SKILL_CONFIG), { recursive: true });
  writeFileSync(AGY_SKILL_CONFIG, `${JSON.stringify({ ...config, entries: [...entries, { path }] }, null, 2)}\n`);
}

/** The administrator's prompt for every member of the account, from its service home; null while never set. */
async function managed_prompt(home) {
  if (!home) return null;
  const { launch_settings } = await import('./discussion_launch.mjs');
  const prompts = launch_settings(home).system_prompts || {};
  return Object.hasOwn(prompts, 'managed') ? prompts.managed : null;
}

async function save_managed(home, text) {
  const { save_managed_prompt } = await import('./discussion_launch.mjs');
  save_managed_prompt(home, text);
}

/**
 * Move a prompt an earlier version wrote into the software's own files to the administrator's prompt (unless one was
 * set), keep a copy of every distinct file beside it and remove the files, which plain AI windows would also read. The
 * three were hard links to one file, but a program saving by replacement breaks the link, so each is read on its own.
 */
async function migrate_prompt(home) {
  const files = [PROMPT, ...PROMPT_LINKS].filter(path => existsSync(path));
  if (!files.length) return;
  const seen = new Set();
  let first = '';
  for (const path of files) {
    const id = lstatSync(path).ino;
    if (seen.has(id)) continue;
    seen.add(id);
    const text = readFileSync(path, 'utf8').trim();
    if (!text) continue;
    writeFileSync(join(home, PROMPT_BACKUPS[path]), `${text}\n`);
    first ||= text;
  }
  if (first && await managed_prompt(home) === null) await save_managed(home, first);
  for (const path of files) rmSync(path, { force: true });
}

function layout_status() {
  let agy = false;
  try { agy = JSON.parse(readFileSync(AGY_SKILL_CONFIG, 'utf8')).entries.some(entry => String(entry.path).replaceAll('\\', '/').toLowerCase() === SKILLS_DIR.replaceAll('\\', '/').toLowerCase()); } catch { agy = false; }
  return { skills_folder: existsSync(SKILLS_DIR), claude_linked: is_link(CLAUDE_SKILLS), agy_listed: agy };
}

// ---- Actions ----

async function init(request) {
  mkdirSync(SKILLS_DIR, { recursive: true });
  const record = join(request.home, RECORD);
  // Copies an earlier version put in Antigravity's own folder go, unless someone edited them; the shared folder has them.
  remove_legacy_skills(OLD_AGY_SKILLS, record);
  link_claude_skills();
  list_for_agy();
  await migrate_prompt(request.home);
  // The default only where none was ever set: a prompt the administrator cleared stays cleared.
  if (request.prompt && await managed_prompt(request.home) === null) await save_managed(request.home, request.prompt);
  const results = install_skills(SKILLS_DIR, record);
  const missing = shipped_workflows().map(item => item.name).filter(name => !existsSync(workflow_directory(request.home, name)));
  const workflows = (missing.length ? install_workflows(request.home, missing) : []).map(({ name, status }) => ({ name, status }));
  return { skills: results.map(({ name, status }) => ({ name, status })), workflows, layout: layout_status() };
}

/** A skill's one-line description, from the front matter of its SKILL.md. */
function describe(folder) {
  try {
    const text = readFileSync(join(folder, 'SKILL.md'), 'utf8');
    return text.match(/^description:\s*(.+)$/m)?.[1].replace(/^["']|["']$/g, '').trim().slice(0, 200) || '';
  } catch { return ''; }
}

async function status(request) {
  // Hidden folders (Codex keeps its own under .system) are not skills of this account.
  const skills = existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, discussion: SKILLS.includes(entry.name), description: describe(join(SKILLS_DIR, entry.name)) })) : [];
  return { skills, prompt: await managed_prompt(request.home) || '', layout: layout_status() };
}

function skills(job, request) {
  mkdirSync(SKILLS_DIR, { recursive: true });
  const incoming = join(job, 'skills'), installed = [], removed = [];
  for (const name of existsSync(incoming) ? readdirSync(incoming) : []) {
    if (!SKILL_NAME.test(name)) continue;
    rmSync(join(SKILLS_DIR, name), { recursive: true, force: true });
    cpSync(join(incoming, name), join(SKILLS_DIR, name), { recursive: true });
    installed.push(name);
  }
  for (const name of Array.isArray(request.remove) ? request.remove : []) {
    if (!SKILL_NAME.test(name) || !existsSync(join(SKILLS_DIR, name))) continue;
    rmSync(join(SKILLS_DIR, name), { recursive: true, force: true });
    removed.push(name);
  }
  return { installed, removed };
}

async function prompt(request) {
  await migrate_prompt(request.home);
  await save_managed(request.home, request.prompt);
  return { ok: true, layout: layout_status() };
}

/** Bind or unbind this user's service home on the online site; the panel gave a one-time child token. */
async function site(request) {
  const { bind_machine, save_site_connection } = await import('./discussion_local.mjs');
  if (request.unbind) { save_site_connection(request.home, request.site); return { ok: true }; }
  return { machine: await bind_machine(request.home, request.site, request.setup_key) };
}

/** Create or remove this user's direct identity; the panel records which computer id is which account. */
async function direct(request) {
  const { create_direct_link, remove_direct_link } = await import('./remote_launch.mjs');
  if (request.remove) { remove_direct_link(request.home); return { ok: true }; }
  return { machine: create_direct_link(request.home, request.site).id };
}

async function main() {
  const [action, job] = process.argv.slice(2);
  const path = join(job, 'request.json');
  const request = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // The job folder is the owner's; the request goes when the owner removes it.
  try { rmSync(path, { force: true }); } catch { /* removed with the job folder */ }
  const run = { init, status, skills: () => skills(job, request), prompt, site, direct }[action];
  if (!run) throw new Error(`未知操作：${action}`);
  process.stdout.write(`${JSON.stringify(await run(request))}\n`);
}

main().catch(error => { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; });
