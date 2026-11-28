<script setup>
/**
 * One group window's own settings (`steward.windows["<channel>:<chat_id>"]`), shared by the group list in MOSS settings
 * (§8.1) and the group window's own settings dialog (§12): what the group is, how MOSS talks there, what others may make
 * it do, its daily budgets, the one directory it may read, its model, and which skills it gets.
 *
 * Props: `value` (the saved fields), `usedToday` / `tasksToday` (today's counts from the computer), `adapter` / `platform`
 * (MOSS's software, for the model list and what it can and cannot be kept from reading), `skills` (the group's candidates,
 * `steward.group_skills`: `[{id, platform}]`). Emits `update` with a patch; a field set back to its default comes as null.
 */
import { computed, inject } from "vue";
import { adapter_capabilities } from "../runner/adapters/profiles.mjs";
import HelpTip from "./HelpTip.vue";
import ModelEffortPicker from "./ModelEffortPicker.vue";
import ProjectDirectoryField from "./ProjectDirectoryField.vue";
import { WINDOW_DEFAULTS } from "./moss.js";
import { is_platform_skill as is_platform, skill_label } from "./moss-skills.js";
import { t } from "./i18n.js";

const props = defineProps({ value: { type: Object, default: () => ({}) }, usedToday: { type: Number, default: 0 }, tasksToday: { type: Number, default: 0 },
  adapter: { type: String, default: "" }, platform: { type: String, default: "" }, skills: { type: Array, default: () => [] } });
const emit = defineEmits(["update"]);
const { view } = inject("discussion");

const TEXT_LIMIT = 500;
const DEFAULT_DAILY_LIMIT = WINDOW_DEFAULTS.daily_limit;
// Rooms MOSS may open for others' requests in a day (§12.5); the owner's own do not count.
const DEFAULT_DAILY_TASKS = WINDOW_DEFAULTS.daily_tasks;
// What others may make it do (§5A.4); 小事直接做 by default since the group can hand bigger work to a room (§12.5).
const DEFAULT_WORK_POLICY = WINDOW_DEFAULTS.work_policy;
const WORK_POLICIES = [
  { value: "answer", label: t("只回答问题"), hint: t("别人让它做事时，先在群里问你") },
  { value: "small", label: t("小事直接做"), hint: t("估计超过一两分钟或要多处查找的，先问你") },
  { value: "all", label: t("都直接做"), hint: t("花的是你的额度") },
];

const policy = computed(() => props.value.work_policy || DEFAULT_WORK_POLICY);
/** A count box: a cleared box is the default, 0 is a real choice. */
function count_patch(field, value, fallback) {
  const number = value === "" || value == null ? NaN : Math.round(Number(value));
  emit("update", { [field]: Number.isFinite(number) && number >= 0 && number !== fallback ? number : null });
}
const profile = computed(() => ({ ...(view.value.launch.profiles?.[props.platform] || {}), adapter: props.adapter, model: props.value.model || "", effort: props.value.effort || "" }));
// Whether the software can be kept from the rest of this computer (§12.6): it may join either way, the page says which.
const confines = computed(() => Boolean(props.adapter) && adapter_capabilities(props.adapter).confines_reads === true);
const chosen_skills = computed(() => new Set(props.value.skills || []));
function allow_skill(id, allowed) {
  const selected = new Set(chosen_skills.value);
  if (allowed) selected.add(id); else selected.delete(id);
  emit("update", { skills: props.skills.map((skill) => skill.id).filter((item) => selected.has(item)) });
}
</script>

