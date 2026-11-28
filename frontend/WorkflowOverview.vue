<script setup>
/**
 * The 工作流 page's list (#15672, laid out as #15749): a row of filters (全部, 全局, then each project that has
 * workflows) with 新建 and 导入 at the top right, and every workflow as a large card: its canvas as a thumbnail, then its
 * name, description, line-up and state. A card opens its canvas; its own menu renames, stops, deletes, exports, moves or
 * copies it (`workflow-library.js`), not a second copy of those actions.
 */
import { computed, inject } from "vue";
import { use_workflow_library, workflow_key, workflow_problem } from "./workflow-library.js";
import HelpTip from "./HelpTip.vue";
import WorkflowThumb from "./WorkflowThumb.vue";
import WorkflowTrustDialog from "./WorkflowTrustDialog.vue";
import { t } from "./i18n.js";

const library = use_workflow_library();
const { bridge } = inject("discussion");
const { available, global_workflows, project_workflows, project_roots, writable_roots, all_list, all_global, all_project, all_roots, overview_filter, renaming, rename_text, pending_items, trusting, trust_submitting } = library;

// 全局 first, then one group per saved project that has workflows; empty groups are not shown (#15723: 新建 and 复制到项目
// pick the project from their own menus). Until the computer's full list is read (or on an older computer without it),
// the open room's projects stand in.
const groups = computed(() => {
  if (all_list.value) {
    return [{ key: "global", label: t("全局"), items: all_global.value },
      ...all_roots.value.map((root) => ({ key: `project:${root.id}`, label: root.name || t("未命名项目"),
        items: all_project.value.filter((item) => item.project_id === root.id) }))].filter((group) => group.items.length);
  }
  const projects = new Map();
  for (const item of project_workflows.value) {
    const key = item.project_id || item.project_name || "";
    if (!projects.has(key)) projects.set(key, { key: `project:${key}`, label: item.project_name || t("未命名项目"), items: [] });
    projects.get(key).items.push(item);
  }
  return [{ key: "global", label: t("全局"), items: global_workflows.value }, ...projects.values()].filter((group) => group.items.length);
});
// The filters: 全部, then each group. A project asked for by name (管理 in its room) keeps its filter while it has no
// workflow yet, so 新建 there goes to it; any other filter whose group is gone falls back to 全部.
const filters = computed(() => {
  const list = groups.value.map((group) => ({ key: group.key, label: group.label, count: group.items.length }));
  const wanted = overview_filter.value;
  if (wanted.startsWith("project:") && !list.some((item) => item.key === wanted)) {
    const root = [...all_roots.value, ...project_roots.value].find((item) => `project:${item.id}` === wanted);
    if (root) list.push({ key: wanted, label: root.name || t("未命名项目"), count: 0 });
  }
  return [{ key: "all", label: t("全部"), count: groups.value.reduce((sum, group) => sum + group.items.length, 0) }, ...list];
});
const filter = computed(() => filters.value.some((item) => item.key === overview_filter.value) ? overview_filter.value : "all");
// Under 全部 a card says where it lives (全局 or its project); under one filter that is already known.
const cards = computed(() => groups.value.filter((group) => filter.value === "all" || group.key === filter.value)
  .flatMap((group) => group.items.map((item) => ({ item, home: filter.value === "all" ? group.label : "" }))));
// With one place chosen, 新建 creates there at once; a read-only project, or 全部, keeps the menu of places.
const create_target = computed(() => {
  if (filter.value === "global") return { scope: "global" };
  const project_id = filter.value.startsWith("project:") ? filter.value.slice("project:".length) : "";
  return project_id && writable_roots.value.some((root) => root.id === project_id) ? { scope: "project", project_id } : null;
});

// 新建 and 导入 from the library's own menu: its import entries open files, the rest start a blank workflow.
const IMPORT_ICONS = new Set(["i-lucide-file-archive", "i-lucide-folder-input"]);
const create_items = computed(() => library.add_items.value.map((group) => group.filter((item) => !IMPORT_ICONS.has(item.icon))).filter((group) => group.length));
const import_items = computed(() => library.add_items.value.map((group) => group.filter((item) => IMPORT_ICONS.has(item.icon))).filter((group) => group.length));
const single_create = computed(() => create_items.value.flat().length === 1 ? create_items.value[0][0] : null);

