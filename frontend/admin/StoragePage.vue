<script setup>
/**
 * Storage view in the management panel: total `.codiscuss` usage against the 10 GiB limit,
 * separate speech-model directories, per-room & per-member draft breakdown, and finished temp cleanup.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import { t } from "../i18n.js";
import { format_storage_bytes, normalize_storage_snapshot, storage_ratio, storage_tone } from "../storage-format.js";
import AttachmentCleaner from "../AttachmentCleaner.vue";
import SecretKeyInput from "../SecretKeyInput.vue";
import { delete_cloud_files, object_storage_fields, object_storage_values } from "../object-storage-fields.js";

const { state, notify, refreshed, reload, storage_raw: raw, storage_loading: loading, storage_error: error, load_storage } = inject("panel");
const preview = ref(null);
const selected = ref(false);
const repairing = ref(false);
const analyzing = ref(false);
const groups = computed(() => ({
  local: t("房间记录与附件"), drafts: t("成员草稿"), launches: t("运行日志与任务文件"),
  "panel-window": t("管理面板窗口缓存"), pi: t("模型 API 运行环境"), other: t("其他"),
}));

/** Send an inventory request to the platform steward for this panel's account. */
async function analyze_storage() {
  if (analyzing.value) return;
  analyzing.value = true;
  try {
    await call("storage/steward", {});
    notify("info", t("已发送占用分析请求，请到平台主理人对话查看。"));
  } catch (failure) { notify("error", failure.message); }
  finally { analyzing.value = false; }
}

async function repair(apply = false) {
  if (repairing.value || (apply && (!selected.value || !window.confirm(t("确认删除所选日志？此操作无法撤销。"))))) return;
  repairing.value = true;
  try {
    const result = await call("storage/repair", apply ? { logs: true, confirm: true } : {});
    preview.value = apply ? null : result;
    selected.value = false;
    if (apply) {
      notify(result.failed ? "warning" : "info", t("已释放 {size}，跳过 {count} 项", { size: format_storage_bytes(result.freed_bytes), count: result.failed }));
      await load_storage();
    }
  } catch (failure) { notify("error", failure.message); }
  finally { repairing.value = false; }
}
const cleaning = ref(new Set());
const expanded = ref(new Set());
// The room whose attachments are open for clearing; one at a time, as each lists every file of its room.
const attachment_room = ref("");
function attachments_cleared(result) {
  notify("info", t("已释放 {size}", { size: format_storage_bytes(result.freed_bytes) }));
  load_storage();
}

const snapshot = computed(() => normalize_storage_snapshot(raw.value));
const total_tone = computed(() => {
  const s = snapshot.value;
  if (!s) return "normal";
  if (s.truncated || s.total_bytes > s.limits.home_limit_bytes) return "error";
  if (s.warning || s.total_bytes >= s.limits.home_warn_bytes) return "warning";
  return "normal";
});
const draft_tone = computed(() => {
  const s = snapshot.value;
  return s ? storage_tone(s.draft_bytes, s.limits.draft_bytes, s.limits.warn_ratio) : "normal";
});
const disk_low = computed(() => Boolean(snapshot.value?.disk && snapshot.value.disk.available_bytes < snapshot.value.disk.reserve_bytes));

/** Clean confirmed finished execution scratch directories globally or for one room. */
async function clean_temp(room = null) {
  const key = room ? (room.room_id || room.key) : "__all__";
  if (cleaning.value.has(key)) return;
  const next = new Set(cleaning.value);
  next.add(key);
  cleaning.value = next;
  try {
    const payload = room ? { ...(room.room_id ? { room_id: room.room_id } : {}), ...(room.key ? { room_key: room.key } : {}) } : {};
    const result = await call("storage/clean", payload);
    const freed = Number(result?.freed_bytes ?? result?.removed_bytes ?? 0) || 0;
    const skipped = Number(result?.skipped ?? result?.failed ?? 0) || 0;
    if (result?.storage) {
      raw.value = result.storage;
    } else {
      await load_storage();
    }
    reload().catch(() => {});
    notify(skipped ? "warning" : "info", t("已释放 {size}，跳过 {count} 项", { size: format_storage_bytes(freed), count: skipped }));
  } catch (failure) {
    notify("error", failure.message);
  } finally {
    const after = new Set(cleaning.value);
    after.delete(key);
    cleaning.value = after;
  }
}

