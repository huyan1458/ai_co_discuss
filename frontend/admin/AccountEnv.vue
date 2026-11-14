<script setup>
/**
 * The skills of one account, and for a hosted account with its own Windows user its whole AI environment: one skills
 * folder and one system prompt shared by Claude Code, Codex and Antigravity (laid out like the owner's).
 *
 * Lists every installed skill with where it came from (room skills, the library, added by the account), installs library
 * skills and removes them, and opens the library itself. `account` is "" for the owner, whose own folder is read; the
 * owner's room skills come from setup and its prompt is its own file, so neither is set up or edited here.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import SkillLibrary from "./SkillLibrary.vue";

const props = defineProps({ account: { type: String, required: true } });
const { reload, notify, refreshed } = inject("panel");
const env = ref(null), library = ref([]), loading = ref(false), busy = ref(""), prompt = ref(""), prompt_open = ref(false), library_open = ref(false);
const owner = computed(() => !props.account);
const base = computed(() => (owner.value ? "owner/env" : `accounts/${props.account}/env`));

async function load() {
  loading.value = true;
  try {
    const [status, skills] = await Promise.all([call(base.value), call("skill-library")]);
    env.value = status; library.value = skills; prompt.value = status.prompt;
  } catch (failure) { env.value = { error: failure.message }; }
  finally { loading.value = false; }
}
onMounted(load);
watch(refreshed, load);
watch(() => props.account, load);

const library_names = computed(() => new Set(library.value.map((skill) => skill.name)));
/** Where an installed skill came from, and whether it can be removed here (room skills stay; the owner's own too). */
function source(skill) {
  if (skill.discussion) return { label: "房间技能", tag: "is-blue", removable: false };
  if (library_names.value.has(skill.name)) return { label: "技能库", tag: "is-green", removable: true };
  return { label: owner.value ? "自己装的" : "对方自己加的", tag: "is-gray", removable: !owner.value };
}
const installed = computed(() => [...(env.value?.skills || [])].sort((left, right) => Number(right.discussion) - Number(left.discussion) || left.name.localeCompare(right.name)));
const installed_names = computed(() => new Set(installed.value.map((skill) => skill.name)));
const available = computed(() => library.value.filter((skill) => !installed_names.value.has(skill.name)));
const layout_ok = computed(() => env.value?.layout && Object.values(env.value.layout).every(Boolean));

