import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { account_space } from './account_space.mjs';
import { adapter_profile } from './adapters/profiles.mjs';
import { moss_queue_receipts } from './channels.mjs';
import { api } from './discussion_runner.mjs';
import { local_settings } from './discussion_setup.mjs';
import { access_levels, PROJECT_ACCESS } from './expert_prompts.mjs';
import { proactive_patch, proactive_settings } from './steward_proactive.mjs';
import { resolve_locale, t } from './i18n.mjs';
import { parse_markdown } from './workflows.mjs';

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const PARTICIPANT_SKILL = 'discuss-participant';
const CONFIRMATION_SKILLS = ['local-stt-setup', 'local-tts-setup', 'notify-setup', 'cloudflare-deploy'];
const NON_READONLY_SKILLS = [...CONFIRMATION_SKILLS, 'codiscuss-draft-cleanup', 'discuss-report'];
const SKILLS = ['rooms-overview', 'codiscuss-help', 'dispatch-analysis', 'share-card', 'discuss-report', 'codiscuss-draft-cleanup', ...CONFIRMATION_SKILLS];
const FIELDS = ['adapter', 'model', 'effort', 'project_access', 'cwd', 'skills', 'create_rooms'];

/** Room delegation never enables unrelated host permissions. */
export function steward_room_permissions(settings) {
  return { items: settings.steward?.create_rooms === false ? [] : ['create_rooms'] };
}

function read_steward_settings(config) {
  const path = config.api_home && join(config.api_home, 'launch-settings.json');
  return path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** Publish the currently saved owner permission on each task. */
export function steward_task_permissions(config) {
  return steward_room_permissions(read_steward_settings(config) || {}).items;
}

export function steward_task_proactive(config) {
  const { duties, mutes } = proactive_settings(read_steward_settings(config)?.steward?.proactive);
  return { duties, mutes };
}

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
    project_access: saved.project_access || 'read', cwd: saved.cwd || join(account_space(home).workspace, 'steward'),
    skills: saved.skills ?? available, create_rooms: saved.create_rooms !== false, proactive: proactive_settings(saved.proactive),
  };
}

/** Return skill availability separately from the owner's allowed IDs. */
export function steward_status(home, settings, room_id) {
  const view = steward_defaults(home, settings);
  return { configured: Boolean(view.adapter), room_id: room_id || null, settings: view,
    channel_queue_receipts: moss_queue_receipts(home),
    skills: SKILLS.map(id => ({ id, available: Boolean(steward_skill(id)), allowed: view.skills.includes(id) })) };
}

/** Require an explicit software choice before opening the room or starting any work. */
export function require_steward_software(view) {
  if (view.adapter) return;
  const template = '请先在“MOSS”页面选择软件';
  throw Object.assign(new Error(t(template)), { code: 'steward_not_configured', error_text: { template, params: {} } });
}

/** Reject disallowed or unavailable skills before starting anything on the computer. */
export function require_steward_skill(settings, skill, project = PROJECT) {
  if (!steward_skill(skill, project) || (settings.steward?.skills && !settings.steward.skills.includes(skill))) {
    throw new Error(t('MOSS 未获准使用技能，或本机未安装此技能：{skill}', { skill: String(skill ?? '') }));
  }
}

/** Refuse skills that need to run commands or write files before opening a room or posting. */
export function require_steward_access(view, skill) {
  if (view.project_access !== 'read' || !NON_READONLY_SKILLS.includes(skill)) return;
  const template = 'MOSS 当前为只读。此技能需要运行命令或写入本机文件。请先在 MOSS 设置中把项目权限调到“自动”，再重试。';
  throw Object.assign(new Error(t(template)), { code: 'steward_access_too_low', error_text: { template, params: {} } });
}

