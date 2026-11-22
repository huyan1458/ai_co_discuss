<script setup>
/**
 * 技能: an expert's skills (user 2026-11-22), shown under its definition in the workflow's 专家配置 and on a panel
 * preset's card. `source` names the expert to the local service: `{ workflow, card }` for a saved folder card, or
 * `{ preset }`. Files are read and written one at a time through the service (`skills`, `skill-write`, `skill-delete`,
 * `skill-remove`), never through the workflow's save; each write names the digest it read, and a file the expert
 * changed meanwhile is refused with a reload offered instead of overwriting it. Deleting asks a second click.
 */
import { computed, inject, ref, watch } from "vue";
import { t } from "./i18n.js";

const props = defineProps({
  source: { type: Object, required: true },
  // Why the skills cannot be read yet (e.g. the workflow is not saved); empty when they can.
  blocked: { type: String, default: "" },
});
const { bridge } = inject("discussion");
// A skill's folder name follows the workflow ID rule; a reference file name is one path segment.
const SKILL_NAME = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_NAME = /^[^./\\:*?"<>|\x00-\x1f][^/\\:*?"<>|\x00-\x1f]{0,99}$/;

const skills = ref([]), loading = ref(false), failure = ref(""), changed = ref(false);
const expanded = ref(new Set()), file = ref(null), text = ref(""), saving = ref(false);
// The control waiting for its second click: `skill:<name>` or `file:<path>`.
const armed = ref("");
const adding = ref(false), new_name = ref(""), new_description = ref("");
const adding_file = ref(""), new_file = ref("");
const edited = computed(() => Boolean(file.value) && file.value.text !== null && text.value !== file.value.text);
const key = computed(() => JSON.stringify(props.source));

function request(action, input = {}) {
  return bridge.local_request("workflows", { action, ...props.source, ...input });
}

/** Read every skill again; the open file stays open when it is still there. */
async function load() {
  if (props.blocked) return;
  loading.value = true;
  try {
    skills.value = (await request("skills")).skills;
    failure.value = ""; changed.value = false;
    const path = file.value?.path;
    const found = path && skills.value.flatMap((skill) => skill.files).find((item) => item.path === path);
    pick(found || null);
  } catch (error) { failure.value = error.message; skills.value = []; }
  finally { loading.value = false; }
}

function pick(item) {
  file.value = item; text.value = item?.text ?? ""; armed.value = "";
}

function toggle(name) {
  const next = new Set(expanded.value);
  if (next.has(name)) next.delete(name); else next.add(name);
  expanded.value = next;
}

/** A refusal because the expert changed the file shows the reload offer; any other is a notice. */
function refused(error) {
  if (error.code === "skill_changed") changed.value = true;
  bridge.notify(error.code === "skill_changed" ? "warning" : "error", error.message);
}

async function save() {
  if (!file.value || saving.value) return;
  saving.value = true;
  try {
    const result = await request("skill-write", { path: file.value.path, text: text.value, digest: file.value.digest });
    file.value = { ...file.value, text: text.value, digest: result.digest };
    skills.value = skills.value.map((skill) => ({ ...skill, files: skill.files.map((item) => item.path === result.path ? file.value : item) }));
    bridge.notify("info", t("已保存 {value1}", { value1: result.path }));
  } catch (error) { refused(error); }
  finally { saving.value = false; }
}

/** A new skill starts as its SKILL.md with the front matter Agent Skills reads. */
async function add_skill() {
  const name = new_name.value.trim(), description = new_description.value.trim().replace(/\s*\n\s*/g, " ");
  if (!SKILL_NAME.test(name)) return bridge.notify("warning", t("技能名只能用小写英文和数字，可用单个连字符连接，1—40 位"));
  if (!description) return bridge.notify("warning", t("请写一句描述：这条技能管什么"));
  try {
    await request("skill-write", { path: `${name}/SKILL.md`, text: `---\nname: ${name}\ndescription: ${description}\n---\n`, digest: "" });
    adding.value = false; new_name.value = ""; new_description.value = "";
    expanded.value = new Set([...expanded.value, name]);
    await load();
  } catch (error) { refused(error); }
}

async function add_file(skill) {
  const name = new_file.value.trim();
  if (!FILE_NAME.test(name)) return bridge.notify("warning", t("文件名不合法"));
  const path = `${skill}/references/${name}`;
  try {
    await request("skill-write", { path, text: "", digest: "" });
    adding_file.value = ""; new_file.value = "";
    await load();
    pick(skills.value.flatMap((item) => item.files).find((item) => item.path === path) || null);
  } catch (error) { refused(error); }
}

async function delete_file(item) {
  if (armed.value !== `file:${item.path}`) { armed.value = `file:${item.path}`; return; }
  try {
    await request("skill-delete", { path: item.path, digest: item.digest });
    if (file.value?.path === item.path) pick(null);
    await load();
  } catch (error) { refused(error); }
}

async function remove_skill(name) {
  if (armed.value !== `skill:${name}`) { armed.value = `skill:${name}`; return; }
  try {
    await request("skill-remove", { skill: name });
    if (file.value?.path.startsWith(`${name}/`)) pick(null);
    bridge.notify("info", t("已删除技能 {value1}，原来的文件夹已移到服务目录的 backups 下", { value1: name }));
    await load();
  } catch (error) { refused(error); }
}

