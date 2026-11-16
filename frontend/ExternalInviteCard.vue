<script setup>
/**
 * The invite dialog's card for an AI on another computer: what it may do, which of this room's directories it reads,
 * how long it stays; "生成邀请" shows a link, QR code and pairing code to send yourself. Pending invitations are
 * listed under it and can be revoked.
 */
import { computed, inject, onUnmounted, ref, watch } from "vue";
import { renderSVG } from "uqr";
import { DURATIONS, LEVELS, LEVEL_SHORT, remaining_label, room_operations, time_ms } from "./external-members.js";
import { t } from "./i18n.js";

const emit = defineEmits(["remove"]);
const { view, bridge } = inject("discussion");
const operations = room_operations(bridge);
const room = computed(() => view.value.room);
const level = ref("read"), duration = ref("1h");
// Only directories this room already has; the main one is chosen by default.
const room_directories = computed(() => {
  const models = view.value.launch.room_models;
  if (models?.room_id !== room.value?.id || !models.project_directory) return [];
  return [models.project_directory, ...(models.extra_directories || [])];
});
const directories = ref([]);
watch(room_directories, (list) => { directories.value = directories.value.filter((item) => list.includes(item)); if (!directories.value.length && list.length) directories.value = [list[0]]; }, { immediate: true });
const needs_directory = computed(() => level.value === "read" && !directories.value.length);
const busy = ref(""), invite = ref(null), invites = ref([]);
const COPY_FEEDBACK_MS = 2000;
const copied = ref("");
let copy_timer = 0;

/** Read the room's invitations not yet redeemed. */
async function load_invites() {
  if (!room.value) return;
  try { invites.value = (await operations.list_invites(room.value.id)).invites || []; }
  catch { /* The list stays as it was; generating or revoking shows its own error. */ }
}
watch(() => room.value?.id, () => { invite.value = null; load_invites(); }, { immediate: true });

async function run(name, operation) {
  if (busy.value) return;
  busy.value = name;
  try { await operation(); }
  catch (error) { bridge.notify("error", error.message); }
  finally { busy.value = ""; }
}

/** Ask this computer to sign an invitation; the dialog shows it until the user closes or generates another. */
function generate() {
  return run("create", async () => {
    // Directories go by their place in the room's list (main first), never as paths.
    const folders = directories.value.map((path) => room_directories.value.indexOf(path)).filter((index) => index >= 0);
    const result = await operations.create_invite(room.value.id, { level: level.value, duration: duration.value,
      ...(level.value === "read" ? { folders } : {}) });
    invite.value = { ...result, svg: result.url ? renderSVG(result.url, { border: 1 }) : "" };
    await load_invites();
  });
}

function revoke(item) {
  return run(`revoke:${item.invite_id}`, async () => {
    await operations.revoke_invite(room.value.id, item.invite_id);
    if (invite.value?.invite_id === item.invite_id) invite.value = null;
    bridge.notify("info", t("邀请已撤销"));
    await load_invites();
  });
}

async function copy(kind, text) {
  if (!await bridge.execute("copy", text)) return;
  copied.value = kind;
  clearTimeout(copy_timer);
  copy_timer = setTimeout(() => { copied.value = ""; }, COPY_FEEDBACK_MS);
}
onUnmounted(() => clearTimeout(copy_timer));
const date = (value) => bridge.format_time(time_ms(value));
const leaf = (path) => path.split(/[\\/]/).filter(Boolean).pop() || path;
</script>

