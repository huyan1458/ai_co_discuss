/**
 * What an owner can do with one free-room member. The rail's member menu is the quick entry and the room overview
 * lays the same actions out in full, so both read them from here instead of keeping two lists.
 */
const LIVE = ["dispatched", "started"];

/** A member is busy while it has queued requests or a live execution. */
export const busy = (member) => member.pending > 0 || LIVE.includes(member.execution?.status);

/**
 * Action groups for one member: taking part (instructions, credentials, description), its place in the room, and removal.
 * @param {object} member A `room.free.members` entry.
 * @param {object} context `view` (the current snapshot), `act` and `describe` (opens the description editor).
 * @returns {object[][]} Groups of `{ label, icon, disabled?, color?, onSelect }`.
 */
export function member_actions(member, { view, act, describe }) {
  const access = view.access;
  const available = access?.members?.find((entry) => entry.name === member.name)?.available;
  const locked = !access?.can_manage;
  const web = member.manual_source === "web" || member.access === "online";
  const session_running = ["active", "paused"].includes(view.room?.session?.status);
  const current_host = session_running && member.role === "host";
  const change = (label, icon, action, extra = {}) => ({ label, icon,
    disabled: locked, onSelect: () => act("change_member", { member_id: member.id, name: member.name, action, ...extra }) });
  return [[
    ...(member.access === "manual" && !web ? [{ label: "复制启动指令（含凭证）", icon: "i-lucide-rocket", disabled: locked || !available, onSelect: () => act("copy_member_launch", member.name) }] : []),
    { label: "编辑描述", icon: "i-lucide-user-pen", disabled: locked, onSelect: () => describe(member.name) },
    { label: "复制参与说明", icon: "i-lucide-copy", disabled: locked, onSelect: () => act("copy_member_join", member.name) },
    ...(!web ? [{ label: "下载私有配置", icon: "i-lucide-download", disabled: locked || !available, onSelect: () => act("download_member_access", member.name) }] : []),
    ...(member.access === "manual" && !web ? [{ label: "复制凭证文本", icon: "i-lucide-key-round", disabled: locked || !available, onSelect: () => act("copy_member_access_text", member.name) }] : []),
  ], [
    ...(busy(member) ? [change("停止", "i-lucide-square", "interrupt")] : []),
    ...(web && member.pending ? [{ label: "复制阅读通知", icon: "i-lucide-copy", disabled: locked, onSelect: () => act("copy_online_notice", member.name) }] : []),
    ...(member.status === "active" && !web && member.role !== "host" ? [change("设为主持人", "i-lucide-crown", "role", { role: "host" })] : []),
    ...(current_host ? [] : [member.status === "active" ? change("离开", "i-lucide-log-out", "away") : { ...change("请回", "i-lucide-log-in", "rejoin"), disabled: locked || (member.access === "runner" && !view.launch.available) }]),
  ], ...(current_host ? [] : [[{ ...change("移除", "i-lucide-trash-2", "remove"), color: "error" }]])];
}