/** The card's state in a word; empty when it is ready to use. */
function state_label(item) {
  if (item.error) return t("无法读取");
  if (item.disabled) return t("已停用");
  if (item.unavailable?.length) return t("{count} 张卡片不可用", { count: item.unavailable.length });
  if (item.needs_trust) return t("待信任");
  if (item.readonly) return t("只读");
  return "";
}
// "待信任" opens the trust prompt itself (#16106), the same one as the card's menu and the room's "/".
const awaits_trust = (item) => state_label(item) === t("待信任");
const state_tone = (item) => item.error || item.unavailable?.length ? "warn" : item.needs_trust ? "trust" : "";
// Experts across the main flow and its sub-workflows (`total_cards`); an older list only counts the main flow (`cards`).
const expert_count = (item) => item.total_cards ?? item.cards ?? 0;
const sub_count = (item) => item.sub_workflow_count || 0;
// The workflow's line-up as its software's faces, one per platform in card order, the rest as "+n" (#15685). It needs the
// list to name each card's platform (`card_platforms`); until then the card counts its experts in words.
const LINEUP_SHOWN = 4;
function lineup(item) {
  if (!Array.isArray(item.card_platforms) || !item.card_platforms.length) return null;
  const platforms = [...new Set(item.card_platforms)];
  return { faces: platforms.slice(0, LINEUP_SHOWN).map((name) => ({ name, ...bridge.identities[name] })), more: Math.max(0, platforms.length - LINEUP_SHOWN) };
}
</script>

<template>
  <section class="workflow-overview" :aria-label="t('工作流')">
    <header class="workflow-overview-head">
      <div class="workflow-overview-filters" role="group" :aria-label="t('筛选工作流')">
        <button v-for="item in filters" :key="item.key" type="button" class="workflow-overview-filter" :aria-pressed="filter === item.key" @click="overview_filter = item.key">{{ item.label }}<small>{{ item.count }}</small></button>
        <HelpTip :text="t('在房间里用输入框的“/”或右栏启用。')" />
      </div>
      <div v-if="available" class="workflow-overview-actions">
        <UButton v-if="create_target || single_create" icon="i-lucide-plus" :label="t('新建')" size="sm" class="channel-primary-button" @click="create_target ? library.create_blank(create_target) : single_create.onSelect()" />
        <UDropdownMenu v-else :items="create_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-plus" trailing-icon="i-lucide-chevron-down" :label="t('新建')" size="sm" class="channel-primary-button" />
        </UDropdownMenu>
        <UDropdownMenu :items="import_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-download" trailing-icon="i-lucide-chevron-down" :label="t('导入')" size="sm" color="neutral" variant="soft" />
        </UDropdownMenu>
      </div>
    </header>
    <p v-if="!available" class="workflow-overview-empty">{{ t("连接本机服务后管理工作流") }}</p>
    <p v-else-if="!groups.length && filter === 'all'" class="workflow-overview-empty">{{ t("还没有工作流。点右上角“新建”，或导入别人分享的工作流。") }}</p>
    <p v-else-if="!cards.length" class="workflow-overview-empty">{{ t("这里还没有工作流，点右上角“新建”。") }}</p>
    <ul v-else class="workflow-overview-grid">
      <li v-for="{ item, home } in cards" :key="workflow_key(item)" class="workflow-overview-card" :class="{ 'is-disabled': item.disabled, 'is-pending': pending_items.has(workflow_key(item)) }">
        <!-- The picture and the name both open the canvas; the words between them are read, not clicked. -->
        <button type="button" class="workflow-overview-thumb" tabindex="-1" aria-hidden="true" @click="library.select(item)"><WorkflowThumb :flow="library.flow_of(item)" /></button>
        <div class="workflow-overview-body">
          <span v-if="renaming === workflow_key(item)" class="workflow-overview-rename">
            <input v-model="rename_text" data-workflow-rename :maxlength="32" :aria-label="t('新名称')" @keydown.enter.prevent="library.commit_rename" @keydown.esc.prevent="renaming = ''" @blur="library.commit_rename" />
          </span>
          <button v-else type="button" class="workflow-overview-open" :title="workflow_problem(item) || item.label" @click="library.select(item)">
            <UIcon v-if="pending_items.has(workflow_key(item))" name="i-lucide-loader-circle" class="animate-spin" /><strong>{{ item.label }}</strong>
          </button>
          <p class="workflow-overview-desc" :title="item.description || undefined">{{ item.description || t("还没有说明") }}</p>
          <p class="workflow-overview-meta">
            <span v-if="lineup(item)" class="workflow-overview-lineup" :title="t('{count} 位专家', { count: expert_count(item) })">
              <UAvatar v-for="face in lineup(item).faces" :key="face.name" :src="face.icon" :text="face.initials" :alt="face.name" size="2xs" class="channel-avatar" :class="face.style" />
              <small v-if="lineup(item).more">+{{ lineup(item).more }}</small>
            </span>
            <span v-else>{{ t("{count} 位专家", { count: expert_count(item) }) }}</span>
            <span v-if="sub_count(item)">{{ t("{count} 个子工作流", { count: sub_count(item) }) }}</span>
            <button v-if="awaits_trust(item)" type="button" class="workflow-overview-state is-action" data-tone="trust" :title="t('查看并信任')" @click="trusting = item">{{ state_label(item) }}</button>
            <span v-else-if="state_label(item)" class="workflow-overview-state" :data-tone="state_tone(item)">{{ state_label(item) }}</span>
            <span v-if="home" class="workflow-overview-home">{{ home }}</span>
          </p>
          <UDropdownMenu v-if="renaming !== workflow_key(item)" :disabled="pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-topic-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" class="workflow-overview-menu" :aria-label="t('「{name}」的更多操作', { name: item.label })" :title="t('更多操作')" />
          </UDropdownMenu>
        </div>
      </li>
    </ul>
    <WorkflowTrustDialog :prompt="trusting" :submitting="trust_submitting" @confirm="library.confirm_trust" @cancel="trusting = null" />
  </section>
