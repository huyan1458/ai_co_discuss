import { t } from './i18n.js';
import { external_of } from './external-members.js';
/**
 * What an owner can do with one free-room member. The rail's member menu is the quick entry and the room overview
 * lays the same actions out in full, so both read them from here instead of keeping two lists.
 */
const LIVE = ["dispatched", "started"];
/** Longest display name a member may be given. */
export const MAX_LABEL = 32;

/** A member is busy while it has queued requests or a live execution. */
export const busy = (member) => member.pending > 0 || LIVE.includes(member.execution?.status);

// CLIs and API members this tool grants project access per run; App members are left to their own settings.
const ACCESS_CLIENTS = ["codex_cli", "claude", "antigravity_cli", "api"];

/**
 * A member's project file access and whether the owner can switch it here; anything that cannot says why on hover.
 * The room overview's switch and the rail menu's submenu both read it.
 * @param {object} member A room member.
 * @param {object|null} saved This computer's saved choices for the room (`view.launch.room_models`), or null.
 * @param {object} view The current snapshot.
 * @param {object|null} [held] The conservative protection on this member while an external user is in
 *   (external-guests.js member_protection): it overrides the saved choice, so no switch is offered.
 * @returns {{ value?: string, text?: string, hint?: string, editable?: boolean }}
 */
export function project_files(member, saved, view, held = null) {
  if (held?.paused) return { text: t("暂停接单"), hint: t("外部用户在场，保守保护下暂停接单：{reason}", { reason: held.reason }) };
  if (held) return { text: t("临时只读"), hint: t("外部用户在场，保守保护下临时只读；对方离开后恢复原设置") };
  if (member.access === "manual") return { text: t("自行决定"), hint: t("手动成员的权限由它自己的会话决定") };
  const profile = saved?.participants?.[member.name];
  if (!profile) return { text: "—" };
  if (profile.project_access === "own") return { text: t("自行决定"), hint: t("手动接入的成员，由本机服务投递时仍沿用它自己会话的软件权限") };
  if (!ACCESS_CLIENTS.includes(profile.adapter)) return { text: t("App 内设置"), hint: t("App 成员的权限在 App 里设置") };
  if (profile.own_project) return { text: t("agy 内设置"), hint: t("续接它自己的 agy 对话，权限沿用该对话所在项目") };
  if (profile.defaults_pending) return { value: profile.project_access || "read", hint: t("正在读取 agy 的配置") };
  return { value: profile.project_access || "read", editable: view.access?.can_manage && view.launch.available };
}

/**
 * Action groups for one member: taking part (instructions, credentials, description), its place in the room, and removal.
 * @param {object} member A `room.free.members` entry.
 * @param {object} context `view` (the current snapshot), `act` and `describe` (opens the description editor).
 * @returns {object[][]} Groups of `{ label, icon, disabled?, color?, onSelect }`.
 */
export function member_actions(member, { view, act, describe, external, revoke, copy_link }) {
  const access = view.access;
  // A member from another computer has no credentials or launch here: its own dialog holds the reading record and
  // the protections (extend, downgrade, revoke); it is never the host.
  if (external_of(member)) return external_actions(member, { view, act, describe, external, revoke, copy_link });
  const available = access?.members?.find((entry) => entry.name === member.name)?.available;
  const locked = !access?.can_manage;
  const session_running = ["active", "paused"].includes(view.room?.session?.status);
  const current_host = session_running && member.role === "host";
  const change = (label, icon, action, extra = {}) => ({ label, icon,
    disabled: locked, onSelect: () => act("change_member", { member_id: member.id, name: member.name, action, ...extra }) });
  return [[
    ...(member.access === "manual" ? [{ label: t('复制启动指令（含凭证）'), icon: "i-lucide-rocket", disabled: locked || !available, onSelect: () => act("copy_member_launch", member.name) }] : []),
    { label: t('名称与描述'), icon: "i-lucide-user-pen", disabled: locked, onSelect: () => describe(member.name) },
    { label: t('复制参与说明'), icon: "i-lucide-copy", disabled: locked, onSelect: () => act("copy_member_join", member.name) },
    { label: t('下载私有配置'), icon: "i-lucide-download", disabled: locked || !available, onSelect: () => act("download_member_access", member.name) },
    ...(member.access === "manual" ? [{ label: t('复制凭证文本'), icon: "i-lucide-key-round", disabled: locked || !available, onSelect: () => act("copy_member_access_text", member.name) }] : []),
  ], [
    ...(busy(member) ? [{ ...change(t('停止'), "i-lucide-circle-stop", "interrupt"), color: "error" }] : []),
    ...(member.status === "active" && member.role !== "host" ? [change(t('设为主持人'), "i-lucide-crown", "role", { role: "host" })] : []),
    ...(current_host ? [] : [member.status === "active" ? change(t('离开'), "i-lucide-log-out", "away") : { ...change(t('请回'), "i-lucide-log-in", "rejoin"), disabled: locked || (member.access === "runner" && !view.launch.available) }]),
  ], ...(current_host ? [] : [[{ ...change(t('移除'), "i-lucide-trash-2", "remove"), color: "error" }]])];
}

/**
 * Action groups for an external member; `external(member)` opens its dialog, `revoke(member)` ends it at once and
 * `copy_link(member)` copies a waiting seat's invitation link, as a manual member's menu copies its launch instruction.
 */
function external_actions(member, { view, act, describe, external, revoke, copy_link }) {
  const locked = !view.access?.can_manage;
  return [[
    ...(external_of(member).pending && copy_link ? [{ label: t('复制邀请链接'), icon: "i-lucide-link", disabled: locked, onSelect: () => copy_link(member) }] : []),
    { label: external_of(member).pending ? t('邀请详情') : t('读取记录与权限'), icon: "i-lucide-shield-check", disabled: locked, onSelect: () => external?.(member) },
    { label: t('名称与描述'), icon: "i-lucide-user-pen", disabled: locked, onSelect: () => describe(member.name) },
  ], [
    ...(busy(member) ? [{ label: t('停止'), icon: "i-lucide-circle-stop", color: "error", disabled: locked,
      onSelect: () => act("change_member", { member_id: member.id, name: member.name, action: "interrupt" }) }] : []),
  ], [{ label: external_of(member).pending ? t('移除席位') : t('撤销授权'), icon: "i-lucide-ban", color: "error", disabled: locked || external_of(member).ended, onSelect: () => revoke?.(member) }]].filter((group) => group.length);
}