function toggle_room(key) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function room_tone(room) {
  const limit = snapshot.value?.limits.room_draft_bytes;
  return storage_tone(room.bytes, limit, snapshot.value?.limits.warn_ratio);
}

function tag_class(tone) {
  return tone === "error" ? "is-red" : tone === "warning" ? "is-amber" : "is-green";
}

const attachment_mib = ref(null);
async function save_limit() {
  try {
    await call("storage/attachment-limit", { limit_mib: attachment_mib.value });
    notify("info", t("已保存"));
  } catch (failure) { notify("error", failure.message); }
}
onMounted(async () => {
  try { attachment_mib.value = (await call("storage/attachment-limit")).limit_mib; }
  catch (failure) { notify("error", failure.message); }
});

// Object storage for files over the limit, per account like API keys: the key goes into the account's key store (for a
// hosted account marked as provided by the owner) and the configuration keeps only its reference.
const object_account = ref("");
const object_storage = ref(null);
const object_url = ref("");
const object_busy = ref("");
const object_paths = computed(() => object_account.value
  ? { config: `accounts/${encodeURIComponent(object_account.value)}/object-storage`, keys: `accounts/${encodeURIComponent(object_account.value)}/keys` }
  : { config: "storage/object", keys: "owner/keys" });
// A stored key belongs to the address it was saved for; another address needs its own.
const object_key_saved = computed(() => Boolean(object_storage.value?.api_key_ref) && object_url.value.trim() === object_storage.value.base_url);
function show_object_storage(result) {
  object_storage.value = result;
  object_url.value = result.base_url || "";
}
async function load_object_storage() {
  const account = object_account.value;
  object_storage.value = null;
  try {
    const result = await call(object_paths.value.config);
    if (account === object_account.value) show_object_storage(result);
  } catch (failure) { notify("error", failure.message); }
}
/** Save a newly entered key for the address shown, then bind the configuration to it; SecretKeyInput reports failures. */
async function save_object_key(api_key) {
  const { config, keys } = object_paths.value;
  const base_url = object_url.value.trim();
  if (!base_url) throw new Error(t("请先填写资源中心地址"));
  const { api_key_ref } = await call(keys, { base_url, api_key });
  show_object_storage(await call(config, { base_url, api_key_ref }));
  notify("info", t("已保存"));
}
// The cloud space's number settings (retention days, quota, threshold), each saved on its own when its field is left.
const object_fields = computed(() => object_storage_fields(attachment_mib.value || 50));
const object_values = ref({});
watch(object_storage, (result) => { if (result) object_values.value = object_storage_values(object_fields.value, result); });
async function save_object_field(field) {
  const value = object_values.value[field.key];
  if (!Number.isInteger(value) || value < field.min || value > field.max) { notify("error", field.invalid); return; }
  if (value === object_storage.value?.[field.key]) return;
  const result = await object_action(field.key, () => call(object_paths.value.config, { [field.key]: value }));
  if (result) { object_storage.value = result; notify("info", t("已保存")); }
}
// The account's cloud space files, opened from the section; reread whenever it opens or the account changes.
const cloud_open = ref(false);
const cloud_paths = computed(() => ({ list: `${object_paths.value.config}/files`, remove: `${object_paths.value.config}/files/delete` }));
const delete_cloud = (ids) => delete_cloud_files(ids, (id) => call(cloud_paths.value.remove, { id }));
function cloud_deleted(result) {
  notify("info", t("已释放 {size}", { size: format_storage_bytes(result.freed_bytes) }));
  if (result.error) notify("error", result.error);
}
watch(object_account, () => { cloud_open.value = false; });
async function object_action(action, request) {
  if (object_busy.value) return;
  object_busy.value = action;
  try { return await request(); }
  catch (failure) { notify("error", failure.message); }
  finally { object_busy.value = ""; }
}
async function test_object_storage() {
  if (await object_action("test", () => call(`${object_paths.value.config}/test`, {}))) notify("info", t("连接成功"));
}
async function clear_object_storage() {
  if (!window.confirm(t("清除后超过上限的文件将无法上传，已存于对象存储的附件也无法下载。确认清除？"))) return;
  const result = await object_action("clear", () => call(`${object_paths.value.config}/clear`, {}));
  if (result) { show_object_storage(result); notify("info", t("已清除")); }
}
onMounted(load_object_storage);
watch(object_account, load_object_storage);
// A removed hosted account falls back to the owner.
watch(() => state.value.accounts, (accounts) => {
  if (object_account.value && !accounts.some(item => item.name === object_account.value)) object_account.value = "";
});
onMounted(() => { if (!raw.value && !loading.value) load_storage(); });
watch(refreshed, () => load_storage());
</script>

