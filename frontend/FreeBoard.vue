<script setup>
/** Right-rail board of a free room, laid out like the discussion progress board. */
import { computed, inject, ref, watch } from "vue";
import InviteDialog from "./InviteDialog.vue";
import StartDiscussionDialog from "./StartDiscussionDialog.vue";
import SpeakingOrder from "./SpeakingOrder.vue";
import MemberDescriptionDialog from "./MemberDescriptionDialog.vue";

const { view, bridge, act, pending } = inject("discussion");
const LIVE = ["dispatched", "started"];
const EXECUTION_STATUS_TEXT = { dispatched: "唤醒中", started: "执行中", completed: "完成", cancelled: "已停止", failed: "失败" };
const ACCESS_LABELS = { runner: "本机唤醒", manual: "手动接入", online: "网页代发" };
const TASK_PREVIEW_LENGTH = 90;
const room = computed(() => view.value.room);
const free = computed(() => room.value.free || {});
const host = computed(() => (free.value.members || []).find((member) => member.role === "host" && member.status === "active"));
// Rows follow the room's speaking order; members who left are listed after it.
const member_named = (name) => (free.value.members || []).find((member) => member.name === name);
const away_names = computed(() => (free.value.members || []).filter((member) => member.status === "away").map((member) => member.name));
const busy = (member) => member.pending > 0 || LIVE.includes(member.execution?.status);
const name_of = (member_id) => bridge.display_name((free.value.members || []).find((member) => member.id === member_id)?.name || "成员");

/** Status dot colour, matching the discussion progress board. */
const unregistered = (member) => member.access === "manual" && member.status === "active" && !member.registered_at;
function member_tone(member) {
  if (member.status === "away") return "neutral";
  if (unregistered(member)) return "warning";
  if (member.execution?.stale) return "error";
  if (busy(member)) return member.pending && !LIVE.includes(member.execution?.status) ? "warning" : "primary";
  return member.execution?.status === "failed" ? "error" : "success";
}

/** One line per member: live execution, queued requests, its place in a one-after-another queue, or the last outcome. */
function member_status(member, state) {
  if (member.status === "away") return "已离开：不会被唤醒，可请回";
  if (unregistered(member)) return "待注册";
  const execution = member.execution;
  if (execution && LIVE.includes(execution.status)) return execution.stale ? "执行失联，停止未确认" : "正在处理";
  if (member.pending) return `待投递 ${member.pending} 条`;
  if (state === "queued") return "等待依次发言";
  if (execution?.status === "failed") return "执行失败";
  return !execution && member.access === "manual" ? "已注册" : "空闲";
}

/** Only woken members have a model the site knows; others choose it in their own chat. */
function member_model(member) {
  return member.access === "runner" ? bridge.participant_model(member.name, room.value, view.value.launch.room_models) : "";
}

const status = computed(() => {
  if (room.value.archived) return { tone: "neutral", title: "已存档", detail: "" };
  const working = (free.value.members || []).filter(busy);
  if (working.some((member) => member.execution?.stale)) return { tone: "error", title: "执行失联", detail: "停止未确认，可在成员菜单中停止后重发" };
  if (working.length) return { tone: "primary", title: "处理中",
    detail: working.map((member) => `${bridge.display_name(member.name)} ${LIVE.includes(member.execution?.status) ? "正在处理" : `待投递 ${member.pending} 条`}`).join(" · ") };
  const latest_chain = Math.max(0, ...(free.value.requests || []).map((request) => request.chain_id));
  const halted = (free.value.halted_chains || []).find((chain) => chain.chain_id === latest_chain);
  if (halted) return { tone: "warning", title: "任务链已停",
    detail: halted.reason === "budget" ? `AI 之间派活达到 ${free.value.max_auto_hops} 次上限；发新消息即重新开始` : "派出的成员都失败了；发新消息即重新开始" };
  if (!(free.value.members || []).length) return { tone: "neutral", title: "暂无成员", detail: "在下方邀请 AI 加入" };
  return { tone: "success", title: "空闲", detail: host.value
    ? `消息默认交给 ${bridge.display_name(host.value.name)}；@ 其他成员让它们发言` : "只有网页 AI：消息只作留言，需要你代发回答" };
});

/** Recent requests and executions; the server keeps the latest hundred of each. */
const meters = computed(() => {
  const requests = free.value.requests || [];
  const answered = requests.filter((request) => request.status === "completed").length;
  const executions = free.value.executions || [];
  return [
    { label: "请求", text: `${answered} / ${requests.length} 已回复`, ratio: requests.length ? answered / requests.length : null },
    { label: "执行", text: `${executions.length} 次`, ratio: null },
  ];
});

/** The user message behind the newest request, so the rail says what the room is working on. */
const task = computed(() => {
  const request = (free.value.requests || []).filter((item) => item.created_by === "user").at(-1);
  if (!request) return "";
  const message = (view.value.messages || []).find((item) => item.id === request.message_id);
  return message ? message.text : `#${request.message_id}`;
});
const task_expanded = ref(false);
watch(() => room.value.id, () => { task_expanded.value = false; });

