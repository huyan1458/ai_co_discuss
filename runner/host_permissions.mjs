// What the owner lets a room's AI host do by itself, item by item. Free of Node dependencies: the web page lists the
// same items in the new-room form and the room settings. Kept in the runner's room configuration as
// `host_permissions: { items, room_limit }`; the older `host_workflows: true` alone means every item it used to cover.

/** Items the older single switch covered, in the order screens list them. */
export const HOST_LEGACY_ITEMS = ['execution', 'member_config', 'project_access', 'roster', 'pacing', 'workflows'];
/** Every item; `create_rooms` is newer than the single switch, so an old room never has it until the owner ticks it. */
export const HOST_ITEMS = [...HOST_LEGACY_ITEMS, 'create_rooms'];
export const DEFAULT_HOST_ROOM_LIMIT = 3;
export const MAX_HOST_ROOM_LIMIT = 20;

/** The item each `host-control` action needs; actions not listed only read and are always allowed. */
export const HOST_ACTION_ITEMS = {
  stop: 'execution', 'stop-all': 'execution', steer: 'execution', retry: 'execution', withdraw: 'execution',
  model: 'member_config', adapter: 'member_config', label: 'member_config',
  access: 'project_access',
  invite: 'roster', away: 'roster', remove: 'roster', back: 'roster',
  order: 'pacing', discussion: 'pacing', goal: 'pacing', checkin: 'pacing',
  // `room-post` needs no item: messages reach the other room’s host within its existing permissions.
  'create-room': 'create_rooms',
  // `guest-disconnect` needs no item: the host may always end an external user's visit (README §3.5).
};

const ITEM_LABELS = { execution: '处理执行问题', member_config: '调整成员配置', project_access: '改项目权限', roster: '管理成员名单',
  pacing: '推进方式', workflows: '工作流', create_rooms: '新建房间' };

/**
 * The permissions a stored value means, with unknown items dropped and the limit kept in range.
 * @param {object} [value] A stored `host_permissions`.
 * @param {boolean} [legacy_flag] The older `host_workflows`, used only when `value` is absent.
 * @returns {{ items: string[], room_limit: number }}
 */
export function normalize_host_permissions(value, legacy_flag = false) {
  const listed = Array.isArray(value?.items) ? value.items : legacy_flag ? HOST_LEGACY_ITEMS : [];
  const limit = Number.isInteger(value?.room_limit) ? value.room_limit : DEFAULT_HOST_ROOM_LIMIT;
  return { items: HOST_ITEMS.filter(item => listed.includes(item)), room_limit: Math.max(1, Math.min(limit, MAX_HOST_ROOM_LIMIT)) };
}

/** A room configuration's host permissions. */
export const host_permissions = config => normalize_host_permissions(config?.host_permissions, config?.host_workflows === true);

/** Whether the owner lets this room's host do what `item` covers. */
export const host_allowed = (config, item) => host_permissions(config).items.includes(item);

/** How many rooms this room's host may create from it. */
export const host_room_limit = config => host_permissions(config).room_limit;

/** The same permissions without one item, e.g. a room the host created cannot create rooms itself. */
export const without_host_item = (permissions, item) => ({ ...permissions, items: permissions.items.filter(entry => entry !== item) });

/** The two configuration fields to store for these permissions; `host_workflows` stays as "any item granted". */
export function host_permission_fields(permissions) {
  const next = normalize_host_permissions(permissions);
  return { host_permissions: next.items.length ? next : undefined, host_workflows: next.items.length ? true : undefined };
}

/**
 * The room's protection while an external user (a browser guest) is in it, from the site's guest state
 * (`GET /api/rooms/{room}/guest`, .dev/plans/临时外部用户/API.md §2): 'conservative' (every run of the room goes into the
 * protected level, members that cannot are paused), 'trust' (members keep the owner's settings) or '' when no external
 * user is in the room. Only an active visit counts; the site is the only source.
 * @param {object} [state] The guest `State`.
 * @returns {'' | 'conservative' | 'trust'}
 */
export function guest_protection(state) {
  if (state?.phase !== 'active') return '';
  return state.mode === 'conservative' || state.mode === 'trust' ? state.mode : '';
}

/**
 * The guest `State` inside a site answer: API.md wraps answers as `{ok, data}` and writes answer `{state, ...}`, so a
 * wrapped or bare State, or one under `state`, all give the State; anything else gives null. Read this way, a wrapped
 * answer can never pass for "no external user".
 */
export function guest_state_of(result) {
  const value = result?.ok === true && result.data !== undefined ? result.data : result;
  const state = value?.phase === undefined && value?.state ? value.state : value;
  return state && typeof state === 'object' && typeof state.phase === 'string' ? state : null;
}

/**
 * Whether a host control is withheld while an external user is in the room, in either level and whatever the owner
 * ticked; the ticks stay as stored and apply again once the external user leaves (.dev/plans/临时外部用户/PLAN.md §二).
 * Kept: dispatching, stop, steer, retry, withdraw, speaking order, away, remove, and `guest-disconnect`.
 * @param {string} action A `host-control` action.
 * @param {object} [options] Its options: reads (`model --list`, `discussion` / `goal` without a start) stay allowed.
 */
export function guest_withheld(action, options = {}) {
  if (['access', 'adapter', 'invite', 'back', 'room-post', 'create-room', 'workflow-adopt', 'workflow-promote'].includes(action)) return true;
  if (action === 'model') return !options.list;
  if (action === 'checkin') return !options.off;
  if (action === 'discussion' || action === 'goal') return ['start', 'resume'].includes(options.do);
  return false;
}

/** What the host is told when the owner has not granted the item an action needs. */
export const host_refusal = item => `房主没有为本房间勾选主持人权限“${ITEM_LABELS[item]}”；请让用户在电脑上“成员与设置 → 协作设置 → 主持人权限”勾选后再试`;