async function init() {
  busy.value = "init";
  try { await call(`${base.value}/init`, {}); notify("info", "AI 环境已初始化"); await load(); reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

/** Install one library skill or remove one skill. */
async function change(name, install) {
  busy.value = name;
  try {
    await call(`${base.value}/skills`, install ? { install: [name], remove: [] } : { install: [], remove: [name] });
    notify("info", `${install ? "已安装" : "已移除"} ${name}`);
    await load();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function save_prompt() {
  busy.value = "prompt";
  try { await call(`${base.value}/prompt`, { text: prompt.value }); notify("info", "系统提示词已保存，三家同时生效"); await load(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

function close_library() { library_open.value = false; load(); }
</script>

<template>
  <div class="env">
    <div class="env-head">
      <span>技能 <small>{{ owner ? "~\\.agents\\skills，Claude Code、Codex、Antigravity 共用" : "Claude Code、Codex、Antigravity 共用一份" }}</small></span>
      <span class="env-tools">
        <button type="button" class="panel-button is-outline is-small" @click="library_open = true"><UIcon name="i-lucide-library" />管理技能库</button>
        <button type="button" class="panel-icon-button" :class="{ 'is-spinning': loading }" :disabled="loading" title="重新读取" aria-label="重新读取" @click="load"><UIcon name="i-lucide-refresh-cw" /></button>
      </span>
    </div>

    <p v-if="env?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ env.error }}</p>
    <p v-else-if="!env" class="env-line">读取中…</p>
    <template v-else>
      <div v-if="!owner" class="env-line">
        <UIcon :name="layout_ok ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" :class="layout_ok ? 'is-ok' : 'is-warn'" />
        <div class="env-text"><strong>{{ layout_ok ? "AI 环境已初始化" : "AI 环境未初始化" }}</strong>
          <small>{{ layout_ok ? "房间技能、系统提示词和随包工作流都已装好" : "初始化会装好房间技能、系统提示词和随包工作流" }}</small></div>
        <button type="button" class="panel-button is-small" :class="layout_ok ? 'is-outline' : 'is-primary'" :disabled="Boolean(busy)" @click="init">
          <UIcon :name="busy === 'init' ? 'i-lucide-loader' : 'i-lucide-wand-sparkles'" :class="{ 'animate-spin': busy === 'init' }" />{{ layout_ok ? "重新初始化" : "初始化" }}</button>
      </div>

      <div class="env-block">
        <strong>已安装 {{ installed.length }} 个</strong>
        <p v-if="!installed.length" class="env-empty">还没有安装技能。</p>
        <div v-for="skill in installed" :key="skill.name" class="env-skill">
          <span><b>{{ skill.name }}</b><em :class="source(skill).tag">{{ source(skill).label }}</em><small :title="skill.description">{{ skill.description || "（SKILL.md 没写描述）" }}</small></span>
          <button v-if="source(skill).removable" type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="change(skill.name, false)">
            <UIcon v-if="busy === skill.name" name="i-lucide-loader" class="animate-spin" />移除</button>
        </div>
      </div>

      <div class="env-block">
        <strong>技能库里可添加的</strong>
        <p v-if="!library.length" class="env-empty">技能库还是空的。点右上角“管理技能库”导入技能，再回到这里给账号安装。</p>
        <p v-else-if="!available.length" class="env-empty">技能库里的技能都已安装。</p>
        <div v-for="skill in available" :key="skill.name" class="env-skill">
          <span><b>{{ skill.name }}</b><small :title="skill.description">{{ skill.description || "（SKILL.md 没写描述）" }}</small></span>
          <button type="button" class="panel-button is-outline is-small" :disabled="Boolean(busy)" @click="change(skill.name, true)">
            <UIcon :name="busy === skill.name ? 'i-lucide-loader' : 'i-lucide-plus'" :class="{ 'animate-spin': busy === skill.name }" />安装</button>
        </div>
      </div>

      <div v-if="!owner" class="env-block">
        <button type="button" class="env-toggle" @click="prompt_open = !prompt_open">
          <strong>系统提示词</strong><small>三家共用一份（~\.codex\AGENTS.md，另两份是它的硬链接）</small>
          <UIcon :name="prompt_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
        <template v-if="prompt_open">
          <textarea v-model="prompt" class="panel-input env-prompt" spellcheck="false" />
          <div class="env-actions">
            <button type="button" class="panel-button is-primary is-small" :disabled="prompt === env.prompt || Boolean(busy)" @click="save_prompt">
              <UIcon v-if="busy === 'prompt'" name="i-lucide-loader" class="animate-spin" />保存</button>
          </div>
        </template>
      </div>
    </template>
  </div>

  <UModal :open="library_open" title="技能库" description="导入的技能放在这里，再到各账号的“技能”里安装。" :ui="{ content: 'max-w-3xl' }" @update:open="(open) => !open && close_library()">
    <template #body><SkillLibrary /></template>
  </UModal>
</template>

<style scoped>
.env { display: flex; flex-direction: column; gap: 4px; }
.env-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.env-head small { margin-left: 6px; color: var(--panel-faint); font-weight: 400; }
.env-tools { display: flex; align-items: center; gap: 6px; }
.env-line { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); font-size: 13px; }
.env-line > [class*="icon"] { width: 20px; height: 20px; flex-shrink: 0; }
.env-line .is-ok { color: var(--panel-green); }
.env-line .is-warn { color: var(--panel-amber); }
.env-text { display: flex; flex: 1; flex-direction: column; gap: 3px; }
.env-text strong { font-size: 14px; }
.env-text small { color: var(--panel-faint); font-size: 12px; }
.env-block { display: flex; flex-direction: column; gap: 4px; padding: 14px 4px; border-top: 1px solid var(--panel-line); }
.env-block > strong { margin-bottom: 4px; font-size: 14px; }
.env-empty { margin: 0; color: var(--panel-faint); font-size: 13px; }
.env-skill { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 6px 10px; border-radius: 10px; }
.env-skill:hover { background: var(--panel-tint); }
.env-skill > span { display: flex; flex: 1; align-items: baseline; gap: 8px; min-width: 0; font-size: 13px; }
.env-skill b { flex-shrink: 0; font-weight: 600; }
.env-skill em { flex-shrink: 0; padding: 1px 6px; border-radius: 6px; font-size: 11px; font-style: normal; }
.env-skill em.is-blue { background: var(--panel-blue-soft); color: var(--panel-blue); }
.env-skill em.is-green { background: var(--panel-green-soft); color: var(--panel-green); }
.env-skill em.is-gray { background: var(--panel-tint); color: var(--panel-muted); }
.env-skill small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.env-actions { display: flex; justify-content: flex-end; }
.env-toggle { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; }
.env-toggle strong { font-size: 14px; }
.env-toggle small { flex: 1; color: var(--panel-faint); font-size: 12px; }
.env-toggle > [class*="icon"] { width: 16px; height: 16px; align-self: center; color: var(--panel-faint); }
.env-prompt { height: 220px; padding: 12px 14px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.6; }
</style>
