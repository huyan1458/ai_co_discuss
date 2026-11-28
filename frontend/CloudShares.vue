<script setup>
/**
 * Share links of one cloud space file, opened under its row in the cloud space list: the links made so far with their
 * state and expiry (each can be revoked at once), and a new link for 1 to 30 days. A link's address is shown only when
 * it is made, as the computer keeps just a hash of its token.
 *
 * Props:
 *   file: the cloud space file. api: { list(file) → { shares }, create(file, days, code) → { share: { url, ... }, code? },
 *     revoke(file, share) → { share } }. withCode: offer a 4-character access code for the new link.
 * Emits `failed(message)` when a request fails.
 */
import { onMounted, ref } from "vue";
import { t } from "./i18n.js";

const props = defineProps({ file: { type: Object, required: true }, api: { type: Object, required: true }, withCode: Boolean });
// Whether the new link asks for a 4-character access code; the code, like the link, shows only when it is made.
const need_code = ref(false);
const emit = defineEmits(["failed"]);
const DEFAULT_DAYS = 7, MAX_DAYS = 30;
const shares = ref(null);
const days = ref(DEFAULT_DAYS);
const busy = ref("");
// The address of the link just made, shown until the list closes.
const made = ref(null);

async function run(name, task) {
  if (busy.value) return;
  busy.value = name;
  try { await task(); }
  catch (failure) { emit("failed", failure.message); }
  finally { busy.value = ""; }
}
const reload = () => run("list", async () => { shares.value = (await props.api.list(props.file)).shares || []; });
const create = () => run("create", async () => {
  const answer = await props.api.create(props.file, days.value, props.withCode && need_code.value);
  const share = { ...answer.share, ...(answer.code || answer.share?.code ? { code: answer.code || answer.share.code } : {}) };
  made.value = share;
  shares.value = [share, ...(shares.value || [])];
});
const revoke = (share) => run(share.id, async () => {
  const { share: changed } = await props.api.revoke(props.file, share);
  shares.value = shares.value.map((item) => item.id === share.id ? { ...item, ...changed } : item);
  if (made.value?.id === share.id) made.value = null;
});
async function copy(url) {
  try { await navigator.clipboard.writeText(url); }
  catch (failure) { emit("failed", failure.message); }
}

const STATES = { active: t("有效"), expired: t("已过期"), revoked: t("已撤销"), unavailable: t("文件不可用") };
const expiry = (value) => new Date(value).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
onMounted(reload);
</script>

<template>
  <div class="cloud-shares">
    <div class="cloud-shares-new">
      <label>{{ t("有效期") }}
        <select v-model.number="days" :disabled="Boolean(busy)">
          <option v-for="value in MAX_DAYS" :key="value" :value="value">{{ t("{days} 天", { days: value }) }}</option>
        </select>
      </label>
      <label v-if="withCode"><input v-model="need_code" type="checkbox" :disabled="Boolean(busy)"> {{ t("需要提取码") }}</label>
      <button type="button" class="cloud-shares-button" :disabled="Boolean(busy)" @click="create">{{ busy === "create" ? t("正在创建…") : t("创建分享链接") }}</button>
    </div>
    <p v-if="made" class="cloud-shares-made">
      <span>{{ t("分享链接（只显示这一次，请现在复制）：") }}</span>
      <code>{{ made.url }}</code>
      <template v-if="made.code">
        <span>{{ t("提取码：") }}</span><code>{{ made.code }}</code>
        <button type="button" class="cloud-shares-button" @click="copy(t('链接：{url} 提取码：{code}', { url: made.url, code: made.code }))">{{ t("复制链接和提取码") }}</button>
      </template>
      <button v-else type="button" class="cloud-shares-button" @click="copy(made.url)">{{ t("复制") }}</button>
    </p>
    <p v-if="shares === null" class="cloud-shares-empty">{{ t("正在读取分享链接…") }}</p>
    <p v-else-if="!shares.length" class="cloud-shares-empty">{{ t("还没有分享链接。拿到链接的人不用登录就能下载这个文件，到期或撤销后失效。") }}</p>
    <ul v-else class="cloud-shares-list">
      <li v-for="share in shares" :key="share.id">
        <span :class="`is-${share.status}`">{{ STATES[share.status] || share.status }}</span>
        <small>{{ share.status === "revoked" ? t("撤销于 {time}", { time: expiry(share.revoked_at) }) : t("到期 {time}", { time: expiry(share.expires_at) }) }}</small>
        <button v-if="share.status === 'active'" type="button" class="cloud-shares-button is-danger" :disabled="Boolean(busy)" @click="revoke(share)">{{ t("撤销") }}</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.cloud-shares { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 8px 26px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 5%, transparent); font-size: 12px; }
.cloud-shares-new { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.cloud-shares-new select { margin-left: 4px; padding: 2px 4px; color: inherit; font: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 5px; }
.cloud-shares-button { padding: 3px 10px; color: inherit; font: inherit; background: transparent; border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 5px; cursor: pointer; }
.cloud-shares-button:disabled { opacity: .45; cursor: default; }
.cloud-shares-button.is-danger { color: #f05252; border-color: #f05252; }
.cloud-shares-made { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0; }
.cloud-shares-made code { min-width: 0; overflow-wrap: anywhere; font-size: 11px; }
.cloud-shares-empty { margin: 0; opacity: .65; }
.cloud-shares-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.cloud-shares-list li { display: flex; gap: 8px; align-items: center; }
.cloud-shares-list small { flex: 1; opacity: .65; }
.cloud-shares-list .is-active { color: #2aa875; }
.cloud-shares-list :is(.is-expired, .is-revoked, .is-unavailable) { opacity: .6; }
</style>
