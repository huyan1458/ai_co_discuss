<script setup>
/** How the room is set up: members side by side, where project file access can be switched, and the room's settings. */
import { computed, inject, ref } from "vue";

const { view, bridge } = inject("discussion");
const ACCESS_LABELS = { manual: "手动接入", online: "网页代发" };
const STATUS_LABELS = { active: "在场", away: "暂离" };
// CLIs this tool grants project access per run; App and API members are left to their own settings.
const ACCESS_CLIENTS = ["codex_cli", "claude", "antigravity_cli"];
const ACCESS_OPTIONS = [{ value: "read", label: "只读" }, { value: "write", label: "可写" }];
const room = computed(() => view.value.room);
const free = computed(() => room.value.mode === "free");
const saved = computed(() => view.value.launch.room_models?.room_id === room.value.id ? view.value.launch.room_models : null);
const switching = ref("");
const result = ref({ tone: "", text: "" });
// Rooms from before members were recorded only list their experts.
const members = computed(() => room.value.members?.length ? room.value.members
  : Object.entries(room.value.experts || {}).map(([name, mode]) => ({ name, access: mode === "online" ? "online" : "runner", status: "active", role: name === room.value.host ? "host" : "member" })));

/** Being woken here is the usual case, so a woken member only names its kind (CLI / API / App). */
function access_label(member) {
  return ACCESS_LABELS[member.access] || bridge.participant_access(member.name, room.value);
}

/** Project file access, and whether it can be switched here; anything that cannot says why on hover. */
function files(member) {
  if (member.access === "online") return { text: "只读", hint: "网页成员只能阅读" };
  if (member.access === "manual") return { text: "自行决定", hint: "手动成员的权限由它自己的会话决定" };
  const profile = saved.value?.participants?.[member.name];
  if (!profile) return { text: "未获取", hint: saved.value?.loading ? "读取中" : "需连接本机服务，且本机登记了此房间" };
  if (profile.adapter === "api") return { text: "只读", hint: "API 成员没有本机文件工具" };
  if (!ACCESS_CLIENTS.includes(profile.adapter)) return { text: "App 内设置", hint: "App 成员的权限在 App 里设置" };
  if (profile.own_project) return { text: "agy 内设置", hint: "续接它自己的 agy 对话，权限沿用该对话所在项目" };
  return { value: profile.project_access || "read", editable: view.value.access?.can_manage && view.value.launch.available };
}

/** Switch one member's project files; the change applies from its next request and keeps its session. */
async function switch_access(member, project_access) {
  if (switching.value || files(member).value === project_access) return;
  switching.value = member.name;
  result.value = { tone: "", text: "" };
  try {
    await bridge.set_member_access({ name: member.name, project_access });
    result.value = { tone: "", text: `${bridge.display_name(member.name)} 已改为${project_access === "write" ? "可写" : "只读"}，下次处理请求起生效。` };
  } catch (error) { result.value = { tone: "error", text: error.message }; }
  finally { switching.value = ""; }
}

/** The smart scheduler lives in the local registration, so a page without the local service cannot tell. */
const scheduler = computed(() => {
  if (!saved.value || saved.value.loading) return saved.value?.loading ? "读取中" : "未获取（需连接本机服务）";
  if (!saved.value.registered) return "未获取（本机未登记此房间）";
  if (!saved.value.scheduler) return "未开启";
  const provider = view.value.launch.scheduler_providers?.[saved.value.scheduler.provider]?.label || saved.value.scheduler.provider;
  return `${provider} · ${saved.value.scheduler.model}`;
});
const created = computed(() => room.value.created_at ? new Date(room.value.created_at).toLocaleString("zh-CN", { hour12: false }) : "");
</script>