/** Each execution runs from delivery to its end; one still running counts up to now. */
const timings = computed(() => {
  const now = Math.floor(Date.now() / 1000);
  const items = (free.value.executions || []).map((execution) => ({ ...execution,
    seconds: execution.created_at ? (execution.finished_at || (LIVE.includes(execution.status) ? now : execution.created_at)) - execution.created_at : null }));
  return { items, total: items.reduce((sum, item) => sum + (item.seconds || 0), 0) };
});

/** Render whole seconds compactly, as the discussion board does. */
function duration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
  return `${Math.floor(seconds / 3600)}小时${Math.floor((seconds % 3600) / 60)}分`;
}

/** Owner actions for one member, kept in its menu like the discussion board's member actions. */
function member_menu(member) {
  const item = (label, icon, action, extra = {}) => ({ label, icon, onSelect: () => act("change_member", { member_id: member.id, name: member.name, action, ...extra }) });
  const access = view.value.access;
  const available = access?.members?.find((entry) => entry.name === member.name)?.available;
  return [[
    ...(member.access === "manual" ? [{ label: "复制启动指令（含凭证）", icon: "i-lucide-rocket", disabled: !access?.can_manage || !available, onSelect: () => act("copy_member_launch", member.name) }] : []),
    { label: "编辑描述", icon: "i-lucide-user-pen", disabled: !access?.can_manage, onSelect: () => { describing.value = member.name; } },
    { label: "复制参与说明", icon: "i-lucide-copy", disabled: !access?.can_manage, onSelect: () => act("copy_member_join", member.name) },
    ...(member.access !== "online" ? [{ label: "下载私有配置", icon: "i-lucide-download", disabled: !access?.can_manage || !available, onSelect: () => act("download_member_access", member.name) }] : []),
    ...(member.access === "manual" ? [{ label: "复制凭证文本", icon: "i-lucide-key-round", disabled: !access?.can_manage || !available, onSelect: () => act("copy_member_access_text", member.name) }] : []),
  ], [
    ...(busy(member) ? [item("停止", "i-lucide-square", "interrupt")] : []),
    ...(member.access === "online" && member.pending ? [{ label: "复制阅读通知", icon: "i-lucide-copy", onSelect: () => act("copy_online_notice", member.name) }] : []),
    ...(member.status === "active" && member.access !== "online" && member.role !== "host" ? [item("设为主持人", "i-lucide-crown", "role", { role: "host" })] : []),
    member.status === "active" ? item("离开", "i-lucide-log-out", "away") : { ...item("请回", "i-lucide-log-in", "rejoin"), disabled: member.access === "runner" && !view.value.launch.available },
  ], [{ ...item("移除", "i-lucide-trash-2", "remove"), color: "error" }]];
}

const inviting = ref(false);
// The member whose description is open for editing; the scheduler and the host read it from the room.
const describing = ref(""), describing_saving = ref(false);
watch(() => room.value.id, () => { inviting.value = false; describing.value = ""; });

/** Save one member's description in this room, and optionally as its platform's default for later rooms. */
async function save_description({ text, as_template }) {
  describing_saving.value = true;
  try {
    await bridge.describe_member(describing.value, text);
    if (as_template) bridge.save_description_template(describing.value, text);
    describing.value = "";
  } catch { /* The board shows the error under the member list. */ }
  finally { describing_saving.value = false; }
}

const starting = ref(false);
/** A discussion needs an AI host the local service wakes. */
const can_start = computed(() => Boolean(host.value && host.value.access === "runner") && view.value.launch.available);
watch(() => room.value.id, () => { starting.value = false; });
</script>

