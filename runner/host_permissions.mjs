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
  // `room-post` needs no item: it reaches only rooms linked by a `create-room` the owner allowed.
  'create-room': 'create_rooms',
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

/** What the host is told when the owner has not granted the item an action needs. */
export const host_refusal = item => `房主没有为本房间勾选主持人权限“${ITEM_LABELS[item]}”；请让用户在电脑上“成员与设置 → 协作设置 → 主持人权限”勾选后再试`;
