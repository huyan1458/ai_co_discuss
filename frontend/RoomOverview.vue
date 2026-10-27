<script setup>
/** Read-only summary of how the room is set up; every change stays with the existing controls in the member rail. */
import { computed, inject } from "vue";

const { view, bridge } = inject("discussion");
const ACCESS_LABELS = { manual: "手动接入", online: "网页代发" };
const STATUS_LABELS = { active: "在场", away: "暂离" };
const room = computed(() => view.value.room);
const free = computed(() => room.value.mode === "free");
const saved = computed(() => view.value.launch.room_models);
// Rooms from before members were recorded only list their experts.
const members = computed(() => room.value.members?.length ? room.value.members
  : Object.entries(room.value.experts || {}).map(([name, mode]) => ({ name, access: mode === "online" ? "online" : "runner", status: "active", role: name === room.value.host ? "host" : "member" })));

/** How a member takes part: woken members name their software kind, the others how they answer. */
function access_label(member) {
  return ACCESS_LABELS[member.access] || `本机唤醒 · ${bridge.participant_access(member.name, room.value)}`;
}

/** Project file access: woken members read it from this computer's registration, web members never write. */
function files_label(member) {
  if (member.access === "online") return "只读";
  if (member.access === "manual") return "由其会话决定";
  const access = saved.value?.room_id === room.value.id ? saved.value.participants?.[member.name]?.project_access : "";
  return access ? (access === "write" ? "可写" : "只读") : "未获取";
}

/** The smart scheduler lives in the local registration, so a page without the local service cannot tell. */
const scheduler = computed(() => {
  const local = saved.value?.room_id === room.value.id ? saved.value : null;
  if (!local || local.loading) return local?.loading ? "读取中" : "未获取（需连接本机服务）";
  if (!local.registered) return "未获取（本机未登记此房间）";
  if (!local.scheduler) return "未开启";
  const provider = view.value.launch.scheduler_providers?.[local.scheduler.provider]?.label || local.scheduler.provider;
  return `${provider} · ${local.scheduler.model}`;
});
const created = computed(() => room.value.created_at ? new Date(room.value.created_at).toLocaleString("zh-CN", { hour12: false }) : "");
</script>

<template>
  <section class="content-page room-overview" role="tabpanel" aria-label="房间概况">
    <div class="page-heading"><div><h2>房间概况</h2><p>当前成员与协作设置，只读汇总；邀请、暂离、移除与更换主持在右栏成员菜单操作。</p></div></div>
    <section class="overview-section">
      <h3>成员</h3>
      <ul class="overview-members">
        <li v-for="member in members" :key="member.name">
          <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="sm" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
          <div class="overview-member-name"><strong>{{ bridge.display_name(member.name) }}</strong><UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /><small v-if="room.descriptions?.[member.name]" :title="room.descriptions[member.name]">{{ room.descriptions[member.name] }}</small></div>
          <dl class="overview-facts">
            <div><dt>接入</dt><dd>{{ access_label(member) }}</dd></div>
            <div v-if="member.access === 'runner'"><dt>模型</dt><dd>{{ bridge.participant_model(member.name, room, saved) || '未获取' }}</dd></div>
            <div><dt>项目文件</dt><dd>{{ files_label(member) }}</dd></div>
            <div><dt>状态</dt><dd>{{ member.access === 'manual' && !member.registered_at ? '待注册' : STATUS_LABELS[member.status] || member.status }}</dd></div>
          </dl>
        </li>
      </ul>
    </section>
    <section class="overview-section">
      <h3>协作设置</h3>
      <dl class="overview-settings">
        <div><dt>主持人</dt><dd>{{ room.host ? bridge.display_name(room.host) : '未指定' }}</dd></div>
        <div><dt>智能调度</dt><dd>{{ scheduler }}</dd></div>
        <div v-if="free && room.free?.max_auto_hops"><dt>AI 之间派活上限</dt><dd>{{ room.free.max_auto_hops }} 次，到限停下等你</dd></div>
        <div v-if="created"><dt>创建时间</dt><dd>{{ created }}</dd></div>
      </dl>
    </section>
    <section v-if="!free" class="overview-section">
      <h3>进行中的讨论</h3>
      <dl class="overview-settings">
        <div><dt>目标</dt><dd>{{ room.goal || '未填写' }}</dd></div>
        <div><dt>上限与进度</dt><dd>{{ bridge.limits_label(room.limits) }}</dd></div>
        <div><dt>逐人追问</dt><dd>{{ room.named_followup ? '开启：主持人每轮给每位专家写针对性追问' : '关闭：首轮后请专家回应上一轮观点' }}</dd></div>
      </dl>
    </section>
  </section>
</template>

<style scoped>
.overview-section { margin-bottom: 28px; }
.overview-section h3 { margin: 0 0 12px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
.overview-members { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.overview-members li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; align-items: center; padding: 12px 14px; border: 1px solid var(--ui-border); border-radius: 8px; }
.overview-member-name { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--ui-text-highlighted); }
.overview-member-name small { overflow: hidden; color: var(--ui-text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.overview-member-name .iconify { flex: none; color: var(--ui-warning, #e5b54a); }
.overview-facts { display: flex; flex-wrap: wrap; grid-column: 2; gap: 4px 20px; margin: 0; font-size: 12px; }
.overview-facts div, .overview-settings div { display: flex; gap: 8px; }
.overview-facts dt, .overview-settings dt { color: var(--ui-text-muted); }
.overview-facts dd, .overview-settings dd { margin: 0; color: var(--ui-text); }
.overview-settings { display: grid; gap: 10px; margin: 0; font-size: 13px; }
.overview-settings dt { flex: none; width: 112px; }
</style>