/** Validate a partial settings update, keeping private room bookkeeping outside the caller's input. */
export function steward_settings_patch(input) {
  const patch = Object.fromEntries(FIELDS.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
  const invalid = Object.entries(patch).some(([key, value]) => key !== 'skills'
    && typeof value !== (key === 'create_rooms' ? 'boolean' : 'string'));
  if (invalid || (patch.adapter && !adapter_profile(patch.adapter)) || (patch.cwd && !isAbsolute(patch.cwd)) ||
      (patch.project_access && !PROJECT_ACCESS.includes(patch.project_access)) ||
      (Object.hasOwn(patch, 'skills') && patch.skills !== null &&
        (!Array.isArray(patch.skills) || patch.skills.some(skill => !SKILLS.includes(skill))))) {
    throw new Error(t('MOSS 设置无效'));
  }
  if (Array.isArray(patch.skills)) patch.skills = [...new Set(patch.skills)];
  if (Object.hasOwn(input, 'proactive')) patch.proactive = proactive_patch(input.proactive);
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
  const settings = read_steward_settings(config);
  const allowed = settings ? settings.steward?.skills ?? SKILLS : config.steward_skills || [];
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
  return [join(root, 'SKILL.md'), join(root, 'references', 'room.md'),
    join(config.project, '.agents', 'steward-skills', 'moss-core', 'SKILL.md'), ...new Set(selected)];
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
  if (!saved) throw new Error(t('请先配置MOSS的本机软件'));
  const levels = access_levels(view.adapter);
  const access = view.project_access;
  if (!access_levels(view.adapter).includes(access)) throw new Error(t('此软件不支持 MOSS 所选的项目权限'));
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

/** Queue trusted channel text as the owner, without wrapping it in a skill invocation. */
export async function post_steward_channel_message(config, { text, submission_id }, request = api) {
  const result = await request(config, '/messages', { author: '用户', submitted_by: '用户',
    kind: 'chat', text, queue: true, submission_id });
  return { message_id: result.message?.id ?? result.id, queued: result.queued };
}

/** Parse the public CLI into the same local actions the browser calls. */
export async function steward_cli(args, dispatch) {
  const help = () => process.stdout.write(t('用法：codiscuss steward status | settings [--adapter ID --model MODEL --effort LEVEL --access LEVEL --cwd DIR --skills SKILL,... --create-rooms on|off] | ask SKILL [--room ROOM --note TEXT --confirm] | history | delete ROOM --confirm') + '\n');
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, adapter: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    access: { type: 'string' }, cwd: { type: 'string' }, skills: { type: 'string' }, room: { type: 'string' },
    note: { type: 'string' }, confirm: { type: 'boolean' }, 'create-rooms': { type: 'string' },
    proactive: { type: 'string' }, 'active-hours': { type: 'string' }, 'digest-at': { type: 'string' },
    text: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' },
  } });
  const [command, target, ...extra] = positionals;
  if (!command || command === 'help' || values.help) {
    help();
    process.stdout.write(t('开始新会话：codiscuss steward renew') + '\n');
    return process.stdout.write(t('主动汇报：settings --proactive on|off --active-hours 09:00-22:00 --digest-at 21:00；duty add --text 正文 | duty remove --id ID | duty list；mute MESSAGE_ID --reason 原因') + '\n');
  }
  if (command === 'duty' && ['add', 'remove', 'list'].includes(target) && extra.length <= 1) {
    return dispatch('steward-duty', { action: target, ...(target === 'add' ? { text: values.text ?? extra[0] } : target === 'remove' ? { id: values.id ?? extra[0] } : {}) });
  }
  if (command === 'mute' && target && !extra.length) return dispatch('steward-mute', { message_id: Number(target), reason: values.reason });
  if (extra.length || (target && !['ask', 'delete'].includes(command))) throw new Error(t('MOSS 命令参数无效'));
  if (command === 'status') return dispatch('steward');
  if (command === 'renew') return dispatch('steward-renew', {});
  if (command === 'history') return dispatch('steward-history', {});
  if (command === 'delete') {
    if (!target) throw new Error(t('MOSS 命令参数无效'));
    if (!values.confirm) throw new Error(t('删除旧 MOSS 对话前须用 --confirm 确认'));
    return dispatch('steward-delete', { room_id: target });
  }
  if (command === 'settings') {
    const { adapter, model, effort, access, cwd, skills } = values;
    const create = values['create-rooms'];
    const { proactive, 'active-hours': hours, 'digest-at': digest } = values;
    if (proactive !== undefined && !['on', 'off'].includes(proactive)) throw new Error(t('--proactive 只能指定 on 或 off'));
    if (hours !== undefined && hours.split('-').length !== 2) throw new Error(t('MOSS 主动汇报设置无效，时间须为 HH:MM'));
    const report = { ...(proactive !== undefined ? { enabled: proactive === 'on' } : {}),
      ...(hours !== undefined ? { active_hours: { start: hours.split('-')[0], end: hours.split('-')[1] } } : {}),
      ...(digest !== undefined ? { digest_at: digest } : {}) };
    if (Object.keys(report).length) proactive_patch(report);
    if (create !== undefined && !['on', 'off'].includes(create)) throw new Error(t('--create-rooms 只能指定 on 或 off'));
    const patch = Object.fromEntries(Object.entries({ adapter, model, effort, project_access: access, cwd,
      create_rooms: create === undefined ? undefined : create === 'on',
      proactive: Object.keys(report).length ? report : undefined,
      skills: skills?.split(',').map(item => item.trim()).filter(Boolean) }).filter(([, value]) => value !== undefined));
    return Object.keys(patch).length ? dispatch('steward-settings', patch) : dispatch('steward');
  }
  if (command !== 'ask' || !target) throw new Error(t('MOSS 命令参数无效'));
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