<template>
  <div class="moss-group-fields">
    <UFormField :label="t('群说明')" :description="t('这个群是什么群、里面是谁、MOSS 在这里的角色、可以答应什么。')">
      <UTextarea :model-value="value.about || ''" :maxlength="TEXT_LIMIT" :rows="2" autoresize :maxrows="6" class="w-full" @update:model-value="emit('update', { about: $event })" />
    </UFormField>
    <UFormField :label="t('说话方式')">
      <UTextarea :model-value="value.habit || ''" :maxlength="TEXT_LIMIT" :rows="2" autoresize :maxrows="6" class="w-full" :placeholder="t('留空用群的默认说话方式')" @update:model-value="emit('update', { habit: $event })" />
    </UFormField>
    <div class="moss-group-field">
      <span class="moss-group-label">{{ t("别人让它做事时") }}<HelpTip :text="t('你本人让它做的事不受这一项限制。选“小事直接做”时，判断不出是不是大事，由每天的委托上限兜底。没配置智能调度时，这一项只靠 MOSS 自己遵守。')" /></span>
      <div class="moss-group-pills" role="radiogroup" :aria-label="t('别人让它做事时')">
        <button v-for="item in WORK_POLICIES" :key="item.value" type="button" role="radio" :title="item.hint" :aria-checked="policy === item.value"
          :class="{ 'is-selected': policy === item.value }" @click="emit('update', { work_policy: item.value })">{{ item.label }}</button>
      </div>
    </div>
    <div class="moss-group-counts">
      <div class="moss-group-field">
        <span class="moss-group-label">{{ t("每天最多叫它几次") }}<HelpTip :text="t('用完后当天不再回应其他人，并私聊告诉你一次；你本人的请求不计入。')" /></span>
        <div class="moss-group-count"><UInput type="number" size="sm" :min="0" :max="999" :model-value="value.daily_limit ?? DEFAULT_DAILY_LIMIT" :aria-label="t('每天最多叫它几次')" @update:model-value="count_patch('daily_limit', $event, DEFAULT_DAILY_LIMIT)" />
          <small>{{ t("今天已用 {count} 次", { count: usedToday }) }}</small></div>
      </div>
      <div class="moss-group-field">
        <span class="moss-group-label">{{ t("每天最多委托几个房间") }}<HelpTip :text="t('别人让它做的大事，它新建房间交给成员去做，做完把结果发回群里。用完后改为先在群里问你；你本人的不计入。')" /></span>
        <div class="moss-group-count"><UInput type="number" size="sm" :min="0" :max="99" :model-value="value.daily_tasks ?? DEFAULT_DAILY_TASKS" :aria-label="t('每天最多委托几个房间')" @update:model-value="count_patch('daily_tasks', $event, DEFAULT_DAILY_TASKS)" />
          <small>{{ t("今天已委托 {count} 个", { count: tasksToday }) }}</small></div>
      </div>
    </div>
    <div class="moss-group-field">
      <span class="moss-group-label">{{ t("可读目录") }}<HelpTip :text="t('群里的 MOSS 只能读这一个目录，不能改；不选就不能读你的任何项目。')" /></span>
      <ProjectDirectoryField compact :model-value="value.read_directory || ''" :placeholder="t('不选：不读任何项目')" @update:model-value="emit('update', { read_directory: $event || null })" />
    </div>
    <div v-if="platform" class="moss-group-field moss-group-model">
      <span class="moss-group-label">{{ t("模型与强度") }}<HelpTip :text="t('群里默认用便宜的配置，不跟私聊走。')" /></span>
      <ModelEffortPicker :key="adapter" :name="platform" :profile="profile" portable
        @model="emit('update', { model: $event === '__default__' ? null : String($event || '').trim(), effort: null })"
        @effort="emit('update', { effort: $event })" @reset="emit('update', { model: null, effort: null })" />
      <p class="moss-group-note" :class="{ 'is-warn': !confines }">{{ confines ? t("这个软件在群里固定只读，读不到本机其他文件。") : t("这个软件在群里固定只读，但仍能读到本机其他文件，程序拦不住；介意的话换一个软件。") }}</p>
    </div>
    <div class="moss-group-field">
      <span class="moss-group-label">{{ t("这个群可用的技能") }}<HelpTip :text="t('只列出勾选的技能；安装、部署、配置类只在主理人里可用。未勾选的全局技能，软件仍可能自行使用。')" /></span>
      <div class="moss-group-skills">
        <UCheckbox v-for="skill in skills" :key="skill.id" :label="skill_label(skill)" :disabled="skill.available === false || is_platform(skill)"
          :description="is_platform(skill) ? t('只在主理人里可用') : undefined" :model-value="!is_platform(skill) && chosen_skills.has(skill.id)" @update:model-value="allow_skill(skill.id, $event)" />
        <p v-if="!skills.length" class="moss-group-note">{{ t("没有可选的技能。") }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.moss-group-fields { display: grid; gap: 12px; min-width: 0; }
.moss-group-field { display: grid; gap: 6px; min-width: 0; }
.moss-group-label { display: flex; align-items: center; color: var(--ui-text-toned); font-size: 13px; }
.moss-group-note { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.55; }
.moss-group-note.is-warn { color: var(--ui-warning); }
/* The same pills as MOSS's other one-of choices. */
.moss-group-pills { display: flex; flex-wrap: wrap; gap: 6px; }
.moss-group-pills > button { display: inline-flex; align-items: center; min-height: 30px; padding: 3px 12px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-toned); font-size: 13px; transition: background .12s, border-color .12s, color .12s; }
@media (hover: hover) { .moss-group-pills > button:hover { border-color: var(--ui-border-accented); color: var(--ui-text-highlighted); } }
.moss-group-pills > button.is-selected { border-color: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 70%, transparent); background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); color: var(--ui-text-highlighted); font-weight: 600; }
/* The two daily budgets side by side on a desktop, stacked on a phone. */
.moss-group-counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 560px) { .moss-group-counts { grid-template-columns: minmax(0, 1fr); } }
.moss-group-count { display: flex; align-items: center; gap: 10px; }
.moss-group-count > :deep(div) { width: 88px; flex-shrink: 0; }
.moss-group-count > small { color: var(--ui-text-dimmed); font-size: 12px; }
.moss-group-skills { display: grid; gap: 6px; }
/* The shared model picker, laid out as in MOSS's software card. */
.moss-group-model :deep(.expert-card-field) { display: grid; grid-template-columns: 3em minmax(0, 1fr); align-items: center; gap: 8px; color: var(--ui-text-muted); font-size: 12px; }
.moss-group-model :deep(.expert-card-catalog) { display: flex; gap: 8px; color: var(--ui-text-dimmed); font-size: 11px; }
.moss-group-model :deep(.expert-card-note) { margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.moss-group-model :deep(.expert-card-defaults) { justify-self: start; padding: 0; color: var(--ui-text-muted); font-size: 12px; }
</style>
