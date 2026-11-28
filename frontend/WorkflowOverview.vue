<script setup>
/**
 * The 工作流 page's list (#15672): every workflow as a card, grouped as 全局 and then by project, with 新建 and 导入 at
 * the top right. A card opens its canvas; its own menu renames, stops, deletes, exports, moves or copies it, the same
 * actions the sidebar list had (`workflow-library.js`), not a second copy of them.
 */
import { computed, inject } from "vue";
import { use_workflow_library, workflow_key, workflow_problem } from "./workflow-library.js";
import HelpTip from "./HelpTip.vue";
import { t } from "./i18n.js";

const library = use_workflow_library();
const { bridge } = inject("discussion");
const { available, global_workflows, project_workflows, all_list, all_global, all_project, all_roots, renaming, rename_text, pending_items } = library;

// 全局 first, then one group per saved project, an empty one too (#15679). Until the computer's full list is read (or on
// an older computer without it), the open room's projects stand in.
const groups = computed(() => {
  if (all_list.value) {
    return [...(all_global.value.length ? [{ key: "global", label: t("全局"), items: all_global.value }] : []),
      ...all_roots.value.map((root) => ({ key: `project:${root.id}`, label: t("项目 · {name}", { name: root.name || t("未命名项目") }),
        items: all_project.value.filter((item) => item.project_id === root.id), empty: t("这个项目还没有工作流") }))];
  }
  const projects = new Map();
  for (const item of project_workflows.value) {
    const key = item.project_id || item.project_name || "";
    if (!projects.has(key)) projects.set(key, { key: `project:${key}`, label: t("项目 · {name}", { name: item.project_name || t("未命名项目") }), items: [] });
    projects.get(key).items.push(item);
  }
  return [{ key: "global", label: t("全局"), items: global_workflows.value }, ...projects.values()].filter((group) => group.items.length);
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
      <span class="workflow-overview-hint">{{ t("全部工作流") }}<HelpTip :text="t('在房间里用输入框的“/”或右栏启用。')" /></span>
      <div v-if="available" class="workflow-overview-actions">
        <UButton v-if="single_create" icon="i-lucide-plus" :label="t('新建')" size="sm" class="channel-primary-button" @click="single_create.onSelect()" />
        <UDropdownMenu v-else :items="create_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-plus" trailing-icon="i-lucide-chevron-down" :label="t('新建')" size="sm" class="channel-primary-button" />
        </UDropdownMenu>
        <UDropdownMenu :items="import_items" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu' }">
          <UButton icon="i-lucide-download" trailing-icon="i-lucide-chevron-down" :label="t('导入')" size="sm" color="neutral" variant="soft" />
        </UDropdownMenu>
      </div>
    </header>
    <p v-if="!available" class="workflow-overview-empty">{{ t("连接本机服务后管理工作流") }}</p>
    <p v-else-if="!groups.some((group) => group.items.length)" class="workflow-overview-empty">{{ t("还没有工作流。点右上角“新建”，或导入别人分享的工作流。") }}</p>
    <section v-for="group in groups" :key="group.key" class="workflow-overview-group" :aria-label="group.label">
      <h2>{{ group.label }}<span>{{ group.items.length }}</span></h2>
      <p v-if="!group.items.length" class="workflow-overview-none">{{ group.empty }}</p>
      <ul v-else>
        <li v-for="item in group.items" :key="workflow_key(item)" class="workflow-overview-card" :class="{ 'is-disabled': item.disabled, 'is-pending': pending_items.has(workflow_key(item)) }">
          <span v-if="renaming === workflow_key(item)" class="workflow-overview-rename">
            <input v-model="rename_text" data-workflow-rename :maxlength="32" :aria-label="t('新名称')" @keydown.enter.prevent="library.commit_rename" @keydown.esc.prevent="renaming = ''" @blur="library.commit_rename" />
          </span>
          <button v-else type="button" class="workflow-overview-open" :title="workflow_problem(item) || item.description || item.label" @click="library.select(item)">
            <strong><UIcon :name="pending_items.has(workflow_key(item)) ? 'i-lucide-loader-circle' : 'i-lucide-network'" :class="{ 'animate-spin': pending_items.has(workflow_key(item)) }" />{{ item.label }}</strong>
            <span class="workflow-overview-desc">{{ item.description || t("还没有说明") }}</span>
            <span class="workflow-overview-meta">
              <span v-if="lineup(item)" class="workflow-overview-lineup" :title="t('{count} 位专家', { count: expert_count(item) })">
                <UAvatar v-for="face in lineup(item).faces" :key="face.name" :src="face.icon" :text="face.initials" :alt="face.name" size="2xs" class="channel-avatar" :class="face.style" />
                <small v-if="lineup(item).more">+{{ lineup(item).more }}</small>
              </span>
              <span v-else>{{ t("{count} 位专家", { count: expert_count(item) }) }}</span>
              <span v-if="sub_count(item)">{{ t("{count} 个子工作流", { count: sub_count(item) }) }}</span>
              <span v-if="state_label(item)" class="workflow-overview-state" :data-tone="state_tone(item)">{{ state_label(item) }}</span>
            </span>
          </button>
          <UDropdownMenu v-if="renaming !== workflow_key(item)" :disabled="pending_items.has(workflow_key(item))" :items="library.item_menu(item)" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'channel-menu channel-topic-menu' }">
            <UButton icon="i-lucide-ellipsis" size="xs" color="neutral" variant="ghost" class="workflow-overview-menu" :aria-label="t('「{name}」的更多操作', { name: item.label })" :title="t('更多操作')" />
          </UDropdownMenu>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
/* The cards fill the page's width, three or four to a row on a wide screen (#15685). */
.workflow-overview { display: grid; gap: 24px; align-content: start; width: min(100%, 1320px); margin: 0 auto; padding: 24px 28px 40px; }
.workflow-overview-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.workflow-overview-hint { display: flex; align-items: center; color: var(--ui-text-toned); font-size: 14px; }
.workflow-overview-actions { display: flex; gap: 8px; }
.workflow-overview-none { margin: 0; color: var(--ui-text-dimmed); font-size: 13px; }
.workflow-overview-empty { margin: 0; padding: 32px 0; color: var(--ui-text-muted); font-size: 14px; text-align: center; }
.workflow-overview-group { display: grid; gap: 10px; }
.workflow-overview-group > h2 { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--ui-text-highlighted); font-size: 14px; font-weight: 600; }
.workflow-overview-group > h2 > span { color: var(--ui-text-dimmed); font-size: 12px; font-weight: 400; }
.workflow-overview-group ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.workflow-overview-card { position: relative; display: flex; min-width: 0; border: 1px solid var(--ui-border-muted); border-radius: 12px; background: color-mix(in srgb, var(--ui-text) 3%, transparent); transition: border-color .12s, background .12s; }
@media (hover: hover) { .workflow-overview-card:hover { border-color: var(--ui-border); background: color-mix(in srgb, var(--ui-text) 5%, transparent); } }
.workflow-overview-card.is-disabled { opacity: .6; }
.workflow-overview-open { display: grid; gap: 8px; flex: 1; min-width: 0; padding: 16px 40px 14px 16px; text-align: left; }
.workflow-overview-open > strong { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; color: var(--ui-text-highlighted); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.workflow-overview-open > strong > :deep(svg) { flex-shrink: 0; width: 15px; height: 15px; color: var(--ui-text-dimmed); }
.workflow-overview-desc { display: -webkit-box; min-height: 2.9em; overflow: hidden; color: var(--ui-text-toned); font-size: 13px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.workflow-overview-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.workflow-overview-lineup { display: inline-flex; align-items: center; }
.workflow-overview-lineup > :deep(.channel-avatar) { width: 20px; height: 20px; box-shadow: 0 0 0 2px var(--ui-bg); }
.workflow-overview-lineup > :deep(.channel-avatar + .channel-avatar) { margin-left: -6px; }
.workflow-overview-lineup > small { margin-left: 4px; color: var(--ui-text-muted); font-size: 11px; }
.workflow-overview-state { padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--ui-text) 7%, transparent); color: var(--ui-text-muted); }
.workflow-overview-state[data-tone="warn"] { background: color-mix(in srgb, var(--ui-warning) 16%, transparent); color: var(--ui-warning); }
.workflow-overview-state[data-tone="trust"] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--channel-accent, var(--ui-primary)); }
.workflow-overview-menu { position: absolute; top: 8px; right: 8px; }
.workflow-overview-rename { display: flex; flex: 1; padding: 12px; }
.workflow-overview-rename input { flex: 1; min-width: 0; height: 30px; padding: 0 8px; border: 1px solid var(--channel-accent, var(--ui-primary)); border-radius: 6px; background: var(--ui-bg); color: var(--ui-text-highlighted); font-size: 14px; outline: none; }
@media (max-width: 560px) { .workflow-overview { padding: 16px 14px 32px; } .workflow-overview-group ul { grid-template-columns: minmax(0, 1fr); } }
</style>
