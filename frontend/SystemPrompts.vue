<script setup>
/**
 * 系统提示词: what the owner writes for every member this computer wakes and for each platform's members, kept in this
 * computer's launch-settings.json (`system_prompts`, user 2026-11-25). The runner puts them ahead of a member's own prompt
 * and sends them as its system prompt where the software allows, else with the first task of each session
 * (free_runner.mjs `expert_prompt_delivery`); manually started and external members get none. The account's own
 * CLAUDE.md / AGENTS.md stay untouched, so plain AI windows outside CoDiscuss are not affected.
 */
import { computed, inject, ref, watch } from "vue";
import MemberTextDialog from "./MemberTextDialog.vue";
import { ADAPTER_PROFILES, API_PROVIDERS } from "../runner/adapters/profiles.mjs";
import { MAX_EXPERT_PROMPT } from "../runner/expert_prompts.mjs";
import { t } from "./i18n.js";

const { bridge } = inject("discussion");
const PROGRAM = "program";
const prompts = ref({});
const loaded = ref(false), unavailable = ref(""), saving = ref(false);
const open = ref(false), editing = ref(""), draft = ref("");

const platform_label = (name) => name === "Custom" ? t("自定义 API") : bridge.platform_identity(name)?.label || name;
const rows = computed(() => [{ key: PROGRAM, label: t("所有成员"), text: prompts.value.program || "" },
  ...Object.keys(API_PROVIDERS).map((name) => ({ key: name, label: platform_label(name), text: prompts.value.platforms?.[name] || "" }))]);
const current = computed(() => rows.value.find((row) => row.key === editing.value) || { label: "", text: "" });
const set_count = computed(() => rows.value.filter((row) => row.text).length);
// What each fixed rule is for, in words for people; the model gets the original text, shown folded below it.
const RULE_NOTES = {
  progress: () => t("提醒它在任务中途写一句进展，否则等待时卡片上看不到它做到哪了"),
  commands_only: () => t("提醒它不要用命令行看目录、读文件，否则这一轮会被中断"),
};
const RULE_WHEN = { always: () => t("每次任务"), read_only: () => t("仅只读权限时") };
// The rules the runner always adds for this platform's software; shown so the owner does not write them again.
const fixed = computed(() => {
  const sections = Object.values(ADAPTER_PROFILES).filter((profile) => profile.platform === editing.value && profile.rules)
    .flatMap((profile) => profile.rules.map((rule) => ({
      label: t("{software}：{note}（{when}）", { software: profile.label, note: RULE_NOTES[rule.id]?.() || rule.id, when: RULE_WHEN[rule.when]?.() || rule.when }),
      text: rule.text("codiscuss") })));
  return sections.length ? { summary: t("程序固定附加的规则（只读）"), sections } : null;
});

async function load() {
  try { prompts.value = await bridge.read_system_prompts(); loaded.value = true; unavailable.value = ""; }
  catch (error) { unavailable.value = error.message; }
}
watch(open, (value) => { if (value && !loaded.value) load(); });

function edit(key) {
  editing.value = key;
  draft.value = rows.value.find((row) => row.key === key)?.text || "";
}

/** Shown at once; a refusal puts the saved text back and says why. */
async function save() {
  const key = editing.value, text = draft.value.trim(), before = prompts.value;
  editing.value = "";
  const patch = key === PROGRAM ? { program: text } : { platforms: { [key]: text } };
  prompts.value = key === PROGRAM ? { ...before, program: text } : { ...before, platforms: { ...before.platforms, [key]: text } };
  saving.value = true;
  try { prompts.value = await bridge.save_system_prompts(patch); }
  catch (error) { prompts.value = before; bridge.notify("error", error.message); }
  finally { saving.value = false; }
}
</script>

<template>
  <section class="channel-reading-setting">
    <UCollapsible v-model:open="open">
      <button type="button" class="prompts-header" :aria-expanded="open">
        <h3>{{ t('系统提示词') }}</h3><small>{{ t('发给本机唤醒的成员') }}</small>
        <span>{{ !loaded ? '' : set_count ? t('已设置 {count} 项', { count: set_count }) : t('未设置') }}</span><UIcon :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
      </button>
      <template #content>
        <div class="prompts-settings">
          <p v-if="unavailable" class="fine-print">{{ t('系统提示词保存在这台电脑上，需要连接本机服务或已配对电脑：{value1}', { value1: unavailable }) }}</p>
          <template v-else-if="loaded">
            <p class="fine-print">{{ t('排在成员的专属提示词之前，下次唤醒起生效；手动启动和外部成员不带。不修改各软件自己的 CLAUDE.md、AGENTS.md。') }}</p>
            <div v-for="row in rows" :key="row.key" class="prompts-row">
              <span>{{ row.label }}</span>
              <p :class="{ 'is-empty': !row.text }" :title="row.text">{{ row.text ? row.text.split('\n')[0] : t('未设置') }}</p>
              <UButton :label="t('编辑')" color="neutral" variant="ghost" size="xs" :aria-label="t('编辑 {value1} 的系统提示词', { value1: row.label })" @click="edit(row.key)" />
            </div>
          </template>
          <p v-else class="fine-print">{{ t('读取中…') }}</p>
        </div>
      </template>
    </UCollapsible>
    <MemberTextDialog :open="Boolean(editing)" v-model:draft="draft" :title="t('{value1} 的系统提示词', { value1: current.label })"
      :description="editing === PROGRAM ? t('发给本机唤醒的所有成员，补充做法与偏好；不改变权限和技能规则。') : t('发给 {value1} 平台的所有成员，含本地软件、模型 API、预设与工作流里的专家。', { value1: current.label })"
      :label="t('{value1} 的系统提示词', { value1: current.label })" :max="MAX_EXPERT_PROMPT" :rows="8" :fixed="editing === PROGRAM ? null : fixed"
      :note="draft.trim() ? t('Ctrl + Enter 保存') : t('留空表示不使用')" :changed="draft.trim() !== current.text" :saving="saving"
      @update:open="(value) => { if (!value) editing = ''; }" @save="save" />
  </section>
</template>

<style scoped>
.prompts-header { display: flex; width: 100%; align-items: baseline; gap: 8px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }
.prompts-header h3 { flex-shrink: 0; margin: 0; white-space: nowrap; }
.prompts-header small { flex-shrink: 0; color: var(--ui-text-dimmed); font-size: 12px; white-space: nowrap; }
.prompts-header span { min-width: 0; margin-left: auto; overflow: hidden; color: var(--ui-text-dimmed); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 480px) { .prompts-header small { display: none; } }
.prompts-header > :last-child { align-self: center; color: var(--ui-text-dimmed); }
.prompts-settings { display: grid; gap: 6px; padding-top: 10px; }
.prompts-settings .fine-print { margin: 0 0 4px; }
.prompts-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 10px; color: var(--ui-text-dimmed); font-size: 12px; }
.prompts-row > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prompts-row p { margin: 0; overflow: hidden; color: var(--ui-text); text-overflow: ellipsis; white-space: nowrap; }
.prompts-row p.is-empty { color: var(--ui-text-dimmed); }
</style>
