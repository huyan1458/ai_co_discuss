<script setup>
/**
 * The owner's skill library, for the owner and hosted accounts: drop skill folders or .zip files in (or pick them), see and delete what
 * is there, and with hosting on edit the system prompt new accounts start with. Installing a library skill is done in
 * an account's skills.
 */
import { inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";

const { state, notify, refreshed } = inject("panel");
const skills = ref([]), over = ref(false), importing = ref(""), removing = ref(null);
const prompt = ref({ open: false, text: "", saved: "", saving: false });

async function load() {
  try { skills.value = await call("skill-library"); } catch (failure) { notify("error", failure.message); }
}
onMounted(load);
watch(refreshed, load);

function base64(buffer) {
  let text = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

/** Every file under a dropped folder, as { path relative to it, data }. */
async function read_folder(entry, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((done, fail) => entry.file(done, fail));
    return [{ path: `${prefix}${file.name}`, data: base64(await file.arrayBuffer()) }];
  }
  const reader = entry.createReader(), entries = [];
  // readEntries returns at most about a hundred entries per call.
  for (let batch = await new Promise((done, fail) => reader.readEntries(done, fail)); batch.length; batch = await new Promise((done, fail) => reader.readEntries(done, fail))) entries.push(...batch);
  const files = [];
  for (const child of entries) files.push(...await read_folder(child, `${prefix}${entry.name}/`.replace(/^\//, "")));
  return files;
}

async function upload(label, body) {
  importing.value = label;
  try { const skill = await call("skill-library", body); notify("info", `已加入技能库：${skill.name}`); await load(); }
  catch (failure) { notify("error", `${label}：${failure.message}`); }
  finally { importing.value = ""; }
}

async function dropped(event) {
  over.value = false;
  const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
  for (const entry of entries) {
    if (entry.isDirectory) await upload(entry.name, { name: entry.name, files: await read_folder(entry) });
    else if (/\.zip$/i.test(entry.name)) { const file = await new Promise((done, fail) => entry.file(done, fail)); await upload(entry.name, { zip: base64(await file.arrayBuffer()) }); }
    else notify("warning", `${entry.name} 不是文件夹或 .zip，已跳过`);
  }
}

async function picked_zip(event) {
  for (const file of event.target.files) await upload(file.name, { zip: base64(await file.arrayBuffer()) });
  event.target.value = "";
}

async function picked_folder(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  const name = files[0].webkitRelativePath.split("/")[0];
  // webkitRelativePath starts with the chosen folder's own name, which the server takes as the wrapping folder.
  await upload(name, { name, files: await Promise.all(files.map(async (file) => ({ path: file.webkitRelativePath, data: base64(await file.arrayBuffer()) }))) });
  event.target.value = "";
}

async function remove() {
  const name = removing.value;
  removing.value = null;
  try { await call(`skill-library/${name}/remove`, {}); notify("info", `已从技能库删除 ${name}`); await load(); }
  catch (failure) { notify("error", failure.message); }
}

async function open_prompt() {
  prompt.value.open = !prompt.value.open;
  if (prompt.value.open && !prompt.value.saved) {
    try { const { text } = await call("hosted-prompt"); prompt.value.text = text; prompt.value.saved = text; } catch (failure) { notify("error", failure.message); }
  }
}
async function save_prompt() {
  prompt.value.saving = true;
  try { await call("hosted-prompt", { text: prompt.value.text }); prompt.value.saved = prompt.value.text; notify("info", "默认系统提示词已保存，之后初始化的账号会用它"); }
  catch (failure) { notify("error", failure.message); }
  finally { prompt.value.saving = false; }
}
const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
</script>

<template>
  <div class="library">
    <div class="library-drop" :class="{ 'is-over': over }" @dragover.prevent="over = true" @dragleave="over = false" @drop.prevent="dropped">
      <UIcon :name="importing ? 'i-lucide-loader' : 'i-lucide-folder-down'" :class="{ 'animate-spin': importing }" />
      <strong>{{ importing ? `正在导入 ${importing}…` : "把技能文件夹或 .zip 拖到这里" }}</strong>
      <small>技能文件夹里要有 SKILL.md。也可以
        <label class="library-pick">选择 .zip<input type="file" accept=".zip" multiple hidden @change="picked_zip" /></label> 或
        <label class="library-pick">选择文件夹<input type="file" webkitdirectory hidden @change="picked_folder" /></label></small>
    </div>
    <p v-if="!skills.length" class="library-empty">技能库还是空的。导入后，到各账号的“技能”里安装。</p>
    <div v-for="skill in skills" :key="skill.name" class="library-row">
      <UIcon name="i-lucide-sparkle" class="library-icon" />
      <div class="library-text"><strong>{{ skill.name }}</strong><small>{{ skill.description || "（SKILL.md 没写描述）" }} · {{ skill.files }} 个文件 · {{ size(skill.size) }}</small></div>
      <button type="button" class="panel-icon-button" title="从技能库删除" aria-label="从技能库删除" @click="removing = skill.name"><UIcon name="i-lucide-trash-2" /></button>
    </div>
    <div v-if="state.hosting" class="library-prompt">
      <button type="button" class="library-toggle" @click="open_prompt">
        <strong>新账号的默认系统提示词</strong><small>初始化 AI 环境时，账号还没有系统提示词就用这一份；不会用你自己的</small>
        <UIcon :name="prompt.open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></button>
      <template v-if="prompt.open">
        <textarea v-model="prompt.text" class="panel-input library-area" spellcheck="false" />
        <div class="library-actions"><button type="button" class="panel-button is-primary is-small" :disabled="prompt.text === prompt.saved || prompt.saving" @click="save_prompt">保存</button></div>
      </template>
    </div>
  </div>

  <UModal :open="Boolean(removing)" title="从技能库删除" @update:open="(open) => !open && (removing = null)">
    <template #body>
      <p style="margin: 0; color: #4b5563; font-size: 14px; line-height: 1.7">从技能库删除 {{ removing }}。已经装给账号的副本不受影响，需要时在账号页移除。</p>
      <div class="panel-form-foot">
        <button type="button" class="panel-button is-plain" @click="removing = null">取消</button>
        <button type="button" class="panel-button is-primary" style="background: #dc2626" @click="remove">删除</button>
      </div>
    </template>
  </UModal>
</template>

<style scoped>
.library { display: flex; flex-direction: column; gap: 4px; }
.library-drop { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 22px; border: 1.5px dashed var(--panel-line); border-radius: 14px; color: var(--panel-muted); text-align: center; transition: border-color .15s, background-color .15s; }
.library-drop.is-over { border-color: var(--panel-blue); background: var(--panel-blue-soft); }
.library-drop > [class*="icon"] { width: 26px; height: 26px; color: var(--panel-faint); }
.library-drop strong { font-size: 14px; font-weight: 500; }
.library-drop small { color: var(--panel-faint); font-size: 12px; }
.library-pick { color: var(--panel-blue); cursor: pointer; }
.library-pick:hover { text-decoration: underline; }
.library-empty { margin: 8px 4px 0; color: var(--panel-faint); font-size: 13px; }
.library-row { display: flex; align-items: center; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--panel-line); }
.library-icon { width: 18px; height: 18px; color: var(--panel-blue); flex-shrink: 0; }
.library-text { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.library-text strong { font-size: 14px; }
.library-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.library-prompt { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; }
.library-toggle { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; }
.library-toggle strong { font-size: 14px; }
.library-toggle small { flex: 1; color: var(--panel-faint); font-size: 12px; }
.library-toggle > [class*="icon"] { width: 16px; height: 16px; align-self: center; color: var(--panel-faint); }
.library-area { height: 200px; padding: 12px 14px; resize: vertical; font-family: ui-monospace, Consolas, monospace; font-size: 13px; line-height: 1.6; }
.library-actions { display: flex; justify-content: flex-end; }
</style>