<template>
  <section>
    <h3 class="panel-section-title">
      <UIcon name="i-lucide-hard-drive" />{{ t("共议数据") }}
      <span class="panel-section-action storage-head-actions">
        <button type="button" class="panel-button is-outline is-small" :disabled="analyzing" @click="analyze_storage">
          <UIcon name="i-lucide-sparkles" />{{ t("让平台主理人分析占用") }}
        </button>
        <button type="button" class="panel-button is-plain is-small" :disabled="loading" @click="load_storage">
          <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': loading }" />{{ t("刷新") }}
        </button>
      </span>
    </h3>

    <form v-if="attachment_mib !== null" class="panel-row" @submit.prevent="save_limit">
      <label>{{ t("单个附件上限（MiB）") }} <input v-model.number="attachment_mib" type="number" required min="1" max="90" step="1"></label>
      <button class="panel-button" type="submit">{{ t("保存") }}</button>
    </form>
    <h3 class="panel-section-title">
      <UIcon name="i-lucide-cloud-upload" />{{ t("云空间（对象存储）") }}
      <span v-if="object_storage" class="panel-tag" :class="object_storage.configured ? 'is-green' : 'is-gray'">{{ object_storage.configured ? t("已配置") : t("未配置") }}</span>
      <span v-if="object_account && object_storage?.configured" class="panel-tag" :class="object_storage.managed ? 'is-blue' : 'is-gray'">{{ object_storage.managed ? t("管理员提供") : t("账号自行填写") }}</span>
    </h3>
    <p class="panel-guide">{{ t("每个账号一份云空间，建在资源中心的对象存储上：大于门槛的附件（最大 2 GiB）存到这里，房间里发的大文件和成员交付的大文件都能从这里取走。只经房间附件进出，可设自动删除，也可在“管理云空间”里手动删除。未配置时只能发送上限以内的附件。存储桶须允许网页所在地址跨域上传。每个账号各用自己的 Key，与 API 密钥一起保存。") }}</p>
    <div v-if="state.hosting && state.accounts.length" class="panel-chips storage-object-accounts" role="group" :aria-label="t('配置哪个账号的对象存储')">
      <button type="button" class="panel-chip" :class="{ 'is-active': !object_account }" @click="object_account = ''">{{ t("管理员") }}</button>
      <button v-for="account in state.accounts" :key="account.name" type="button" class="panel-chip" :class="{ 'is-active': object_account === account.name }" @click="object_account = account.name">{{ account.name }}</button>
    </div>
    <div v-if="object_storage" class="panel-row storage-object-form">
      <label class="panel-field">{{ t("资源中心地址") }}<input v-model.trim="object_url" class="panel-input" type="url" placeholder="https://…" spellcheck="false"></label>
      <div class="panel-field">{{ t("Key") }}
        <SecretKeyInput :key="`${object_account}\u0000${object_storage.api_key_ref || ''}\u0000${object_key_saved}`" :save="save_object_key" :saved="object_key_saved" :disabled="!object_url.trim()" :label="t('对象存储 Key')" :placeholder="t('填写 Key，失焦或回车保存')" size="sm" @error="(failure) => notify('error', failure.message)" />
        <small v-if="object_account">{{ t("对方界面不显示 Key，但对方账号里的 AI 成员能读到本账号的密钥文件；请给每个账号单独的 Key。") }}</small>
      </div>
      <label v-for="field in object_fields" :key="field.key" class="panel-field">{{ field.label }}
        <input v-model.number="object_values[field.key]" class="panel-input storage-object-number" type="number" :min="field.min" :max="field.max" step="1" :disabled="Boolean(object_busy)" @change="save_object_field(field)">
        <small>{{ field.help }}</small></label>
      <div class="storage-object-actions">
        <button class="panel-button is-outline" type="button" :disabled="!object_storage.configured || Boolean(object_busy)" @click="test_object_storage">
          <UIcon v-if="object_busy === 'test'" name="i-lucide-loader" class="animate-spin" />{{ t("测试连接") }}
        </button>
        <button class="panel-button is-outline" type="button" :disabled="!object_storage.configured" @click="cloud_open = !cloud_open">{{ cloud_open ? t("收起云空间") : t("管理云空间") }}</button>
        <button class="panel-button is-outline storage-danger" type="button" :disabled="!object_storage.configured || Boolean(object_busy)" @click="clear_object_storage">{{ t("清除") }}</button>
      </div>
      <AttachmentCleaner v-if="cloud_open && object_storage.configured" :key="object_account" cloud :load="() => call(cloud_paths.list)" :clear="delete_cloud"
        @cleared="cloud_deleted" @failed="(message) => notify('error', message)" />
    </div>
    <div v-if="!snapshot && loading" class="panel-rows" role="status" :aria-label="t('正在统计存储占用…')">
      <div class="panel-row">
        <USkeleton class="panel-tile" />
        <div class="panel-main"><USkeleton class="panel-skeleton-title" /><USkeleton class="panel-skeleton-sub" /></div>
      </div>
    </div>

    <div v-else-if="!snapshot && error" class="panel-empty" role="alert">
      <UIcon name="i-lucide-triangle-alert" />
      <span>{{ t("读取存储占用失败：{reason}", { reason: error }) }}</span>
      <button type="button" class="panel-button is-outline is-small" @click="load_storage">{{ t("重试") }}</button>
    </div>

    <template v-else-if="snapshot">
      <p class="panel-guide">{{ t("存储上限通过定期采样检查（有执行时每 2 秒查磁盘余量、每 30 秒扫描占用），并非文件系统写入层硬拦截，无法保证磁盘绝不写满。") }}</p>
      <p v-if="snapshot.truncated || snapshot.total_bytes > snapshot.limits.home_limit_bytes || disk_low" class="panel-note is-red storage-banner" role="alert">
        <UIcon name="i-lucide-octagon-alert" />
        <span>{{ snapshot.block_reason || t("存储占用已超过上限或磁盘剩余空间低于安全线，新的派活已暂停。请先清理下方临时文件或释放磁盘空间；房间记录与附件需手动销毁旧房间。") }}</span>
      </p>
      <p v-else-if="snapshot.warning" class="panel-note is-amber storage-banner" role="status">
        <UIcon name="i-lucide-triangle-alert" />
        <span>{{ snapshot.warning_reason || t("本机 .codiscuss 数据已占 {used}，接近 {limit} 上限（预警线 {warn}）。建议清理临时文件。", { used: format_storage_bytes(snapshot.total_bytes), limit: format_storage_bytes(snapshot.limits.home_limit_bytes), warn: format_storage_bytes(snapshot.limits.home_warn_bytes) }) }}</span>
      </p>
      <p v-if="snapshot.unreadable > 0" class="panel-note is-amber storage-banner" role="status">
        <UIcon name="i-lucide-shield-alert" />
        <span>{{ t("有 {count} 处目录或文件因权限无法读取（例如沙箱创建的目录），未计入配额。深度修理也会保留这些目录；如需删除，请以管理员身份手动操作。", { count: snapshot.unreadable }) }}</span>
      </p>

      <div class="panel-rows">
        <div class="panel-row storage-total-row">
          <div class="panel-tile"><UIcon name="i-lucide-database" /></div>
          <div class="panel-main">
            <div class="panel-title">
              {{ t("本机 .codiscuss 数据") }}
              <span class="panel-tag" :class="tag_class(total_tone)">
                {{ t("{used} / {limit}", { used: format_storage_bytes(snapshot.total_bytes), limit: format_storage_bytes(snapshot.limits.home_limit_bytes) }) }}
              </span>
              <span v-if="snapshot.unreadable > 0" class="panel-tag is-amber">{{ t("{count} 处不可读", { count: snapshot.unreadable }) }}</span>
              <span v-if="snapshot.truncated" class="panel-tag is-red">{{ t("超过 {limit} 文件上限", { limit: snapshot.limits.max_scan_files }) }}</span>
            </div>
            <div class="storage-bar" :class="`is-${total_tone}`" aria-hidden="true">
              <i :style="{ width: `${Math.round(storage_ratio(snapshot.total_bytes, snapshot.limits.home_limit_bytes) * 100)}%` }"></i>
            </div>
            <span class="panel-sub">
              {{ t("草稿合计 {draft} / {draft_limit} · 房间记录与附件 {local}（不含语音模型）", { draft: format_storage_bytes(snapshot.draft_bytes), draft_limit: format_storage_bytes(snapshot.limits.draft_bytes), local: format_storage_bytes(snapshot.local_bytes) }) }}
              <template v-if="snapshot.disk">
                · {{ t("所在磁盘剩余 {free}（安全线 {reserve}）", { free: format_storage_bytes(snapshot.disk.available_bytes), reserve: format_storage_bytes(snapshot.disk.reserve_bytes) }) }}
              </template>
            </span>
          </div>
          <div class="panel-side">
            <button type="button" class="panel-button is-outline is-small" :disabled="cleaning.has('__all__')" :title="t('清除朗读缓存后，用云端语音重听旧内容会重新合成并计费。')" @click="clean_temp()">
              <UIcon :name="cleaning.has('__all__') ? 'i-lucide-loader' : 'i-lucide-trash-2'" :class="{ 'animate-spin': cleaning.has('__all__') }" />
              {{ cleaning.has('__all__') ? t("清理中…") : t("安全清理") }}
            </button>
            <button class="panel-button is-outline is-small storage-danger" :disabled="repairing" @click="repair()">{{ t("深度修理") }}</button>
          </div>
        </div>
        <ul v-if="raw?.groups" class="storage-member-list">
          <li v-for="(label, key) in groups" :key="key">
            {{ label }} <small v-if="key !== 'other'">{{ key }}/</small>
            <span class="storage-member-size">{{ format_storage_bytes(raw.groups[key]) }}</span>
          </li>
        </ul>
        <p v-if="preview && snapshot.unreadable" class="panel-note is-amber">{{ t("无法核实不可读目录的大小、内容和当前使用者，已保留。") }}</p>
        <p v-if="preview && raw?.groups?.['panel-window']" class="panel-note">{{ t("窗口配置占 {size}。无法确认所有窗口进程已退出，已保留登录和窗口数据。", { size: format_storage_bytes(raw.groups['panel-window']) }) }}</p>
        <div v-if="preview" class="panel-row">
          <label><input type="checkbox" v-model="selected"> {{ t("删除已结束执行的日志（含最近 24 小时），之后无法排查这些执行。预计释放 {size}。", { size: format_storage_bytes(preview.freed_bytes) }) }}</label>
          <button class="panel-button storage-danger" :disabled="!selected || repairing" @click="repair(true)">{{ t("确认深度修理") }}</button>
          <button class="panel-button" :disabled="repairing" @click="preview = null">{{ t("取消") }}</button>
        </div>
        <div class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-folder-archive" /></div>
          <div class="panel-main">
            <div class="panel-title">
              {{ t("全机草稿区") }}
              <span class="panel-tag" :class="tag_class(draft_tone)">
                {{ t("{used} / {limit}", { used: format_storage_bytes(snapshot.draft_bytes), limit: format_storage_bytes(snapshot.limits.draft_bytes) }) }}
              </span>
            </div>
            <div class="storage-bar" :class="`is-${draft_tone}`" aria-hidden="true">
              <i :style="{ width: `${Math.round(storage_ratio(snapshot.draft_bytes, snapshot.limits.draft_bytes) * 100)}%` }"></i>
            </div>
            <span class="panel-sub">
              {{ snapshot.scratch_bytes > 0
                ? t("其中可回收执行临时文件 {size}；单房间上限 {room_limit}。历史草稿和成品不会自动删除。", { size: format_storage_bytes(snapshot.scratch_bytes), room_limit: format_storage_bytes(snapshot.limits.room_draft_bytes) })
                : t("单房间草稿上限 {room_limit}；历史草稿和成品不会自动删除。", { room_limit: format_storage_bytes(snapshot.limits.room_draft_bytes) }) }}
            </span>
          </div>
        </div>

        <div class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-file-archive" /></div>
          <div class="panel-main">
            <div class="panel-title">
              {{ t("房间记录与附件（local/）") }}
              <span class="panel-tag is-gray">{{ format_storage_bytes(snapshot.local_bytes) }}</span>
            </div>
            <span class="panel-sub">{{ t("保存房间消息、事件与附件原件，计入 10 GiB 数据上限；程序不会自动删除。可在下方按房间清理附件原件，或销毁旧房间。") }}</span>
          </div>
        </div>
      </div>

      <template v-if="raw?.attachment_rooms?.length">
        <h3 class="panel-section-title"><UIcon name="i-lucide-images" />{{ t("房间附件") }}</h3>
        <div class="panel-rows">
          <template v-for="item in raw.attachment_rooms" :key="item.room_id">
            <div class="panel-row">
              <div class="panel-tile"><UIcon name="i-lucide-paperclip" /></div>
              <div class="panel-main">
                <div class="panel-title">
                  <span>{{ item.title || item.room_id }}</span>
                  <span class="panel-tag is-gray">{{ format_storage_bytes(item.bytes) }}</span>
                </div>
                <span class="panel-sub">{{ t("{count} 个附件 · 最近 {date}", { count: item.count, date: new Date(item.latest_at).toLocaleDateString() }) }}</span>
              </div>
              <div class="panel-side">
                <button type="button" class="panel-button is-outline is-small" @click="attachment_room = attachment_room === item.room_id ? '' : item.room_id">
                  {{ attachment_room === item.room_id ? t("收起") : t("管理附件") }}
                </button>
              </div>
            </div>
            <div v-if="attachment_room === item.room_id" class="panel-row-extra storage-attachments">
              <AttachmentCleaner :load="() => call('storage/attachments', { room_id: item.room_id })"
                :clear="(ids) => call('storage/attachments/clear', { room_id: item.room_id, ids })"
                @cleared="attachments_cleared" @failed="(message) => notify('error', message)" />
            </div>
          </template>
        </div>
      </template>

      <h3 class="panel-section-title"><UIcon name="i-lucide-audio-lines" />{{ t("语音模型（不计入 10 GiB 上限）") }}</h3>
      <div class="panel-rows">
        <div class="panel-row">
          <div class="panel-tile"><UIcon name="i-lucide-mic" /></div>
          <div class="panel-main">
            <div class="panel-title">
              {{ t("本机语音模型") }}
              <span class="panel-tag is-gray">{{ format_storage_bytes(snapshot.models.total_bytes) }}</span>
            </div>
            <span class="panel-sub">{{ t("朗读与语音识别模型单独统计，不计入 10 GiB 共议数据上限。") }}</span>
          </div>
        </div>
        <div v-for="model in snapshot.models.entries" :key="model.path || model.name" class="panel-row storage-sub-row">
          <div class="panel-main">
            <div class="panel-title storage-sub-title">
              <span>{{ model.name || t("语音模型") }}</span>
              <span class="panel-tag is-gray">{{ format_storage_bytes(model.bytes) }}</span>
            </div>
            <span v-if="model.path" class="panel-sub">{{ model.path }}</span>
          </div>
        </div>
      </div>

      <h3 class="panel-section-title"><UIcon name="i-lucide-messages-square" />{{ t("按房间与成员拆分") }}</h3>
      <div v-if="!snapshot.rooms.length" class="panel-empty">
        <UIcon name="i-lucide-folder-open" />
        <span>{{ t("当前没有房间草稿占用") }}</span>
      </div>
      <div v-else class="panel-rows">
        <template v-for="room in snapshot.rooms" :key="room.key || room.room_id">
          <div class="panel-row">
            <div class="panel-tile"><UIcon name="i-lucide-message-square" /></div>
            <div class="panel-main">
              <div class="panel-title">
                <span>{{ room.title || room.room_id || room.key }}</span><span v-if="room.unreadable" class="panel-tag is-amber">{{ t("{count} 处不可读", { count: room.unreadable }) }}</span>
                <span class="panel-tag" :class="tag_class(room_tone(room))">
                  {{ t("{used} / {limit}", { used: format_storage_bytes(room.bytes), limit: format_storage_bytes(snapshot.limits.room_draft_bytes) }) }}
                </span>
                <span v-if="room.scratch_bytes > 0" class="panel-tag is-blue">
                  {{ t("临时 {size}", { size: format_storage_bytes(room.scratch_bytes) }) }}
                </span>
              </div>
              <div class="storage-bar" :class="`is-${room_tone(room)}`" aria-hidden="true">
                <i :style="{ width: `${Math.round(storage_ratio(room.bytes, snapshot.limits.room_draft_bytes) * 100)}%` }"></i>
              </div>
              <span class="panel-sub">
                {{ room.room_id && room.title ? t("房间编号 {id} · 草稿目录 {key}", { id: room.room_id, key: room.key }) : t("草稿目录 {key}", { key: room.key }) }}
              </span>
            </div>
            <div class="panel-side">
              <button v-if="room.members.length" type="button" class="panel-button is-plain is-small" @click="toggle_room(room.key || room.room_id)">
                <UIcon :name="expanded.has(room.key || room.room_id) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" />
                {{ expanded.has(room.key || room.room_id) ? t("收起成员") : t("成员（{count}）", { count: room.members.length }) }}
              </button>
              <button v-if="room.scratch_bytes > 0" type="button" class="panel-button is-outline is-small" :disabled="cleaning.has(room.room_id || room.key)" @click="clean_temp(room)">
                <UIcon :name="cleaning.has(room.room_id || room.key) ? 'i-lucide-loader' : 'i-lucide-trash-2'" :class="{ 'animate-spin': cleaning.has(room.room_id || room.key) }" />
                {{ t("清理临时文件") }}
              </button>
            </div>
          </div>
          <div v-if="room.members.length && expanded.has(room.key || room.room_id)" class="panel-row-extra storage-members">
            <ul class="storage-member-list">
              <li v-for="member in room.members" :key="member.key">
                <span class="storage-member-name">{{ member.label || member.key }}</span>
                <span class="storage-member-size">{{ format_storage_bytes(member.bytes) }}</span>
                <small v-if="member.scratch_bytes > 0" class="storage-member-temp">{{ t("含临时 {size}", { size: format_storage_bytes(member.scratch_bytes) }) }}</small>
              </li>
            </ul>
          </div>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.storage-danger { color: var(--panel-red); }
