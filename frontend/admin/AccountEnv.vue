<script setup>
/**
 * The AI environment of one account with its own Windows user: one skills folder and one system prompt shared by Claude
 * Code, Codex and Antigravity (laid out like the owner's). Shows what is installed, installs skills chosen from the
 * owner's library, removes others, and edits the system prompt.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";

const props = defineProps({ account: { type: String, required: true } });
const { reload, notify } = inject("panel");
const env = ref(null), library = ref([]), loading = ref(false), busy = ref(""), chosen = ref({}), prompt = ref(""), prompt_open = ref(false);

async function load() {
  loading.value = true;
  try {
    const [status, skills] = await Promise.all([call(`accounts/${props.account}/env`), call("skill-library")]);
    env.value = status; library.value = skills; prompt.value = status.prompt;
    chosen.value = Object.fromEntries(skills.map((skill) => [skill.name, installed.value.has(skill.name)]));
  } catch (failure) { env.value = { error: failure.message }; }
  finally { loading.value = false; }
}
onMounted(load);
watch(() => props.account, load);

const installed = computed(() => new Set((env.value?.skills || []).map((skill) => skill.name)));
const discussion = computed(() => (env.value?.skills || []).filter((skill) => skill.discussion));
const library_names = computed(() => new Set(library.value.map((skill) => skill.name)));
// Skills in its folder that came from neither the discussion set nor the library (added by the account or its AI).
const others = computed(() => (env.value?.skills || []).filter((skill) => !skill.discussion && !library_names.value.has(skill.name)));
const layout_ok = computed(() => env.value?.layout && Object.values(env.value.layout).every(Boolean));
const changes = computed(() => library.value.filter((skill) => chosen.value[skill.name] !== installed.value.has(skill.name)));

async function init() {
  busy.value = "init";
  try { await call(`accounts/${props.account}/env/init`, {}); notify("info", "AI 环境已初始化"); await load(); reload(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function apply(remove = []) {
  busy.value = "skills";
  const install = changes.value.filter((skill) => chosen.value[skill.name]).map((skill) => skill.name);
  remove = [...remove, ...changes.value.filter((skill) => !chosen.value[skill.name]).map((skill) => skill.name)];
  try {
    const result = await call(`accounts/${props.account}/env/skills`, { install, remove });
    notify("info", [result.installed.length ? `已安装 ${result.installed.join("、")}` : "", result.removed.length ? `已移除 ${result.removed.join("、")}` : ""].filter(Boolean).join("；") || "没有变化");
    await load();
  } catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}

async function save_prompt() {
  busy.value = "prompt";
  try { await call(`accounts/${props.account}/env/prompt`, { text: prompt.value }); notify("info", "系统提示词已保存，三家同时生效"); await load(); }
  catch (failure) { notify("error", failure.message); }
  finally { busy.value = ""; }
}
</script>

<template>
  <div class="env">
    <div class="env-head">
      <span>AI 环境 <small>技能和系统提示词各一份，Claude Code、Codex、Antigravity 共用</small></span>
      <button type="button" class="panel-icon-button" :class="{ 'is-spinning': loading }" :disabled="loading" title="重新读取" aria-label="重新读取" @click="load"><UIcon name="i-lucide-refresh-cw" /></button>
    </div>

    <p v-if="env?.error" class="panel-note is-amber"><UIcon name="i-lucide-circle-alert" />{{ env.error }}</p>
    <p v-else-if="!env" class="env-line">读取中…</p>
    <template v-else>
      <div class="env-line">
        <UIcon :name="layout_ok ? 'i-lucide-circle-check' : 'i-lucide-circle-dashed'" :class="layout_ok ? 'is-ok' : 'is-warn'" />
        <div class="env-text"><strong>{{ layout_ok ? "已初始化" : "未初始化" }}</strong>
          <small>{{ layout_ok ? `房间技能 ${discussion.length} 个已装；随包工作流已补齐` : "初始化会装好房间技能、系统提示词和随包工作流" }}</small></div>
        <button type="button" class="panel-button is-small" :class="layout_ok ? 'is-outline' : 'is-primary'" :disabled="Boolean(busy)" @click="init">
          <UIcon :name="busy === 'init' ? 'i-lucide-loader' : 'i-lucide-wand-sparkles'" :class="{ 'animate-spin': busy === 'init' }" />{{ layout_ok ? "重新初始化" : "初始化" }}</button>
      </div>

      <div class="env-block">
        <strong>技能库里的技能</strong><small>勾选后点“应用”，装进它的技能文件夹；取消勾选会移除。技能库在“托管账号”页管理。</small>
        <p v-if="!library.length" class="env-empty">技能库还是空的。</p>
        <label v-for="skill in library" :key="skill.name" class="env-skill">
          <input v-model="chosen[skill.name]" type="checkbox" />
          <span><b>{{ skill.name }}</b><em v-if="installed.has(skill.name)">已安装</em><small>{{ skill.description }}</small></span>
        </label>
        <div v-if="library.length" class="env-actions">
          <button type="button" class="panel-button is-primary is-small" :disabled="!changes.length || Boolean(busy)" @click="apply()">
            <UIcon v-if="busy === 'skills'" name="i-lucide-loader" class="animate-spin" />应用{{ changes.length ? `（${changes.length} 项变化）` : "" }}</button>
        </div>
      </div>

      <div v-if="others.length" class="env-block">
        <strong>它自己加的技能</strong><small>不在房间技能和技能库里，可能是对方或它的 AI 装的。</small>
        <div v-for="skill in others" :key="skill.name" class="env-skill">
          <span><b>{{ skill.name }}</b><small>{{ skill.description }}</small></span>
          <button type="button" class="panel-button is-plain is-small" :disabled="Boolean(busy)" @click="apply([skill.name])">移除</button>
        </div>
      </div>

      <div class="env-block">
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
</template>

<style scoped>
.env { display: flex; flex-direction: column; gap: 4px; }
.env-head { display: flex; align-items: center; justify-content: space-between; color: var(--panel-muted); font-size: 13px; font-weight: 500; }
.env-head small { margin-left: 6px; color: var(--panel-faint); font-weight: 400; }
.env-line { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-top: 1px solid var(--panel-line); font-size: 13px; }
.env-line > [class*="icon"] { width: 20px; height: 20px; flex-shrink: 0; }
.env-line .is-ok { color: var(--panel-green); }
.env-line .is-warn { color: var(--panel-amber); }
.env-text { display: flex; flex: 1; flex-direction: column; gap: 3px; }
.env-text strong { font-size: 14px; }
.env-text small, .env-block > small { color: var(--panel-faint); font-size: 12px; }
.env-block { display: flex; flex-direction: column; gap: 8px; padding: 14px 4px; border-top: 1px solid var(--panel-line); }
.env-block > strong { font-size: 14px; }
.env-empty { margin: 0; color: var(--panel-faint); font-size: 13px; }
.env-skill { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px; cursor: pointer; }
.env-skill:hover { background: var(--panel-tint); }
.env-skill input { width: 16px; height: 16px; margin-top: 2px; accent-color: var(--panel-blue); }
.env-skill span { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; font-size: 13px; }
.env-skill em { padding: 1px 6px; border-radius: 6px; background: var(--panel-green-soft); color: var(--panel-green); font-size: 11px; font-style: normal; }
.env-skill small { flex-basis: 100%; color: var(--panel-faint); font-size: 12px; }
.env-actions { display: flex; justify-content: flex-end; }
.env-toggle { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; }
.env-toggle strong { font-size: 14px; }
.env-toggle small { flex: 1; color: var(--panel-faint); font-size: 12px; }
.env-toggle > [class*="icon"] { width: 16px; height: 16px; align-self: center; color: var(--panel-faint); }
.env-prompt { height: 220px; padding: 12px 14px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.6; }
</style>
