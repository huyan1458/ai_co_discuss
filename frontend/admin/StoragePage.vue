<script setup>
/**
 * Storage view in the management panel: total `.codiscuss` usage against the 10 GiB limit,
 * separate speech-model directories, per-room & per-member draft breakdown, and finished temp cleanup.
 */
import { computed, inject, onMounted, ref, watch } from "vue";
import { call } from "./api.js";
import { t } from "../i18n.js";
import { format_storage_bytes, normalize_storage_snapshot, storage_ratio, storage_tone } from "../storage-format.js";

const { notify, refreshed, reload, storage_raw: raw, storage_loading: loading, storage_error: error, load_storage } = inject("panel");
const preview = ref(null);
const selected = ref(false);
const repairing = ref(false);
const groups = computed(() => ({
  local: t("房间记录与附件"), drafts: t("成员草稿"), launches: t("运行日志与任务文件"),
  "panel-window": t("管理面板窗口缓存"), pi: t("模型 API 运行环境"), other: t("其他"),
}));
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

onMounted(() => { if (!raw.value && !loading.value) load_storage(); });
watch(refreshed, () => load_storage());
</script>

<template>
  <section>
    <h3 class="panel-section-title">
      <UIcon name="i-lucide-hard-drive" />{{ t("共议数据") }}
      <span class="panel-section-action storage-head-actions">
        <button type="button" class="panel-button is-plain is-small" :disabled="loading" @click="load_storage">
          <UIcon name="i-lucide-refresh-cw" :class="{ 'animate-spin': loading }" />{{ t("刷新") }}
        </button>
      </span>
    </h3>

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
        <span>{{ snapshot.block_reason || t("存储占用已超过上限或磁盘剩余空间低于安全线，新的派活已暂停。房间被拦截时请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 清理旧草稿，或清理下方临时文件；房间记录与附件需手动销毁旧房间。") }}</span>
      </p>
      <p v-else-if="snapshot.warning" class="panel-note is-amber storage-banner" role="status">
        <UIcon name="i-lucide-triangle-alert" />
        <span>{{ snapshot.warning_reason || t("本机 .codiscuss 数据已占 {used}，接近 {limit} 上限（预警线 {warn}）。请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup 或清理临时文件。", { used: format_storage_bytes(snapshot.total_bytes), limit: format_storage_bytes(snapshot.limits.home_limit_bytes), warn: format_storage_bytes(snapshot.limits.home_warn_bytes) }) }}</span>
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
                ? t("其中可回收执行临时文件 {size}；单房间上限 {room_limit}。清理历史草稿请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup。", { size: format_storage_bytes(snapshot.scratch_bytes), room_limit: format_storage_bytes(snapshot.limits.room_draft_bytes) })
                : t("单房间草稿上限 {room_limit}；历史草稿和成品不会自动删除，需要清理时请在房间外的 AI 对话中运行 $codiscuss-draft-cleanup。", { room_limit: format_storage_bytes(snapshot.limits.room_draft_bytes) }) }}
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
            <span class="panel-sub">{{ t("保存房间消息、事件与附件原件，计入 10 GiB 数据上限；程序不会自动删除，如需释放空间请先导出备份再销毁旧房间。") }}</span>
          </div>
        </div>
      </div>

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
.storage-bar { height: 5px; width: 100%; max-width: 360px; margin: 2px 0; overflow: hidden; border-radius: 999px; background: var(--panel-tint); }
.storage-bar > i { display: block; height: 100%; border-radius: inherit; background: var(--panel-blue); transition: width .2s ease; }
.storage-bar.is-warning > i { background: var(--panel-amber); }
.storage-bar.is-error > i { background: var(--panel-red); }
.storage-warn-text { color: var(--panel-amber); }
.storage-sub-row { min-height: 54px; padding: 10px 0 10px 54px; }
.storage-sub-title { font-size: 14px; font-weight: 500; }
.storage-members { padding-top: 2px; }
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
