<script setup>
import { computed, inject, ref, watch } from "vue";
import { SHARE_DAYS, SHARE_DEFAULT_DAYS, SHARE_SITE_FILES_MAX_BYTES } from "../runner/share_shared.mjs";
import { locale, t } from "./i18n.js";
import { draw_share_card, encode_cover, share_card_blob, share_card_diagnostic } from "./share-card.js";
import { file_preview } from "./file-preview.js";

const { view, bridge, act } = inject("discussion");
// The share page read and cleaned, waiting for the owner to confirm; what looks sensitive in it is listed first.
const SHARE_SPOTS_SHOWN = 6;
const share_draft = computed(() => view.value.share_draft);
// The title stays while the dialog fades out after the draft is gone.
const share_title = ref("");
watch(() => share_draft.value?.title, (title) => { if (title) share_title.value = title; });
const share_spots = computed(() => share_draft.value?.spots || []);
const share_phase = computed(() => share_draft.value?.phase || "");
const share_expiry = computed(() => share_draft.value?.link ? new Date(share_draft.value.link.expires_at).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "");
// The share card of a published link, drawn once the dialog shows it.
const card_canvas = ref(null);
// The two texts on the card are the owner's to adjust before the picture is saved or copied.
const card = computed(() => share_draft.value?.link?.card);
const upload_input = ref(null);
const crop_image = ref(null);
const crop_offset = ref(0.5);
const cover_preview = ref(null);
const drawn = ref(false);
const preview_render = ref(null);
let image_choice = 0;
watch(() => share_draft.value?.link?.url, () => { image_choice++; crop_image.value = null; });
/** Decode a selected or stored raster image before painting it. */
async function load_image(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}
watch(() => card.value?.cover, async (url, _, cleanup) => {
  let current = true;
  cleanup(() => { current = false; });
  cover_preview.value = null;
  if (!url) return;
  try {
    const image = await load_image(url);
    if (current) cover_preview.value = { url, image };
  } catch {
    if (current) {
      cover_preview.value = { url, failed: true };
      bridge.notify("error", t("图片读取失败"));
    }
  }
}, { immediate: true });
watch([card, card_canvas, cover_preview, share_expiry], ([value, canvas, cover]) => {
  drawn.value = false;
  preview_render.value = value ? { stage: "waiting-canvas" } : null;
  if (!canvas || !value) return;
  const decoded = value.cover && cover?.url === value.cover ? cover : null;
  if (value.cover && !decoded?.image) {
    preview_render.value = { stage: decoded?.failed ? "decode-failed" : "decoding-cover" };
    return;
  }
  try {
    draw_share_card(canvas, { ...value, url: share_draft.value.link.url,
      expires: t("{time} 前有效", { time: share_expiry.value }) }, decoded?.image);
    drawn.value = true;
    preview_render.value = { stage: "drawn", rendered: decoded ? "custom" : "default", width: canvas.width, height: canvas.height };
  } catch {
    preview_render.value = { stage: "draw-failed" };
  }
}, { deep: true, flush: "post" });
function copy_diagnostic() {
  const summary = share_card_diagnostic(share_draft.value, preview_render.value);
  return act("copy", JSON.stringify(summary, null, 2));
}
function edit_card(field, value) {
  const draft = share_draft.value;
  return act("edit_share_card", { room_id: draft.room_id, share_id: draft.link.share_id, field, value });
}
async function select_cover(file, attachment = false) {
  if (!file) return;
  const choice = ++image_choice;
  crop_image.value = null;
  let local_url;
  try {
    if (!attachment && !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error(t("请选择 PNG、JPG 或 WebP 图片"));
    const url = attachment ? await bridge.attachment_url(file) : (local_url = URL.createObjectURL(file));
    const image = await load_image(url);
    if (choice !== image_choice) return;
    if (image.height > image.width * 2) { crop_offset.value = 0.5; crop_image.value = image; }
    else await edit_card("cover", encode_cover(image));
  } catch (error) { if (choice === image_choice) bridge.notify("error", error.message || t("图片读取失败")); }
  finally { if (local_url) URL.revokeObjectURL(local_url); }
}
const cropped_cover = computed(() => crop_image.value ? encode_cover(crop_image.value, crop_offset.value) : "");
function auto_cover() { image_choice++; crop_image.value = null; edit_card("cover", ""); }
/** Save the card as a PNG named after the room. */
async function save_card() {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(await share_card_blob(card_canvas.value));
  link.download = `${share_title.value.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "share"}.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}
// A copy button says it worked for a moment.
const COPIED_MS = 2000;
// Pictures reach the clipboard only where the browser offers it (not Firefox, not a plain-http address); elsewhere the button is left out.
const can_copy_image = typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard?.write);
const card_copied = ref(false);
/** Put the card on the clipboard as an image, for pasting straight into a chat. */
async function copy_card() {
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": share_card_blob(card_canvas.value) })]);
    card_copied.value = true;
    setTimeout(() => { card_copied.value = false; }, COPIED_MS);
  } catch { bridge.notify("warning", t("这个浏览器不能复制图片，请用“保存图片”。")); }
}
const copied_link = ref(false);
// Publishing already put the link on the clipboard, so the button opens saying so.
const link_copied = computed(() => copied_link.value || Boolean(share_draft.value?.link?.copied && !link_seen.value));
const link_seen = ref(false);
watch(() => share_draft.value?.link?.url, (url) => { link_seen.value = false; if (url) setTimeout(() => { link_seen.value = true; }, COPIED_MS * 2); });
async function copy_share_link() {
  await act("copy", share_draft.value.link.url);
  copied_link.value = true;
  setTimeout(() => { copied_link.value = false; }, COPIED_MS);
}
// Attachment kinds unfolded to their files in the share dialog; a new page starts folded.
const open_kinds = ref(new Set());
const filters_open = ref(false);
watch(() => share_draft.value?.room_id, () => { open_kinds.value = new Set(); });
watch(() => share_draft.value?.files.included, included => {
  filters_open.value = Boolean(included && share_draft.value.files.bytes > SHARE_SITE_FILES_MAX_BYTES);
});
function preview(file) {
  if (file.project) file_preview.open?.(file.project.path, "", file.project.root, file);
  else act("preview_attachment", { ...file, from_share: true });
}
function toggle_kind_open(kind) {
  const next = new Set(open_kinds.value);
  next.has(kind) ? next.delete(kind) : next.add(kind);
  open_kinds.value = next;
}
const share_spot_total = computed(() => share_spots.value.reduce((total, spot) => total + spot.count, 0));
// How long a published link lives; the share site keeps it at most seven days.
const share_days = ref(SHARE_DEFAULT_DAYS);
watch(() => share_draft.value?.days, days => { if (days) share_days.value = days; });
const share_day_items = computed(() => (view.value.share_days || SHARE_DAYS).map((days) => ({ label: t("{count} 天后过期", { count: days }), value: days })));
/** Closing the dialog without choosing drops the prepared page. */
function close_share(open) {
  if (!open && share_draft.value) bridge.execute("share_cancel");
}
</script>

<template>
    <UModal :open="Boolean(share_draft)" :title="share_phase === 'published' ? t('分享链接已发布') : t('分享「{name}」', { name: share_title })"
      :description="share_phase === 'published' ? share_title : t('生成只读网页，没装共议的人也能打开看。')"
      :content="{ onInteractOutside: (event) => event.preventDefault() }" :ui="{ content: `glass-panel studio-modal channel-folder-modal channel-manage-modal share-dialog${share_phase === 'published' ? ' share-dialog-wide' : ''}`, body: 'dialog-body' }" @update:open="close_share">
      <template v-if="share_phase === 'published'" #title><span class="share-done-title"><UIcon name="i-lucide-circle-check" />{{ t('分享链接已发布') }}</span></template>
      <template #body>
        <div v-if="share_phase === 'preparing'" class="share-dialog-loading" role="status"><UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ t("正在整理房间：读取消息与执行记录，去掉本机信息…") }}</div>
        <div v-else-if="share_phase === 'publishing' || share_phase === 'downloading'" class="share-dialog-loading" role="status">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" />
          {{ share_phase === 'downloading' ? t('正在生成网页文件…') : share_draft.upload ? t('正在上传附件 {done}/{total}', share_draft.upload) : t('正在上传…') }}
        </div>
        <template v-else-if="share_phase === 'published'">
          <!-- The link first: it is what was asked for, and it is already on the clipboard. -->
          <div class="share-done-link">
            <UIcon name="i-lucide-link-2" class="share-done-link-icon" />
            <input :value="share_draft.link.url.replace(/^https?:\/\//, '')" readonly class="share-done-url" :aria-label="t('分享链接')" @focus="$event.target.select()">
            <UTooltip :text="t('打开分享页')"><UButton icon="i-lucide-external-link" color="neutral" variant="ghost" size="sm" :aria-label="t('打开分享页')" :to="share_draft.link.url" target="_blank" rel="noopener noreferrer" /></UTooltip>
            <UButton :label="link_copied ? t('已复制') : t('复制链接')" :icon="link_copied ? 'i-lucide-check' : 'i-lucide-copy'" color="primary" size="sm" class="share-done-copy" @click="copy_share_link" />
          </div>
          <p class="share-done-meta"><UIcon name="i-lucide-clock" />{{ share_draft.link.updated ? t("已更新原链接的内容，{time} 前有效。", { time: share_expiry }) : t("{time} 前有效，到期自动删除。", { time: share_expiry }) }}</p>
          <div class="share-done-card">
            <figure class="share-done-stage"><canvas ref="card_canvas" :style="{ visibility: drawn ? 'visible' : 'hidden' }" :aria-label="t('分享卡：{name}', { name: share_title })"></canvas></figure>
            <div class="share-done-side">
              <h3>{{ t('分享卡') }}</h3>
              <div class="share-cover-controls">
                <UButton :label="t('自动封面')" :variant="card?.cover ? 'outline' : 'soft'" @click="auto_cover" />
                <UButton :label="t('上传封面')" color="neutral" variant="outline" @click="upload_input.click()" />
                <input ref="upload_input" type="file" hidden accept="image/png,image/jpeg,image/webp" @change="select_cover($event.target.files[0]); $event.target.value = ''">
                <USelect v-if="share_draft.cover_images?.length" :model-value="null" :placeholder="t('选择房间图片')" :aria-label="t('选择房间图片')"
                  :items="share_draft.cover_images.map(file => ({ label: '#' + file.message_id + ' · ' + file.file_name, value: file.id }))"
                  @update:model-value="id => select_cover(share_draft.cover_images.find(file => file.id === id), true)" />
              </div>
              <div v-if="crop_image" class="share-cover-crop">
                <img :src="cropped_cover" :alt="t('裁剪预览')">
                <label>{{ t('选择保留的画面') }}<input v-model.number="crop_offset" type="range" min="0" max="1" step="0.01"></label>
                <UButton :label="t('使用此封面')" @click="edit_card('cover', cropped_cover); crop_image = null" />
              </div>
              <label v-if="!card?.cover" class="share-dialog-field"><span>{{ t('卡片上的问题') }}</span>
                <UTextarea :model-value="card?.question" :maxlength="2000" @update:model-value="edit_card('question', $event)" :rows="2" autoresize :maxrows="4" variant="soft" :placeholder="t('可留空')" :aria-label="t('分享卡上的问题')" /></label>
              <label v-if="!card?.cover" class="share-dialog-field"><span>{{ t('卡片上的成果') }}</span>
                <UTextarea :model-value="card?.outcome" :maxlength="2000" @update:model-value="edit_card('outcome', $event)" :rows="3" autoresize :maxrows="5" variant="soft" :placeholder="t('可留空')" :aria-label="t('分享卡上的成果')" /></label>
              <div class="share-done-card-actions">
                <UButton :disabled="!drawn" :label="t('保存图片')" icon="i-lucide-image-down" color="neutral" variant="subtle" @click="save_card" />
                <UButton v-if="can_copy_image" :disabled="!drawn" :label="card_copied ? t('已复制') : t('复制图片')" :icon="card_copied ? 'i-lucide-check' : 'i-lucide-clipboard-copy'" color="neutral" variant="subtle" @click="copy_card" />
              </div>
            </div>
          </div>
          <div class="share-done-foot">
            <p>{{ t("之后在左侧“已分享”里可以复制、续期或撤销，已配对的手机和平板也能操作。") }}</p>
            <UButton :label="t('完成')" color="neutral" variant="outline" @click="close_share(false)" />
          </div>
        </template>
        <template v-else-if="share_draft">
        <section class="share-dialog-section">
          <h3>{{ t("分享的内容") }}</h3>
          <p>{{ t("消息、卡片、执行时间线与过程说明，停在此刻；读者只能看，不能操作。") }}</p>
          <p class="share-dialog-muted">{{ t("不含私聊、事件记录、调度决策、排队消息、会话与凭据；本机用户目录写作 ~，项目目录写成相对路径，失败原因只写“执行失败”。") }}</p>
        </section>
        <!-- Attachments go in only when the owner ticks this (user 2026-11-21): every kind of file, as it was sent. -->
        <section v-if="share_draft.files?.count" class="share-dialog-section">
          <div class="share-dialog-kind-head"><UCheckbox :model-value="share_draft.files.included" :disabled="share_phase !== 'ready'"
            :label="share_draft.files.included && share_draft.files.carried_count < share_draft.files.count
              ? t('包含附件（已选 {selected}/{count} 个，共 {size}）', { selected: share_draft.files.carried_count, count: share_draft.files.count, size: bridge.attachment_size(share_draft.files.carried) })
              : t('包含附件（{count} 个，共 {size}）', { count: share_draft.files.count, size: bridge.attachment_size(share_draft.files.bytes) })" @update:model-value="act('share_include_files', $event)" />
            <UButton v-if="share_draft.files.included" :icon="filters_open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              :label="filters_open ? t('收起') : t('筛选附件')" :aria-expanded="filters_open" size="xs" color="neutral" variant="ghost" @click="filters_open = !filters_open" />
          </div>
          <!-- Kinds of attachment the owner can leave out, as when a room's zips take it past what a link carries. -->
          <div v-if="share_draft.files.included && filters_open" class="share-dialog-kinds">
            <div v-for="kind in share_draft.files.kinds" :key="kind.kind" class="share-dialog-kind">
              <div class="share-dialog-kind-head">
                <UCheckbox :model-value="kind.included" :disabled="share_phase !== 'ready'"
                  :label="kind.selected_count < kind.count
                    ? t('{kind} {selected}/{count} 个 · {size}', { kind: kind.label, selected: kind.selected_count, count: kind.count, size: bridge.attachment_size(kind.selected_bytes) })
                    : t('{kind} {count} 个 · {size}', { kind: kind.label, count: kind.count, size: bridge.attachment_size(kind.bytes) })"
                  @update:model-value="act('share_toggle_kind', { kind: kind.kind, include: $event === true })" />
                <UButton :icon="open_kinds.has(kind.kind) ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" color="neutral" variant="ghost" size="xs"
                  :label="open_kinds.has(kind.kind) ? t('收起') : t('逐个选择')" :aria-expanded="open_kinds.has(kind.kind)" @click="toggle_kind_open(kind.kind)" />
              </div>
              <ul v-if="open_kinds.has(kind.kind)" class="share-dialog-files">
                <li v-for="file in kind.files" :key="file.route">
                  <UCheckbox :aria-label="file.name" :model-value="file.included" :disabled="share_phase !== 'ready'"
                    @update:model-value="act('share_toggle_file', { route: file.route, include: $event === true })" />
                  <div class="share-dialog-file-info">
                    <button type="button" class="share-dialog-file-name" @click="preview(file)">{{ file.name }}</button>
                    <div class="share-dialog-file-meta"><span>#{{ file.message_id }}</span><span>{{ file.author }}</span>
                      <time v-if="file.created_at">{{ bridge.format_time(file.created_at) }}</time><span>{{ bridge.attachment_size(file.size) }}</span>
                      <button type="button" @click="preview(file)">{{ t('预览') }}</button>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>
            <p v-if="share_draft.files.included" class="share-dialog-muted">{{ t("已选 {size}；发布链接最多带 300 MB 附件（单个 100 MB），网页文件最多 100 MB。", { size: bridge.attachment_size(share_draft.files.carried) }) }}</p>
          <p v-if="share_draft.files.included && share_draft.files.site_left_out.length" class="share-dialog-muted">{{ t("{names} 不能放到分享站：发布链接时不带，消息里显示“未包含在分享中”；下载网页文件仍会带上。", { names: share_draft.files.site_left_out.slice(0, 3).join("、") + (share_draft.files.site_left_out.length > 3 ? t(" 等 {count} 个", { count: share_draft.files.site_left_out.length }) : "") }) }}</p>
          <p v-if="share_phase === 'checking'" class="share-dialog-muted">{{ t("正在检查文本类附件…") }}</p>
          <p v-else class="share-dialog-muted">{{ share_draft.files.included ? t("附件原样公开。文本类附件已一并检查；图片、视频和其他文件的内容程序查不了，请自己核对。") : t("不包含时，消息里的附件标记显示为“未包含在分享中”。") }}</p>
        </section>
        <section class="share-dialog-section">
          <h3>{{ share_spots.length ? t("发出前请核对（{count} 处）", { count: share_spot_total }) : t("发出前请核对") }}</h3>
          <p v-if="!share_spots.length" class="share-dialog-clear"><UIcon name="i-lucide-circle-check" />{{ t("没有找到疑似密钥、令牌或联系方式。正文会原样公开，程序查不全，仍请自己看一遍。") }}</p>
          <template v-else>
            <p class="share-dialog-muted">{{ t("疑似密钥、令牌、邮箱或手机号，正文会原样公开：") }}</p>
            <ul class="share-dialog-spots">
              <li v-for="spot in share_spots.slice(0, SHARE_SPOTS_SHOWN)" :key="spot.where"><b>{{ spot.where }}</b><span v-if="spot.count > 1" class="share-dialog-count">{{ t("{count} 处", { count: spot.count }) }}</span><code>{{ spot.text }}</code></li>
            </ul>
            <p v-if="share_spots.length > SHARE_SPOTS_SHOWN" class="share-dialog-muted">{{ t("另有 {count} 个位置，请在生成的网页里查找。", { count: share_spots.length - SHARE_SPOTS_SHOWN }) }}</p>
          </template>
        </section>
        <div class="share-dialog-choices">
          <div class="share-dialog-choice">
            <UButton :label="t('下载网页文件')" icon="i-lucide-download" color="neutral" variant="outline" block :loading="share_phase === 'downloading'" :disabled="share_phase !== 'ready'" @click="act('share_room')" />
            <p>{{ t("得到一个 .html 文件，发出后无法过期或撤回。") }}</p>
          </div>
          <div class="share-dialog-choice">
            <div class="share-dialog-publish">
              <USelect v-model="share_days" @update:model-value="act('share_select_days', $event)" :items="share_day_items" class="share-dialog-days" :disabled="share_phase !== 'ready'" :aria-label="t('分享链接的有效期')" />
              <UButton :label="share_phase === 'publishing' ? (share_draft?.upload ? t('正在上传附件 {done}/{total}', share_draft.upload) : t('正在上传…')) : share_draft?.linked ? t('更新链接') : t('发布链接')" icon="i-lucide-link-2" color="primary" class="share-dialog-publish-button"
                :loading="share_phase === 'publishing'" :disabled="share_phase !== 'ready'" @click="act('share_publish', share_days)" />
            </div>
            <p>{{ t("上传到 AI CoDiscuss 分享站，运营方与审核 AI 能读到全文；到期自动删除，可随时撤销，撤销后缓存副本留到原定到期时才清除。") }}</p>
          </div>
        </div>
        </template>
        <UButton v-if="share_draft" :label="t('复制分享卡诊断')" icon="i-lucide-copy" color="neutral" variant="ghost" size="xs" @click="copy_diagnostic" />
      </template>
    </UModal>
</template>

<style scoped>
.share-dialog-loading { display: flex; align-items: center; gap: 8px; padding: 20px 0 28px; color: var(--ui-text-toned); font-size: 13px; }
/* Published. The link is one field with its two actions inside it; below, the card on a stage with its texts beside it. */
.share-done-title { display: inline-flex; align-items: center; gap: 8px; }
.share-done-title .iconify { width: 18px; height: 18px; color: var(--ui-success); }
.share-done-link { display: flex; align-items: center; gap: 4px; padding: 5px 5px 5px 12px; border: 1px solid var(--ui-border-accented); border-radius: 11px; background: var(--ui-bg); transition: border-color .15s, box-shadow .15s; }
.share-done-link:focus-within { border-color: var(--channel-accent, var(--ui-primary)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 18%, transparent); }
.share-done-link-icon { flex-shrink: 0; width: 16px; height: 16px; color: var(--ui-text-muted); }
.share-done-url { flex: 1; min-width: 0; height: 30px; padding: 0 6px; border: 0; outline: 0; background: none; color: var(--ui-text-highlighted); font: 13px/30px ui-monospace, "SF Mono", "Cascadia Mono", Consolas, monospace; text-overflow: ellipsis; }
.share-done-copy { flex-shrink: 0; min-width: 92px; justify-content: center; }
.share-done-meta { display: flex; align-items: center; gap: 6px; margin: 8px 2px 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-done-meta .iconify { flex-shrink: 0; width: 13px; height: 13px; }
.share-done-card { display: grid; grid-template-columns: 264px minmax(0, 1fr); gap: 20px; align-items: stretch; margin-top: 18px; }
.share-done-stage { display: flex; align-items: center; justify-content: center; margin: 0; padding: 18px; border: 1px solid var(--ui-border-muted); border-radius: 14px;
  background: radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--channel-accent, var(--ui-primary)) 14%, transparent), transparent 70%), color-mix(in srgb, var(--ui-text) 3%, transparent); }
.share-done-stage canvas { display: block; width: 100%; max-width: 228px; height: auto; border-radius: 10px; box-shadow: 0 1px 0 #ffffff14 inset, 0 14px 32px -10px #000000b3, 0 2px 6px #0000004d; }
.share-done-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.share-done-side h3 { margin: 0; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.share-dialog-field { display: grid; gap: 5px; }
.share-cover-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.share-cover-controls > * { max-width: 100%; }
.share-cover-crop { display: grid; justify-items: start; gap: 6px; }
.share-cover-crop img { max-height: 160px; }
.share-dialog-field > span { color: var(--ui-text-muted); font-size: 12px; }
.share-dialog-field :deep(textarea) { font-size: 13px; line-height: 1.6; }
.share-done-card-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
.share-done-foot { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.share-done-foot p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-done-foot button { flex-shrink: 0; }
@media (max-width: 640px) {
  .share-done-card { grid-template-columns: 1fr; }
  .share-done-stage canvas { max-width: 240px; }
  .share-done-copy { min-width: 0; }
}
.share-dialog-section { display: grid; gap: 4px; margin-bottom: 16px; font-size: 13px; line-height: 1.6; color: var(--ui-text-toned); }
.share-dialog-section h3 { margin: 0 0 2px; font-size: 13px; font-weight: 600; color: var(--ui-text-highlighted); }
.share-dialog-section p { margin: 0; }
.share-dialog-muted { color: var(--ui-text-muted); font-size: 12px; }
.share-dialog-clear { display: flex; align-items: flex-start; gap: 6px; }
.share-dialog-clear .iconify { flex-shrink: 0; margin-top: 3px; color: var(--ui-success); }
.share-dialog-spots { display: grid; gap: 4px; max-height: 180px; overflow-y: auto; margin: 2px 0 0; padding: 0; list-style: none; }
.share-dialog-spots li { display: grid; grid-template-columns: auto auto minmax(0, 1fr); align-items: baseline; gap: 6px; padding: 4px 8px; border-radius: 6px; background: var(--ui-bg-elevated); font-size: 12px; }
.share-dialog-spots b { font-weight: 600; color: var(--ui-text-highlighted); white-space: nowrap; }
.share-dialog-count { color: var(--ui-text-muted); white-space: nowrap; }
.share-dialog-spots code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-toned); }
.share-dialog-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding-top: 14px; border-top: 1px solid var(--ui-border-muted); }
.share-dialog-choice { display: grid; align-content: start; gap: 6px; }
.share-dialog-choice p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.5; }
.share-dialog-publish { display: flex; gap: 6px; }
.share-dialog-days { width: 118px; flex-shrink: 0; }
.share-dialog-publish-button { flex: 1; justify-content: center; }
@media (max-width: 560px) { .share-dialog-choices { grid-template-columns: 1fr; } }
</style>