</template>

<style scoped>
/* Large cards, three to a row on a wide screen (#15749): the canvas as a picture on top, the words below. */
.workflow-overview { display: grid; gap: 20px; align-content: start; width: min(100%, 1320px); margin: 0 auto; padding: 24px 28px 40px; }
.workflow-overview-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.workflow-overview-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.workflow-overview-filter { display: inline-flex; flex-shrink: 0; align-items: center; gap: 6px; max-width: 220px; height: 30px; padding: 0 12px; overflow: hidden; border: 1px solid var(--ui-border-muted); border-radius: 999px; color: var(--ui-text-toned); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; transition: background .12s, border-color .12s, color .12s; }
.workflow-overview-filter > small { color: var(--ui-text-dimmed); font-size: 11px; }
@media (hover: hover) { .workflow-overview-filter:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); } }
.workflow-overview-filter[aria-pressed="true"] { border-color: transparent; background: var(--channel-ghost-active, color-mix(in srgb, var(--ui-text) 12%, transparent)); color: var(--ui-text-highlighted); font-weight: 600; }
.workflow-overview-actions { display: flex; gap: 8px; }
.workflow-overview-empty { margin: 0; padding: 48px 0; color: var(--ui-text-muted); font-size: 14px; text-align: center; }
.workflow-overview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px; margin: 0; padding: 0; list-style: none; }
.workflow-overview-card { display: flex; flex-direction: column; min-width: 0; overflow: hidden; border: 1px solid var(--ui-border-muted); border-radius: 14px; background: color-mix(in srgb, var(--ui-text) 3%, transparent); transition: border-color .12s, background .12s; }
@media (hover: hover) { .workflow-overview-card:hover { border-color: var(--ui-border-accented); background: color-mix(in srgb, var(--ui-text) 5%, transparent); } }
.workflow-overview-card.is-disabled { opacity: .55; }
.workflow-overview-thumb { display: block; width: 100%; aspect-ratio: 16 / 8; padding: 14px 18px; border-bottom: 1px solid var(--ui-border-muted); background: color-mix(in srgb, var(--ui-text) 4%, transparent); }
.workflow-overview-body { position: relative; display: grid; gap: 6px; min-width: 0; padding: 12px 16px 14px; }
.workflow-overview-open { display: flex; align-items: center; gap: 8px; min-width: 0; margin-right: 28px; text-align: left; }
.workflow-overview-open > strong { min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 15px; text-overflow: ellipsis; white-space: nowrap; }
.workflow-overview-open > :deep(svg) { flex-shrink: 0; width: 15px; height: 15px; color: var(--ui-text-dimmed); }
@media (hover: hover) { .workflow-overview-open:hover > strong { text-decoration: underline; text-underline-offset: 3px; } }
.workflow-overview-desc { display: -webkit-box; min-height: 2.9em; margin: 0; overflow: hidden; color: var(--ui-text-toned); font-size: 13px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.workflow-overview-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 22px; margin: 2px 0 0; color: var(--ui-text-dimmed); font-size: 12px; }
.workflow-overview-home { max-width: 100%; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workflow-overview-lineup { display: inline-flex; align-items: center; }
.workflow-overview-lineup > :deep(.channel-avatar) { width: 20px; height: 20px; box-shadow: 0 0 0 2px var(--ui-bg); }
.workflow-overview-lineup > :deep(.channel-avatar + .channel-avatar) { margin-left: -6px; }
.workflow-overview-lineup > small { margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; }
.workflow-overview-state { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 7%, transparent); color: var(--ui-text-muted); }
.workflow-overview-state[data-tone="warn"] { background: color-mix(in srgb, var(--ui-warning) 16%, transparent); color: var(--ui-warning); }
.workflow-overview-state.is-action { border: 0; font: inherit; cursor: pointer; }
@media (hover: hover) { .workflow-overview-state.is-action:hover { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 28%, transparent); } }
.workflow-overview-state[data-tone="trust"] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--channel-accent, var(--ui-primary)); }
.workflow-overview-menu { position: absolute; top: 8px; right: 10px; }
.workflow-overview-rename { display: flex; }
.workflow-overview-rename input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 6px; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 14px; outline: none; }
@media (max-width: 560px) { .workflow-overview { padding: 16px 14px 32px; } .workflow-overview-grid { grid-template-columns: minmax(0, 1fr); } }
</style>
