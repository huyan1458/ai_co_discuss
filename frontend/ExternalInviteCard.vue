<script setup>
/**
 * The invite dialog's card for an AI on another computer: what it may do, which of this room's directories it reads,
 * how long it stays; "生成邀请" shows a link, QR code and pairing code to send yourself. Pending invitations are
 * listed under it and can be revoked.
 */
import { computed, inject, onUnmounted, ref, useId, watch } from "vue";
import { renderSVG } from "uqr";
import { DURATIONS, LEVELS, LEVEL_SHORT, external_of, remaining_label, room_operations, runner_text, time_ms } from "./external-members.js";
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
// A redeemed invitation leaves the list the moment its member appears (when the rail announces the join).
watch(() => (room.value?.free?.members || []).filter((member) => external_of(member)).map((member) => member.id).join(), (now, before) => {
  if (before !== undefined && now !== before) load_invites();
});

async function run(name, operation) {
  if (busy.value) return;
  busy.value = name;
  try { await operation(); }
  catch (error) { bridge.notify("error", runner_text(error.message)); }
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
// Ties each segmented control to its visible label.
const uid = useId();
</script>

<template>
  <!-- Framed like an expert card's face (border, radius, surface, identity row, tools at the top right), but as wide as
       the dialog: the form and the generated link with its QR code do not fit a square. -->
  <section class="external-invite" :aria-label="t('邀请另一台电脑上的 AI')">
    <header class="external-invite-identity">
      <span class="external-invite-avatar channel-avatar external" aria-hidden="true"><UIcon name="i-lucide-laptop-minimal" /></span>
      <span class="external-invite-names"><strong>{{ t("另一台电脑") }}</strong><small>{{ t("对方用自己电脑上的 AI 加入，只读本房间开放的内容") }}</small></span>
      <span class="external-invite-tools">
        <button type="button" :aria-label="t('移除这张卡片')" :title="t('移除这张卡片')" @click="emit('remove')"><UIcon name="i-lucide-x" /></button>
      </span>
    </header>
    <template v-if="!invite">
      <div class="external-invite-field">
        <span :id="`${uid}-level`" class="external-invite-label">{{ t("能做什么") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-level`">
          <button v-for="option in LEVELS" :key="option.value" type="button" role="radio" :aria-checked="level === option.value" :aria-label="option.label" @click="level = option.value">{{ option.label }}</button>
        </div>
        <p class="external-invite-hint">{{ LEVELS.find((option) => option.value === level)?.description }}</p>
      </div>
      <div v-if="level === 'read'" class="external-invite-field" role="group" :aria-labelledby="`${uid}-folders`">
        <span :id="`${uid}-folders`" class="external-invite-label">{{ t("开放目录") }}</span>
        <p v-if="!room_directories.length" class="external-invite-empty">{{ t("本房间还没有项目目录，只能选“只讨论”。") }}</p>
        <div v-else class="external-invite-folders">
          <UCheckbox v-for="path in room_directories" :key="path" :title="path" :model-value="directories.includes(path)" :label="leaf(path)" size="xs"
            @update:model-value="(on) => directories = on ? [...directories, path] : directories.filter((item) => item !== path)" />
        </div>
        <p class="external-invite-hint">{{ t("只读：已跟踪与未忽略的文件，固定排除 .env、密钥、凭据、data/ 与 .git。") }}</p>
      </div>
      <div class="external-invite-field">
        <span :id="`${uid}-duration`" class="external-invite-label">{{ t("有效期") }}</span>
        <div class="expert-card-modes" role="radiogroup" :aria-labelledby="`${uid}-duration`">
          <button v-for="option in DURATIONS" :key="option.value" type="button" role="radio" :aria-checked="duration === option.value" @click="duration = option.value">{{ option.label }}</button>
        </div>
      </div>
      <footer class="external-invite-footer">
        <p class="external-invite-warning" role="note"><UIcon name="i-lucide-triangle-alert" />{{ level === 'read' ? t("项目内容会经对方的 AI 发送给其模型服务商；读出去的内容收不回，撤销只阻止以后的读取。") : t("房间里发给它的内容会经对方的 AI 发送给其模型服务商。") }}</p>
        <p v-if="!view.launch.available && !view.launch.remote" class="external-invite-warning is-error" role="alert"><UIcon name="i-lucide-plug-zap" />{{ t("生成邀请需要本机服务，请在这台电脑打开本机网站。") }}</p>
        <UButton icon="i-lucide-link" :label="t('生成邀请')" size="sm" class="channel-primary-button external-invite-generate" :loading="busy === 'create'" :disabled="Boolean(busy) || needs_directory || !view.launch.available && !view.launch.remote" @click="generate" />
      </footer>
    </template>
    <div v-else class="external-invite-result" role="status" aria-live="polite">
      <!-- eslint-disable-next-line vue/no-v-html -- an SVG this page rendered from the computer's own link -->
      <div v-if="invite.svg" class="external-invite-qr" role="img" :aria-label="t('邀请二维码')" v-html="invite.svg" />
      <div class="external-invite-result-body">
        <p>{{ t("把链接或二维码发给对方；对方也可以在自己的共议里输入配对码：") }}</p>
        <p class="external-invite-code">{{ invite.code }}</p>
        <div class="external-invite-copy">
          <UButton :icon="copied === 'url' ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied === 'url' ? t('已复制') : t('复制链接')" size="xs" :color="copied === 'url' ? 'success' : 'neutral'" variant="outline" @click="copy('url', invite.url)" />
          <UButton :icon="copied === 'code' ? 'i-lucide-check' : 'i-lucide-copy'" :label="copied === 'code' ? t('已复制') : t('复制配对码')" size="xs" :color="copied === 'code' ? 'success' : 'neutral'" variant="outline" @click="copy('code', invite.code)" />
          <UButton :label="t('再生成一个')" icon="i-lucide-refresh-cw" size="xs" color="neutral" variant="ghost" @click="invite = null" />
        </div>
        <p class="external-invite-hint">{{ t("{time} 前兑换有效，只能用一次。对方兑换后直接成为成员，你会收到提示，可随时撤销。", { time: date(invite.expires_at) }) }}</p>
        <p class="external-invite-hint">{{ t("配对码不含这台电脑的公钥指纹，优先发链接或二维码。") }}</p>
      </div>
    </div>
    <div v-if="invites.length" class="external-invite-pending">
      <span class="external-invite-label">{{ t("待兑换的邀请") }}</span>
      <ul>
        <li v-for="item in invites" :key="item.invite_id">
          <UIcon name="i-lucide-ticket" aria-hidden="true" />
          <span>{{ t("{level} · 成员 {duration} · {left}内兑换", { level: LEVEL_SHORT[item.level] || item.level, duration: DURATIONS.find((option) => option.value === item.duration)?.label || item.duration, left: remaining_label(item.expires_at) }) }}</span>
          <UButton :label="t('撤销邀请')" size="xs" color="error" variant="ghost" :loading="busy === `revoke:${item.invite_id}`" :disabled="Boolean(busy)" @click="revoke(item)" />
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
/* The expert card's face: the same edge, radius, surface and shadow (ExpertCard.vue .expert-card-face). */
.external-invite { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 12px; border: 1px solid var(--channel-edge-control, var(--ui-border)); border-radius: 8px;
  background: color-mix(in srgb, var(--ui-bg-elevated) 45%, var(--ui-bg)); box-shadow: var(--channel-shadow-control); }
.external-invite:hover { border-color: var(--ui-border-accented); }
/* Identity row as on the card's front: a 26px plate, the name in 13px semibold, a one-line muted subtitle, tools at the right. */
.external-invite-identity { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 26px; }
.external-invite-avatar { display: grid; flex-shrink: 0; place-items: center; width: 26px; height: 26px; border-radius: 999px; background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
.external-invite-avatar > span { width: 14px; height: 14px; }
.external-invite-names { display: grid; flex: 1; min-width: 0; }
.external-invite-names strong { overflow: hidden; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.external-invite-names small { overflow: hidden; color: var(--ui-text-muted); font-size: 11px; line-height: 16px; white-space: nowrap; text-overflow: ellipsis; }
.external-invite-tools { display: flex; flex-shrink: 0; gap: 2px; margin: -2px -4px 0 0; }
.external-invite-tools > button { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 5px; color: var(--ui-text-dimmed); }
.external-invite-tools > button > span { width: 13px; height: 13px; }
.external-invite-tools > button:hover { background: var(--ui-bg-accented); color: var(--ui-text-highlighted); }
/* Fields read like the card's back: a small dimmed label, the control, a one-line hint. */
.external-invite-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.external-invite-label { color: var(--ui-text-dimmed); font-size: 11px; }
.external-invite-hint { margin: 0; color: var(--ui-text-muted); font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.external-invite-empty { margin: 0; padding: 10px; border: 1px dashed var(--ui-border); border-radius: 6px; color: var(--ui-text-muted); font-size: 11px; text-align: center; }
.external-invite-field .expert-card-modes { max-width: 360px; }
.external-invite-field .expert-card-modes button { padding: 0 8px; white-space: nowrap; }
.external-invite-folders { display: flex; flex-wrap: wrap; gap: 6px 16px; min-width: 0; }
.external-invite-folders > * { min-width: 0; max-width: 100%; }
/* Warning and the card's own action sit under a divider, as the facts do on the card's front. */
.external-invite-footer { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: 8px 12px; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); }
.external-invite-warning { display: flex; flex: 1 1 260px; gap: 6px; margin: 0; color: var(--ui-warning, #e0a33a); font-size: 11px; line-height: 1.5; }
.external-invite-warning.is-error { color: var(--ui-error); }
/* The icon centred on the first 16.5px line, at the size the other 11px rows use. */
.external-invite-warning > :first-child { flex: none; width: 13px; height: 13px; margin-top: 2px; }
.external-invite-generate { flex-shrink: 0; }
.external-invite-result { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); }
.external-invite-result-body { display: flex; flex: 1; flex-direction: column; gap: 6px; min-width: 200px; }
.external-invite-result-body > p:first-child { margin: 0; color: var(--ui-text-toned); font-size: 12px; }
/* The QR code keeps a white plate in both themes so phone cameras read it (same as device pairing). */
.external-invite-qr { flex-shrink: 0; width: 148px; height: 148px; padding: 6px; border-radius: 8px; background: #fff; }
.external-invite-qr :deep(svg) { display: block; width: 100%; height: 100%; }
.external-invite-code { margin: 0; color: var(--ui-text-highlighted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 18px; font-weight: 600; letter-spacing: 1px; }
.external-invite-copy { display: flex; flex-wrap: wrap; gap: 6px; }
.external-invite-pending { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid var(--ui-border-muted); }
.external-invite-pending ul { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.external-invite-pending li { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 2px 4px 2px 8px; border: 1px solid var(--ui-border-muted); border-radius: 6px; color: var(--ui-text-toned); font-size: 12px; }
.external-invite-pending li > span:not([class*="icon"]) { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.external-invite-pending li > [class*="icon"] { flex-shrink: 0; width: 13px; height: 13px; color: var(--ui-text-dimmed); }
/* Touch screens: segments, tools and rows take a fingertip. */
@media (pointer: coarse) {
  .external-invite-field .expert-card-modes button { min-height: 32px; }
  /* The bigger target keeps its icon on the content's right edge. */
  .external-invite-tools { margin: -7px -11px -7px 0; }
  .external-invite-tools > button { width: 36px; height: 36px; }
  .external-invite-pending li { min-height: 40px; }
}
/* Phones: the QR code above its text, the action across the card. */
@media (max-width: 480px) {
  .external-invite-result { flex-direction: column; align-items: stretch; }
  .external-invite-qr { align-self: center; width: 180px; height: 180px; }
  .external-invite-field .expert-card-modes { max-width: none; }
  /* The subtitle wraps instead of cutting off what the member may read. */
  .external-invite-names small { white-space: normal; }
  .external-invite-generate { width: 100%; justify-content: center; }
}
</style>
