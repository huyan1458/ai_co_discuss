#!/usr/bin/env node
/**
 * The AI environment of the Windows user this runs as: one skills folder and one system prompt shared by Claude Code,
 * Codex and Antigravity, laid out the way the computer owner's own is.
 *
 *   skills   ~/.agents/skills (Codex reads it as is); ~/.claude/skills is a junction to it; Antigravity lists it in
 *            ~/.gemini/config/skills.json.
 *   prompt   ~/.codex/AGENTS.md; ~/.claude/CLAUDE.md and ~/.gemini/config/AGENTS.md are hard links to the same file.
 *
 * The management panel runs this as a hosted account's own Windows user, from the shared copy of this program, because
 * that user's files are its own and the owner cannot reach them. Usage: node account_env.mjs <action> <job folder>, the job
 * folder holding request.json; prints one JSON line.
 *   init     lay out the folders, write the prompt if there is none (request.prompt), install the discussion skills
 *            (an edited copy is kept) and the shipped workflows the instance lacks (request.home, its service home).
 *   status   the skills installed, the prompt, and whether the layout is complete.
 *   skills   install the skill folders in <job>/skills/ (replacing a copy of the same name) and remove request.remove.
 *   prompt   write request.prompt as the system prompt of all three.
 */
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
const RECORD = 'skills-manifest.json';
const SKILL_NAME = /^[\w.-]{1,64}$/;

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

/** Make the two other prompt files hard links to the one prompt, keeping the prompt's text. */
function link_prompts(fallback = '') {
  mkdirSync(dirname(PROMPT), { recursive: true });
  if (!existsSync(PROMPT)) writeFileSync(PROMPT, fallback);
  for (const path of PROMPT_LINKS) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      if (lstatSync(path).ino === lstatSync(PROMPT).ino) continue;
      unlinkSync(path);
    }
    linkSync(PROMPT, path);
  }
}

function layout_status() {
  const prompt_inode = existsSync(PROMPT) ? lstatSync(PROMPT).ino : -1;
  let agy = false;
  try { agy = JSON.parse(readFileSync(AGY_SKILL_CONFIG, 'utf8')).entries.some(entry => String(entry.path).replaceAll('\\', '/').toLowerCase() === SKILLS_DIR.replaceAll('\\', '/').toLowerCase()); } catch { agy = false; }
  return { skills_folder: existsSync(SKILLS_DIR), claude_linked: is_link(CLAUDE_SKILLS), agy_listed: agy,
    prompt_linked: prompt_inode !== -1 && PROMPT_LINKS.every(path => existsSync(path) && lstatSync(path).ino === prompt_inode) };
}

// ---- Actions ----

function init(request) {
  mkdirSync(SKILLS_DIR, { recursive: true });
  const record = join(request.home, RECORD);
  // Copies an earlier version put in Antigravity's own folder go, unless someone edited them; the shared folder has them.
  remove_legacy_skills(OLD_AGY_SKILLS, record);
  link_claude_skills();
  list_for_agy();
  link_prompts(String(request.prompt || ''));
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

function status() {
  // Hidden folders (Codex keeps its own under .system) are not skills of this account.
  const skills = existsSync(SKILLS_DIR) ? readdirSync(SKILLS_DIR, { withFileTypes: true }).filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, discussion: SKILLS.includes(entry.name), description: describe(join(SKILLS_DIR, entry.name)) })) : [];
  return { skills, prompt: existsSync(PROMPT) ? readFileSync(PROMPT, 'utf8') : '', layout: layout_status() };
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

function prompt(request) {
  link_prompts();
  // Writing in place keeps the hard links: all three names point at this one file.
  writeFileSync(PROMPT, String(request.prompt || ''));
  return { ok: true, layout: layout_status() };
}

function main() {
  const [action, job] = process.argv.slice(2);
  const path = join(job, 'request.json');
  const request = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  // The job folder is the owner's; the request goes when the owner removes it.
  try { rmSync(path, { force: true }); } catch { /* removed with the job folder */ }
  const run = { init, status, skills: () => skills(job, request), prompt }[action];
  if (!run) throw new Error(`未知操作：${action}`);
  process.stdout.write(`${JSON.stringify(run(request))}\n`);
}

try { main(); } catch (error) { process.stdout.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
