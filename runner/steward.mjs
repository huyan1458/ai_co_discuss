import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { account_space } from './account_space.mjs';
import { adapter_profile } from './adapters/profiles.mjs';
import { api } from './discussion_runner.mjs';
import { local_settings } from './discussion_setup.mjs';
import { access_levels, PROJECT_ACCESS } from './expert_prompts.mjs';
import { resolve_locale, t } from './i18n.mjs';
import { parse_markdown } from './workflows.mjs';

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PARTICIPANT_SKILL = 'discuss-participant';
const CONFIRMATION_SKILLS = ['local-stt-setup', 'local-tts-setup', 'notify-setup', 'cloudflare-deploy'];
const SKILLS = ['dispatch-analysis', 'share-card', 'discuss-report', 'codiscuss-draft-cleanup', ...CONFIRMATION_SKILLS];
const FIELDS = ['adapter', 'model', 'effort', 'project_access', 'cwd', 'skills'];

/** Resolve only shipped steward skills in the package's dedicated directory. */
export function steward_skill(skill, project = PROJECT) {
  if (!SKILLS.includes(skill)) return '';
  const path = join(project, '.agents', 'steward-skills', skill, 'SKILL.md');
  return existsSync(path) && statSync(path).isFile() ? path : '';
}

/** Resolve local defaults without creating a directory or returning private software settings. */
export function steward_defaults(home, settings, project = PROJECT) {
  const saved = settings.steward || {};
  const adapter = saved.adapter || '';
  const [, profile = {}] = steward_software(settings, adapter);
  const available = SKILLS.filter(skill => steward_skill(skill, project));
  return {
    adapter, model: saved.model ?? profile.model ?? '', effort: saved.effort ?? profile.effort ?? '',
    project_access: saved.project_access || 'auto', cwd: saved.cwd || join(account_space(home).workspace, 'steward'),
    skills: saved.skills ?? available,
  };
}

/** Return skill availability separately from the owner's allowed IDs. */
export function steward_status(home, settings, room_id) {
  const view = steward_defaults(home, settings);
  return { configured: Boolean(view.adapter), room_id: room_id || null, settings: view,
    skills: SKILLS.map(id => ({ id, available: Boolean(steward_skill(id)), allowed: view.skills.includes(id) })) };
}

/** Require an explicit software choice before opening the room or starting any work. */
export function require_steward_software(view) {
  if (view.adapter) return;
  const template = '请先在“设置 → 平台主理人”选择软件';
  throw Object.assign(new Error(t(template)), { code: 'steward_not_configured', error_text: { template, params: {} } });
}

/** Reject disallowed or unavailable skills before starting anything on the computer. */
export function require_steward_skill(settings, skill, project = PROJECT) {
  if (!steward_skill(skill, project) || (settings.steward?.skills && !settings.steward.skills.includes(skill))) {
    throw new Error(t('平台主理人未获准使用技能，或本机未安装此技能：{skill}', { skill: String(skill ?? '') }));
  }
}

/** Validate a partial settings update, keeping private room bookkeeping outside the caller's input. */
export function steward_settings_patch(input) {
  const patch = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  const invalid = Object.entries(patch).some(([key, value]) => key !== 'skills' && typeof value !== 'string');
  if (invalid || (patch.adapter && !adapter_profile(patch.adapter)) || (patch.cwd && !isAbsolute(patch.cwd)) ||
      (patch.project_access && !PROJECT_ACCESS.includes(patch.project_access)) ||
      (Object.hasOwn(patch, 'skills') && patch.skills !== null &&
        (!Array.isArray(patch.skills) || patch.skills.some(skill => !SKILLS.includes(skill))))) {
    throw new Error(t('平台主理人设置无效'));
  }
  if (Array.isArray(patch.skills)) patch.skills = [...new Set(patch.skills)];
  return patch;
}

/** Build the ordinary user message, with the skill on its own first line. */
export function steward_message(skill, context, lang, confirmed = false) {
  const locale = /^en(?:-|$)/i.test(lang || '') ? 'en' : 'zh-CN';
  const instruction = t('请使用指定技能处理本次平台事务，并在这里交付结果。', {}, locale);
  const detail = context == null || context === '' ? '' : typeof context === 'string' ? context : JSON.stringify(context, null, 2);
  const confirmation = confirmed === true && CONFIRMATION_SKILLS.includes(skill)
    ? t('用户已确认本次安装、配置或部署。', {}, locale) : '';
  return [`/${skill}`, instruction, confirmation, detail && t('任务上下文：\n{context}', { context: detail }, locale)]
    .filter(Boolean).join('\n\n');
}

/** Advertise skill descriptions and paths, never the bodies of skills not named by the request. */
export function steward_task_catalog(config) {
  const settings_path = config.api_home && join(config.api_home, 'launch-settings.json');
  const allowed = settings_path && existsSync(settings_path)
    ? JSON.parse(readFileSync(settings_path, 'utf8')).steward?.skills ?? SKILLS : config.steward_skills || [];
  return SKILLS.filter(id => allowed.includes(id)).flatMap(id => {
    const path = steward_skill(id, config.project);
    if (!path) return [];
    const { fields } = parse_markdown(readFileSync(path, 'utf8'), path);
    return [{ id, description: String(fields.description || ''), path }];
  });
}

