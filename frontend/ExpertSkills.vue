<script setup>
/**
 * 技能: an expert's skills (user 2026-11-22), shown under its definition in the workflow's 专家配置 and on a panel
 * preset's card. `source` names the expert to the local service: `{ workflow, card }` for a saved folder card, or
 * `{ preset }`. Files are read and written one at a time through the service (`skills`, `skill-write`, `skill-delete`,
 * `skill-remove`), never through the workflow's save; each write names the digest it read, and a file the expert
 * changed meanwhile is refused with a reload offered instead of overwriting it. Deleting asks a second click.
 * The files show in the shared SkillFiles view (user 2026-11-24): the top lists the skills as folders with their
 * descriptions; a file is created in any folder inside a skill.
 */
import { computed, inject, ref, watch } from "vue";
import SkillFiles from "./SkillFiles.vue";
import { t } from "./i18n.js";

const props = defineProps({
  source: { type: Object, required: true },
  // Why the skills cannot be read yet (e.g. the workflow is not saved); empty when they can.
  blocked: { type: String, default: "" },
});
const { bridge } = inject("discussion");
// A skill's folder name follows the workflow ID rule.
const SKILL_NAME = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const skills = ref([]), loading = ref(false), failure = ref(""), changed = ref(false);
const location = ref("");
const adding = ref(false), new_name = ref(""), new_description = ref("");
const key = computed(() => JSON.stringify(props.source));
const files = computed(() => skills.value.flatMap((skill) => skill.files));
const digests = computed(() => new Map(files.value.map((item) => [item.path, item.digest])));
const notes = computed(() => Object.fromEntries(skills.value.map((skill) => [skill.name, skill.description])));

function request(action, input = {}) {
  return bridge.local_request("workflows", { action, ...props.source, ...input });
}

/** Read every skill again; the folder or file shown stays shown. */
async function load() {
  if (props.blocked) return;
  loading.value = true;
  try {
    skills.value = (await request("skills")).skills;
    failure.value = ""; changed.value = false;
  } catch (error) { failure.value = error.message; skills.value = []; }
  finally { loading.value = false; }
}

/** A refusal because the expert changed the file shows the reload offer; any other is a notice. Rethrows for the view. */
function refused(error) {
  if (error.code === "skill_changed") changed.value = true;
  bridge.notify(error.code === "skill_changed" ? "warning" : "error", error.message);
  throw error;
}

async function save(path, text) {
  try {
    await request("skill-write", { path, text, digest: digests.value.get(path) || "" });
    bridge.notify("info", t("已保存 {value1}", { value1: path }));
  } catch (error) { refused(error); }
  await load();
}

/** A skill at the top goes whole (backed up first); below it, one file at a time. */
async function remove(entry) {
  try {
    if (entry.directory) {
      await request("skill-remove", { skill: entry.path });
      bridge.notify("info", t("已删除技能 {value1}，原来的文件夹已移到服务目录的 backups 下", { value1: entry.path }));
    } else await request("skill-delete", { path: entry.path, digest: entry.digest });
  } catch (error) { refused(error); }
  await load();
}

async function create(folder, name) {
  const path = `${folder}/${name}`;
  try { await request("skill-write", { path, text: "", digest: "" }); } catch (error) { refused(error); }
  await load();
  return path;
}

/** A new skill starts as its SKILL.md with the front matter Agent Skills reads. */
async function add_skill() {
  const name = new_name.value.trim(), description = new_description.value.trim().replace(/\s*\n\s*/g, " ");
  if (!SKILL_NAME.test(name)) return bridge.notify("warning", t("技能名只能用小写英文和数字，可用单个连字符连接，1—40 位"));
  if (!description) return bridge.notify("warning", t("请写一句描述：这条技能管什么"));
  try {
    await request("skill-write", { path: `${name}/SKILL.md`, text: `---\nname: ${name}\ndescription: ${description}\n---\n`, digest: "" });
    adding.value = false; new_name.value = ""; new_description.value = "";
    await load();
    location.value = `${name}/SKILL.md`;
  } catch (error) { try { refused(error); } catch { /* told */ } }
}

watch([key, () => props.blocked], () => { location.value = ""; load(); }, { immediate: true });
</script>

<template>
  <section class="expert-skills" :aria-label="t('技能')">
    <header class="expert-skills-head">
      <span>{{ t("这位专家自己读写的知识；这里的修改直接写入，不需要保存工作流") }}</span>
      <UButton v-if="!blocked" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" :loading="loading" :aria-label="t('重新载入技能')" :title="t('重新载入技能')" @click="load" />
      <UButton v-if="!blocked" :label="t('新建技能')" icon="i-lucide-plus" size="xs" color="neutral" variant="soft" @click="adding = !adding" />
    </header>
    <p v-if="blocked" class="expert-skills-note">{{ blocked }}</p>
    <template v-else>
      <p v-if="failure" class="expert-skills-note is-error">{{ failure }}</p>
      <p v-if="changed" class="expert-skills-note is-warning">{{ t("专家刚改过技能，你看到的不是最新内容。") }}
        <UButton :label="t('重新载入')" size="xs" color="warning" variant="soft" @click="load" /></p>
      <form v-if="adding" class="expert-skills-form" @submit.prevent="add_skill">
        <UInput v-model="new_name" size="sm" :placeholder="t('技能名，如 cold-survival')" :aria-label="t('技能名')" />
        <UInput v-model="new_description" size="sm" class="expert-skills-grow" :placeholder="t('一句描述：这条技能管什么')" :aria-label="t('技能描述')" />
        <UButton type="submit" :label="t('创建')" size="sm" />
      </form>
      <p v-if="!loading && !failure && !skills.length" class="expert-skills-note">{{ t("还没有技能。") }}</p>
      <SkillFiles v-else v-model:location="location" class="expert-skills-files" :files="files" :folders="skills.map((skill) => skill.name)" :notes="notes" :root-label="t('技能')"
        :save="save" :remove="remove" :removable="(entry) => !entry.directory || !entry.path.includes('/')" :create="create" :can-create="(folder) => Boolean(folder)" />
    </template>
  </section>
</template>

<style scoped>
/* Fills its parent's height: the header and notes on top, then the files. */
.expert-skills { display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; }
.expert-skills-head { display: flex; align-items: center; gap: 6px; }
.expert-skills-head > span { flex: 1; min-width: 0; font-size: 12px; color: var(--ui-text-dimmed); }
.expert-skills-note { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.expert-skills-note.is-error { color: var(--ui-error, #e5484d); }
.expert-skills-note.is-warning { color: var(--ui-warning, #e0a33a); }
.expert-skills-form { display: flex; align-items: center; gap: 6px; }
.expert-skills-grow { flex: 1; min-width: 0; }
.expert-skills-files { flex: 1; }
</style>