watch([key, () => props.blocked], () => { pick(null); expanded.value = new Set(); load(); }, { immediate: true });
</script>

<template>
  <section class="expert-skills" :aria-label="t('技能')">
    <header class="expert-skills-head">
      <span>{{ t("技能") }}<small>{{ t("这位专家自己读写的知识；这里的修改直接写入，不需要保存工作流") }}</small></span>
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
      <ul class="expert-skills-list">
        <li v-for="skill in skills" :key="skill.name">
          <div class="expert-skills-skill">
            <button type="button" class="expert-skills-toggle" :aria-expanded="expanded.has(skill.name)" @click="toggle(skill.name)">
              <UIcon :name="expanded.has(skill.name) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" />
              <strong>{{ skill.name }}</strong><small>{{ skill.description }}</small>
            </button>
            <UButton :label="armed === `skill:${skill.name}` ? t('确认删除技能') : undefined" icon="i-lucide-trash-2" size="xs" :color="armed === `skill:${skill.name}` ? 'error' : 'neutral'" variant="ghost"
              :aria-label="t('删除技能 {value1}', { value1: skill.name })" :title="t('删除整条技能；原来的文件夹会移到服务目录的 backups 下')" @click="remove_skill(skill.name)" />
          </div>
          <ul v-if="expanded.has(skill.name)" class="expert-skills-files">
            <li v-for="item in skill.files" :key="item.path">
              <button type="button" class="expert-skills-file" :aria-current="file?.path === item.path ? 'true' : undefined" @click="pick(item)">
                <UIcon :name="item.text === null ? 'i-lucide-file-x' : 'i-lucide-file-text'" />{{ item.path.slice(skill.name.length + 1) }}
              </button>
              <UButton :label="armed === `file:${item.path}` ? t('确认删除') : undefined" icon="i-lucide-x" size="xs" :color="armed === `file:${item.path}` ? 'error' : 'neutral'" variant="ghost"
                :aria-label="t('删除文件 {value1}', { value1: item.path })" @click="delete_file(item)" />
            </li>
            <li>
              <form v-if="adding_file === skill.name" class="expert-skills-form" @submit.prevent="add_file(skill.name)">
                <UInput v-model="new_file" size="xs" class="expert-skills-grow" :placeholder="t('references 下的文件名，如 fire.md')" :aria-label="t('资料文件名')" />
                <UButton type="submit" :label="t('创建')" size="xs" />
              </form>
              <UButton v-else :label="t('新建资料文件')" icon="i-lucide-file-plus" size="xs" color="neutral" variant="ghost" @click="adding_file = skill.name; new_file = ''" />
            </li>
          </ul>
        </li>
      </ul>
      <div v-if="file" class="expert-skills-editor">
        <div class="expert-skills-editor-head"><code>{{ file.path }}</code>
          <UButton v-if="file.text !== null" :label="t('保存')" icon="i-lucide-save" size="xs" :disabled="!edited" :loading="saving" @click="save" />
          <UButton :label="t('关闭')" size="xs" color="neutral" variant="ghost" @click="pick(null)" /></div>
        <p v-if="file.text === null" class="expert-skills-note">{{ t("不是文本或超过大小上限，不能在这里查看和修改。") }}</p>
        <UTextarea v-else v-model="text" :rows="14" class="expert-skills-text" :aria-label="file.path" />
      </div>
    </template>
  </section>
</template>

<style scoped>
.expert-skills { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--ui-border-muted); }
.expert-skills-head { display: flex; align-items: center; gap: 6px; }
.expert-skills-head > span { display: flex; flex: 1; align-items: baseline; gap: 8px; min-width: 0; font-size: 12px; color: var(--ui-text-muted); }
.expert-skills-head small { color: var(--ui-text-dimmed); font-size: 11px; }
.expert-skills-note { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--ui-text-muted); font-size: 12px; }
.expert-skills-note.is-error { color: var(--ui-error, #e5484d); }
.expert-skills-note.is-warning { color: var(--ui-warning, #e0a33a); }
.expert-skills-form { display: flex; align-items: center; gap: 6px; }
.expert-skills-grow { flex: 1; min-width: 0; }
.expert-skills-list, .expert-skills-files { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.expert-skills-files { padding-left: 22px; }
.expert-skills-files > li, .expert-skills-skill { display: flex; align-items: center; gap: 4px; }
.expert-skills-toggle, .expert-skills-file { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; padding: 4px 6px; border-radius: 6px; text-align: left; cursor: pointer; font-size: 12px; }
.expert-skills-toggle:hover, .expert-skills-file:hover { background: var(--ui-bg-elevated); }
.expert-skills-file[aria-current] { background: color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 16%, transparent); }
.expert-skills-toggle strong { font-weight: 500; }
.expert-skills-toggle small { overflow: hidden; color: var(--ui-text-dimmed); text-overflow: ellipsis; white-space: nowrap; }
.expert-skills-editor { display: flex; flex-direction: column; gap: 6px; }
.expert-skills-editor-head { display: flex; align-items: center; gap: 6px; }
.expert-skills-editor-head code { flex: 1; min-width: 0; overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.expert-skills-text :deep(textarea) { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; line-height: 1.6; }
</style>