<template>
  <div class="progress-board is-docked">
    <header class="pb-header"><strong>自由协作</strong><span class="pb-mode">{{ host ? `${bridge.display_name(host.name)} 主持` : '无主持人' }}</span></header>
    <section class="pb-status" :class="`is-${status.tone}`" aria-label="房间状态">
      <div class="pb-status-line"><span class="pb-dot"></span><strong role="status">{{ status.title }}</strong></div>
      <p v-if="status.detail" class="pb-status-detail">{{ status.detail }}</p>
      <div class="pb-meters">
        <div v-for="meter in meters" :key="meter.label" class="pb-meter">
          <div class="pb-meter-label"><span>{{ meter.label }}</span><b>{{ meter.text }}</b></div>
          <div v-if="meter.ratio !== null" class="pb-bar"><i :style="{ width: `${Math.min(100, Math.round(meter.ratio * 100))}%` }"></i></div>
        </div>
      </div>
    </section>
    <section v-if="task" class="pb-section" aria-label="当前任务">
      <h4>当前任务</h4>
      <p class="pb-focus" :class="{ 'is-expanded': task_expanded }">{{ task }}</p>
      <button v-if="task.length > TASK_PREVIEW_LENGTH" type="button" class="pb-link" @click="task_expanded = !task_expanded">{{ task_expanded ? '收起' : '展开' }}</button>
    </section>
    <section class="pb-section" aria-label="发言顺序">
      <h4>发言顺序</h4>
      <SpeakingOrder :away="away_names">
        <template #default="{ item }">
          <template v-for="member in [member_named(item.name)].filter(Boolean)" :key="member.id">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="xs" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="pb-member-body">
              <div class="pb-member-name" :title="room.descriptions?.[member.name] || undefined">{{ bridge.display_name(member.name) }}<UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /><small :title="member_model(member) || undefined">{{ [member.role === 'host' ? `主持 · ${ACCESS_LABELS[member.access]}` : ACCESS_LABELS[member.access], member_model(member)].filter(Boolean).join(' · ') }}</small></div>
              <div v-if="member.session_mode === 'borrowed'" class="pb-member-model" title="它工作时请不要在原窗口继续操作">借用已有会话</div>
              <div class="pb-member-status" :class="`is-${member_tone(member)}`"><span class="pb-dot"></span><span class="pb-member-status-text" :title="member.execution?.status === 'failed' ? member.execution.result : undefined">{{ member_status(member, item.state) }}</span></div>
            </div>
            <UDropdownMenu :items="member_menu(member)" :content="{ align: 'end' }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="xs" class="pb-member-more" :aria-label="`${member.name} 的更多操作`" /></UDropdownMenu>
          </template>
        </template>
      </SpeakingOrder>
      <p v-for="item in free.conflicts || []" :key="item.executions.join('-')" class="pb-free-note is-warning">可能冲突：{{ item.members.map((name) => bridge.display_name(name)).join(' 与 ') }} 的重叠执行观察到 {{ item.files.join('、') }} 变化；修改者未确认。</p>
      <p v-if="view.free_error" role="alert" class="pb-free-note is-error">{{ view.free_error }}</p>
      <p v-else-if="view.free_notice" role="status" class="pb-free-note">{{ view.free_notice }}</p>
      <p v-if="view.access?.error" role="alert" class="pb-free-note is-error">{{ view.access.error }}</p>
      <p v-else-if="view.access?.notice" role="status" class="pb-free-note">{{ view.access.notice }}</p>
      <UButton v-if="!room.archived" icon="i-lucide-plus" label="邀请 AI 加入" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block pb-action-add" @click="inviting = true" />
    </section>
    <section v-if="room.linked_rooms?.length" class="pb-section" aria-label="头脑风暴">
      <h4>头脑风暴</h4>
      <button v-for="item in room.linked_rooms" :key="item.id" type="button" class="pb-link pb-free-linked" @click="act('room', item.id)">{{ item.title }}<small>{{ bridge.phases[item.phase] || item.phase }}</small></button>
    </section>
    <section v-if="!room.archived" class="pb-actions" aria-label="操作">
      <UButton icon="i-lucide-messages-square" label="开启讨论" size="sm" color="neutral" variant="outline" class="pb-action pb-action-block pb-restart" title="由主持人推进成员轮流发言，到上限或结束后房间回到自由协作" :disabled="!can_start" @click="starting = true" />
      <p v-if="!can_start" class="pb-free-note">开启讨论需要一位由本机唤醒的 AI 主持人。</p>
    </section>
    <section v-if="timings.items.length" class="pb-section" aria-label="执行耗时">
      <div class="pb-timing-heading"><h4>耗时</h4><small>共 {{ timings.items.length }} 次执行 · {{ duration(timings.total) }}</small></div>
      <details class="pb-timings">
        <summary>查看每次执行</summary>
        <ol>
          <li v-for="item in timings.items" :key="item.id">
            <span class="pb-timing-who">#{{ item.id }} {{ name_of(item.member_id) }}<small>{{ EXECUTION_STATUS_TEXT[item.status] || item.status }}</small></span>
            <span class="pb-timing-stages"><span>用时 {{ duration(item.seconds) }}</span></span>
          </li>
        </ol>
      </details>
    </section>
  <StartDiscussionDialog v-model:open="starting" />
  <InviteDialog v-model:open="inviting" description="新成员加入后不打断其他成员；点卡片翻面可设置软件、模型、项目权限和要续接的已有会话。" />
  <MemberDescriptionDialog :open="Boolean(describing)" :name="describing || ' '" :platform="describing ? bridge.platform_of(describing) : ''"
    :text="room.descriptions?.[describing] || ''" :template="describing ? bridge.description_template(describing) : ''" :saving="describing_saving"
    @update:open="(open) => { if (!open) describing = ''; }" @save="save_description" />
  </div>
</template>

<style scoped>
.pb-member.is-away { opacity: .6; }
.pb-member-model { margin: 2px 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
</style>