/** Preload only the allowed, locally available skill named on each request's first line. */
export function steward_task_skills(config, request_texts, catalog = steward_task_catalog(config)) {
  const root = join(config.project, '.agents', 'skills', PARTICIPANT_SKILL);
  const paths = new Map(catalog.map(({ id, path }) => [id, path]));
  const selected = request_texts.map(text => /^\/([a-z0-9-]+)[ \t]*(?:\r?\n|$)/.exec(text)?.[1])
    .map(skill => paths.get(skill)).filter(Boolean);
  return [join(root, 'SKILL.md'), join(root, 'references', 'room.md'), ...new Set(selected)];
}

/** Keep the steward on this account's own website, including when called through the paired-device relay. */
export function steward_site(home) {
  return `http://127.0.0.1:${local_settings(home).port || 8765}`;
}

/** Identify the configured platform behind the selected adapter, without opening its work directory. */
export function steward_software(settings, adapter) {
  const facts = adapter_profile(adapter);
  const entries = Object.entries(settings.participants || {});
  return facts ? entries.find(([, profile]) => profile.adapter === adapter) || entries.find(([name]) => name === facts.platform) || [] : [];
}

/** Resolve the single member's profile and do not inherit a conversation or directory from another room. */
export function steward_profile(home, settings, view, resolve_profile) {
  const [platform, saved] = steward_software(settings, view.adapter);
  if (!saved) throw new Error(t('请先配置平台主理人的本机软件'));
  const levels = access_levels(view.adapter);
  const access = view.project_access === 'auto' && !settings.steward?.project_access && !levels.includes('auto') ? 'read' : view.project_access;
  if (!access_levels(view.adapter).includes(access)) throw new Error(t('此软件不支持平台主理人所选的项目权限'));
  if (!settings.steward?.cwd) mkdirSync(view.cwd, { recursive: true });
  const { cwd, session_id, source_thread_id, project_name, project_id, allowed_tools, ...base } = saved;
  const profile = { ...base, adapter: view.adapter, cwd: view.cwd, model: view.model, effort: view.effort, project_access: access };
  return { platform, profile: resolve_profile(platform, {}, { participants: { [platform]: profile }, cwd: view.cwd, entry: 'web' }, false) };
}

/** Submit once as the user. Retries with the same submission ID use the server's ordinary deduplication. */
export async function post_steward_request(config, input) {
  const result = await api(config, '/messages', {
    author: '用户', submitted_by: '用户', kind: 'chat', text: steward_message(input.skill, input.context, input.lang, input.confirmed),
    queue: false, submission_id: input.submission_id || randomUUID(),
  });
  return { room_id: config.room, message_id: result.message?.id ?? result.id };
}

/** Parse the public CLI into the same local actions the browser calls. */
export async function steward_cli(args, dispatch) {
  const help = () => process.stdout.write(t('用法：codiscuss steward status | settings [--adapter ID --model MODEL --effort LEVEL --access LEVEL --cwd DIR --skills SKILL,...] | ask SKILL [--room ROOM --note TEXT --confirm] | history | delete ROOM --confirm') + '\n');
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, adapter: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    access: { type: 'string' }, cwd: { type: 'string' }, skills: { type: 'string' }, room: { type: 'string' },
    note: { type: 'string' }, confirm: { type: 'boolean' },
  } });
  const [command, target, ...extra] = positionals;
  if (!command || command === 'help' || values.help) return help();
  if (extra.length || (target && !['ask', 'delete'].includes(command))) throw new Error(t('平台主理人命令参数无效'));
  if (command === 'status') return dispatch('steward');
  if (command === 'history') return dispatch('steward-history', {});
  if (command === 'delete') {
    if (!target) throw new Error(t('平台主理人命令参数无效'));
    if (!values.confirm) throw new Error(t('删除旧主理人对话前须用 --confirm 确认'));
    return dispatch('steward-delete', { room_id: target });
  }
  if (command === 'settings') {
    const { adapter, model, effort, access, cwd, skills } = values;
    const patch = Object.fromEntries(Object.entries({ adapter, model, effort, project_access: access, cwd,
      skills: skills?.split(',').map(item => item.trim()).filter(Boolean) }).filter(([, value]) => value !== undefined));
    return Object.keys(patch).length ? dispatch('steward-settings', patch) : dispatch('steward');
  }
  if (command !== 'ask' || !target) throw new Error(t('平台主理人命令参数无效'));
  const skill = target;
  if (CONFIRMATION_SKILLS.includes(skill) && !values.confirm) throw new Error(t('安装、配置或部署会更改本机或远端，请使用 --confirm 确认本次请求'));
  const context = Object.fromEntries([['room_id', values.room], ['note', values.note]].filter(([, value]) => value !== undefined));
  try {
    return await dispatch('steward-request', { skill, context: Object.keys(context).length ? context : null, lang: resolve_locale(),
      ...(values.confirm ? { confirmed: true } : {}) });
  } catch (error) {
    if (error.code !== 'steward_not_configured') throw error;
    throw new Error(t('请先用 codiscuss steward settings --adapter 选择软件'));
  }
}