.storage-head-actions { display: flex; align-items: center; gap: 6px; }
.storage-banner { margin-bottom: 12px; }
.storage-object-form { flex-direction: column; align-items: stretch; gap: 12px; max-width: 520px; }
.storage-object-accounts { margin-bottom: 8px; }
.storage-object-actions { display: flex; gap: 8px; }
.storage-object-number { max-width: 140px; }
.storage-bar { height: 5px; width: 100%; max-width: 360px; margin: 2px 0; overflow: hidden; border-radius: 999px; background: var(--panel-tint); }
.storage-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--panel-blue); transition: width .2s ease; }
.storage-bar.is-warning > i { background: var(--panel-amber); }
.storage-bar.is-error > i { background: var(--panel-red); }
.storage-warn-text { color: var(--panel-amber); }
.storage-sub-row { min-height: 54px; padding: 10px 0 10px 54px; }
.storage-sub-title { font-size: 14px; font-weight: 500; }
.storage-members { padding-top: 2px; }
.storage-attachments { display: block; padding: 4px 0 12px 54px; }
.storage-member-list { display: flex; flex: 1; flex-direction: column; gap: 6px; margin: 0; padding: 8px 12px; list-style: none; border-radius: 12px; background: var(--panel-tint); font-size: 13px; }
.storage-member-list li { display: flex; align-items: center; gap: 8px; }
.storage-member-name { color: var(--panel-text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.storage-member-size { margin-left: auto; color: var(--panel-muted); font-variant-numeric: tabular-nums; }
.storage-member-temp { color: var(--panel-blue); font-size: 12px; }
@media (max-width: 600px) {
  .storage-total-row { display: grid; grid-template-columns: auto minmax(0, 1fr); }
  .storage-total-row > .panel-side { grid-column: 2; }
}
</style>