<template>
  <section class="content-page room-overview" role="tabpanel" aria-label="房间概况">
    <div class="page-heading"><div><h2>房间概况</h2><p>成员与协作设置。项目文件权限可在此切换；邀请、离开、移除与更换主持在右栏成员菜单。</p></div></div>
    <section class="overview-section">
      <h3>成员</h3>
      <div class="overview-table" role="table" aria-label="成员">
        <div class="overview-row overview-head" role="row"><span role="columnheader">成员</span><span role="columnheader">接入</span><span role="columnheader">模型</span><span role="columnheader">项目文件</span><span role="columnheader">状态</span></div>
        <div v-for="member in members" :key="member.name" class="overview-row" role="row">
          <div class="overview-member" role="cell">
            <UAvatar :src="bridge.identities[member.name]?.icon" :text="bridge.identities[member.name]?.initials" :alt="member.name" size="sm" class="channel-avatar" :class="bridge.identities[member.name]?.style" />
            <div class="overview-member-copy"><strong>{{ bridge.display_name(member.name) }}<UIcon v-if="member.role === 'host'" name="i-lucide-crown" title="主持人" /></strong><small v-if="room.descriptions?.[member.name]" :title="room.descriptions[member.name]">{{ room.descriptions[member.name] }}</small></div>
          </div>
          <span role="cell" data-label="接入">{{ access_label(member) }}</span>
          <span role="cell" data-label="模型" class="overview-model" :title="bridge.participant_model(member.name, room, saved) || undefined">{{ member.access === 'runner' ? bridge.participant_model(member.name, room, saved) || '未获取' : '—' }}</span>
          <div role="cell" data-label="项目文件">
            <div v-if="files(member).value" class="expert-card-modes overview-access" role="radiogroup" :aria-label="`${member.name} 的项目文件权限`" :aria-busy="switching === member.name">
              <button v-for="option in ACCESS_OPTIONS" :key="option.value" type="button" role="radio" :aria-checked="files(member).value === option.value"
                :disabled="!files(member).editable || Boolean(switching)" @click="switch_access(member, option.value)">{{ option.label }}</button>
            </div>
            <span v-else class="overview-muted" :title="files(member).hint">{{ files(member).text }}</span>
          </div>
          <span role="cell" data-label="状态">{{ member.access === 'manual' && !member.registered_at ? '待注册' : STATUS_LABELS[member.status] || member.status }}</span>
        </div>
      </div>
      <p v-if="result.text" class="overview-result" :class="{ 'is-error': result.tone === 'error' }" :role="result.tone === 'error' ? 'alert' : 'status'">{{ result.text }}</p>
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
.overview-section h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; color: var(--ui-text-highlighted); }
.overview-table { border: 1px solid var(--ui-border); border-radius: 8px; font-size: 13px; }
.overview-row { display: grid; grid-template-columns: minmax(150px, 1.3fr) minmax(70px, 0.6fr) minmax(120px, 1.4fr) 112px 56px; gap: 12px; align-items: center; padding: 10px 14px; color: var(--ui-text); }
.overview-row + .overview-row { border-top: 1px solid var(--ui-border); }
.overview-head { padding-block: 8px; color: var(--ui-text-muted); font-size: 12px; }
.overview-member { display: flex; align-items: center; gap: 10px; min-width: 0; }
.overview-member-copy { display: grid; min-width: 0; }
.overview-member-copy strong { display: flex; align-items: center; gap: 5px; font-weight: 600; color: var(--ui-text-highlighted); }
.overview-member-copy strong .iconify { color: var(--ui-warning, #e5b54a); }
.overview-member-copy small, .overview-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.overview-member-copy small { color: var(--ui-text-muted); font-size: 12px; }
.overview-muted { color: var(--ui-text-muted); }
.overview-access button:disabled { cursor: default; }
.overview-access button:disabled:not([aria-checked="true"]) { opacity: 0.55; }
.overview-result { margin: 8px 0 0; color: var(--ui-text-muted); font-size: 12px; }
.overview-result.is-error { color: var(--ui-error); }
.overview-settings { display: grid; gap: 10px; margin: 0; font-size: 13px; }
.overview-settings div { display: flex; gap: 8px; }
.overview-settings dt { flex: none; width: 112px; color: var(--ui-text-muted); }
.overview-settings dd { margin: 0; color: var(--ui-text); }
@media (max-width: 720px) {
  .overview-head { display: none; }
  .overview-row { grid-template-columns: 1fr 1fr; }
  .overview-member { grid-column: 1 / -1; }
  .overview-row [data-label]::before { display: block; color: var(--ui-text-muted); font-size: 11px; content: attr(data-label); }
}
</style>