<template>
  <section class="external-invite" :aria-label="t('邀请另一台电脑上的 AI')">
    <header class="external-invite-head">
      <UIcon name="i-lucide-monitor-smartphone" /><strong>{{ t("另一台电脑") }}</strong>
      <UButton icon="i-lucide-x" color="neutral" variant="ghost" size="xs" class="external-invite-remove" :aria-label="t('移除这张卡片')" @click="emit('remove')" />
    </header>
    <template v-if="!invite">
      <fieldset class="external-field">
        <legend>{{ t("能做什么") }}</legend>
        <label v-for="option in LEVELS" :key="option.value" class="external-option" :class="{ 'is-selected': level === option.value }">
          <input v-model="level" type="radio" name="external-level" :value="option.value" /><span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
        </label>
      </fieldset>
      <fieldset v-if="level === 'read'" class="external-field">
        <legend>{{ t("开放目录") }}</legend>
        <p v-if="!room_directories.length" class="fine-print">{{ t("本房间还没有项目目录，只能选“只讨论”。") }}</p>
        <label v-for="path in room_directories" :key="path" class="external-check" :title="path">
          <UCheckbox :model-value="directories.includes(path)" :label="leaf(path)" @update:model-value="(on) => directories = on ? [...directories, path] : directories.filter((item) => item !== path)" />
        </label>
        <p class="fine-print">{{ t("只读：已跟踪与未忽略的文件，固定排除 .env、密钥、凭据、data/ 与 .git。") }}</p>
      </fieldset>
      <fieldset class="external-field">
        <legend>{{ t("有效期") }}</legend>
        <div class="external-durations" role="radiogroup" :aria-label="t('有效期')">
          <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="duration === option.value" :class="{ 'is-selected': duration === option.value }" @click="duration = option.value">{{ option.label }}</button>
        </div>
      </fieldset>
      <p class="external-warning" role="note"><UIcon name="i-lucide-triangle-alert" />{{ level === 'read' ? t("项目内容会经对方的 AI 发送给其模型服务商；读出去的内容收不回，撤销只阻止以后的读取。") : t("房间里发给它的内容会经对方的 AI 发送给其模型服务商。") }}</p>
      <UButton icon="i-lucide-link" :label="t('生成邀请')" class="channel-primary-button external-generate" :loading="busy === 'create'" :disabled="Boolean(busy) || needs_directory || !view.launch.available && !view.launch.remote" @click="generate" />
      <p v-if="!view.launch.available && !view.launch.remote" class="fine-print" role="alert">{{ t("生成邀请需要本机服务，请在这台电脑打开本机网站。") }}</p>
    </template>
    <div v-else class="external-result" role="status">
      <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
      <div v-if="invite.svg" class="external-qr" :aria-label="t('邀请二维码')" v-html="invite.svg" />
      <div class="external-result-body">
        <p>{{ t("把链接或二维码发给对方；对方也可以在自己的共议里输入配对码：") }}</p>
        <p class="external-code">{{ invite.code }}</p>
        <div class="external-copy">
          <UButton :icon="copied === 'url' ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied === 'url' ? t('已复制') : t('复制链接')" size="xs" color="neutral" variant="outline" @click="copy('url', invite.url)" />
          <UButton :icon="copied === 'code' ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied === 'code' ? t('已复制') : t('复制配对码')" size="xs" color="neutral" variant="outline" @click="copy('code', invite.code)" />
        </div>
        <p class="fine-print">{{ t("{time} 前兑换有效，只能用一次。对方兑换后直接成为成员，你会收到提示，可随时撤销。", { time: date(invite.expires_at) }) }}</p>
        <p class="fine-print">{{ t("配对码不含这台电脑的公钥指纹，优先发链接或二维码。") }}</p>
        <UButton :label="t('再生成一个')" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" @click="invite = null" />
      </div>
    </div>
    <div v-if="invites.length" class="external-pending">
      <h5>{{ t("待兑换的邀请") }}</h5>
      <ul>
        <li v-for="item in invites" :key="item.invite_id">
          <span>{{ t("{level} · 成员 {duration} · {left}内兑换", { level: LEVEL_SHORT[item.level] || item.level, duration: DURATIONS.find((option) => option.value === item.duration)?.label || item.duration, left: remaining_label(item.expires_at) }) }}</span>
          <UButton :label="t('撤销')" size="xs" color="error" variant="ghost" :loading="busy === `revoke:${item.invite_id}`" :disabled="Boolean(busy)" @click="revoke(item)" />
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.external-invite { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--ui-border); border-radius: 12px; background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); }
.external-invite-head { display: flex; align-items: center; gap: 6px; color: var(--ui-text-highlighted); font-size: 13px; }
.external-invite-remove { margin-left: auto; }
.external-field { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.external-field legend { margin-bottom: 4px; color: var(--ui-text-toned); font-size: 12px; }
.external-option { display: flex; gap: 8px; padding: 8px; border: 1px solid var(--ui-border-muted); border-radius: 8px; cursor: pointer; font-size: 12px; }
.external-option.is-selected { border-color: var(--channel-accent); }
.external-option span { display: flex; flex-direction: column; gap: 2px; }
.external-option small { color: var(--ui-text-muted); }
.external-check { min-width: 0; overflow: hidden; }
.external-durations { display: flex; gap: 3px; padding: 3px; border-radius: 6px; background: var(--ui-bg-muted); }
.external-durations button { flex: 1; min-height: 28px; border-radius: 4px; font-size: 12px; color: var(--ui-text-muted); }
.external-durations button.is-selected { color: var(--ui-text-highlighted); background: var(--ui-bg-elevated); box-shadow: var(--channel-shadow-control); }
.external-warning { display: flex; gap: 6px; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 12px; line-height: 1.5; }
.external-warning > span { flex-shrink: 0; margin-top: 2px; }
.external-generate { align-self: flex-start; }
.external-result { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.external-result-body { display: flex; flex: 1; flex-direction: column; gap: 4px; min-width: 180px; }
.external-result p { margin: 0; font-size: 12px; }
.external-qr { width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.external-qr :deep(svg) { display: block; width: 100%; height: 100%; }
.external-code { color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 18px !important; font-weight: 600; letter-spacing: 1px; }
.external-copy { display: flex; flex-wrap: wrap; gap: 6px; }
.external-pending h5 { margin: 0 0 4px; color: var(--ui-text-toned); font-size: 12px; font-weight: 500; }
.external-pending ul { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; font-size: 12px; }
.external-pending li { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
@media (pointer: coarse) { .external-durations button { min-height: 36px; } }
@media (max-width: 480px) { .external-result { flex-direction: column; align-items: stretch; } .external-qr { align-self: center; width: 180px; height: 180px; } }
</style>
