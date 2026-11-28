<script setup>
/**
 * Account usage limits and balances, each account (and model group) once (rule one of #15754), in one table: account,
 * 5h, 7d; each reading a percentage over a thin bar with when it resets, ∞ where there is no such limit and — where
 * nothing was read (#15866). The owner pins up to PINNED_LINES lines, in order, to stay under the message box (`pill`):
 * one setting for the whole site, so every room and device shows the same. Both windows of each pinned account are shown,
 * the labels once: `5h / 7d　Claude 65% / 33%` (#15913, #15954).
 * Without `pill` the table stands alone (the room page). `account` narrows everything to one account (the private chat).
 */
import { computed, inject } from "vue";
import { t } from "./i18n.js";
import { cell_text, line_age, pinned_lines, PINNED_LINES, quota_lines, reset_time } from "./quota.js";

const props = defineProps({ pill: Boolean, account: { type: String, default: "" } });
const { view, bridge } = inject("discussion");
const lines = computed(() => quota_lines(view.value).filter((line) => !props.account || line.account === props.account));
const pinned = computed(() => props.account ? lines.value : pinned_lines(view.value, lines.value));
const pinned_keys = computed(() => pinned.value.map((line) => line.key));
const others = computed(() => lines.value.filter((line) => !pinned_keys.value.includes(line.key)));
// Pins are the manager's, kept by the site; elsewhere (a share, a guest) the table is read-only.
const can_pin = computed(() => !props.account && Boolean(view.value?.access?.can_manage) && typeof bridge.save_quota_pins === "function");
const short_group = (group) => group.split(/\s+/)[0];
// A model group goes by its family alone (`Gemini`, #15961).
const line_name = (line) => line.group ? short_group(line.group) : line.name;
const line_text = (line) => line.balance ? `${line_name(line)} ${line.balance.amount} ${line.balance.currency}`.trim()
  : `${line_name(line)} 5h ${cell_text(line.five)}，7d ${cell_text(line.seven)}`;
const label = computed(() => t("账号额度：{value1}", { value1: pinned.value.map(line_text).join("，") }));
const level_of = (window) => (window?.used >= 1 ? "error" : window?.used >= 0.8 ? "warn" : "");
const reset_note = (window) => (window?.resets_at ? t("{time} 重置", { time: reset_time(window.resets_at) }) : "");

function toggle_pin(line) {
  const keys = pinned_keys.value;
  if (keys.includes(line.key)) return bridge.save_quota_pins(keys.filter((key) => key !== line.key));
  if (keys.length >= PINNED_LINES) return;
  bridge.save_quota_pins([...keys, line.key]);
}
function move_pin(line, step) {
  const keys = [...pinned_keys.value], from = keys.indexOf(line.key), to = from + step;
  if (from < 0 || to < 0 || to >= keys.length) return;
  [keys[from], keys[to]] = [keys[to], keys[from]];
  bridge.save_quota_pins(keys);
}
</script>

<template>
  <UPopover v-if="pill && lines.length" :content="{ side: 'top', align: 'end', sideOffset: 6 }">
    <button type="button" class="account-quota-pill" :aria-label="label">
      <UIcon name="i-lucide-gauge" aria-hidden="true" />
      <!-- Both windows, fixed (user #15954); their labels once, as a table's header would (#15913): `5h / 7d　Claude 65% / 33%`. -->
      <span v-if="pinned.some((line) => !line.balance)" class="account-quota-legend">5h / 7d</span>
      <span v-for="line in pinned" :key="line.key" class="account-quota-item">
        <span class="account-quota-name">{{ line_name(line) }}</span>
        <template v-if="line.balance">{{ `${line.balance.amount} ${line.balance.currency}`.trim() }}</template>
        <template v-else>
          <span><b :class="level_of(line.five) && `is-${level_of(line.five)}`">{{ cell_text(line.five) }}</b> / <b :class="level_of(line.seven) && `is-${level_of(line.seven)}`">{{ cell_text(line.seven) }}</b></span>
        </template>
      </span>
    </button>
    <template #content>
      <div class="account-quota-panel">
        <div class="account-quota-panel-head">
          <span>{{ t("账号额度") }}</span>
          <small v-if="can_pin">{{ t("点图钉常驻到输入框下方，最多 {value1} 个", { value1: PINNED_LINES }) }}</small>
        </div>
        <table class="account-quota-table">
          <thead><tr><th v-if="can_pin" /><th>{{ t("账号") }}</th><th>5h</th><th>7d</th></tr></thead>
          <tbody v-for="(section, index) in [pinned, others]" :key="index" :class="{ 'is-others': index === 1 }">
            <tr v-for="(line, position) in section" :key="line.key">
              <td v-if="can_pin" class="account-quota-pin">
                <button type="button" :class="{ 'is-on': index === 0 }" :disabled="index === 1 && pinned.length >= PINNED_LINES"
                  :title="index === 0 ? t('取消常驻') : pinned.length >= PINNED_LINES ? t('最多常驻 {value1} 个，先取消一个', { value1: PINNED_LINES }) : t('常驻到输入框下方')"
                  :aria-pressed="index === 0" @click="toggle_pin(line)"><UIcon name="i-lucide-pin" /></button>
                <span v-if="index === 0" class="account-quota-order">
                  <button type="button" :disabled="position === 0" :aria-label="t('上移')" @click="move_pin(line, -1)"><UIcon name="i-lucide-chevron-up" /></button>
                  <button type="button" :disabled="position === section.length - 1" :aria-label="t('下移')" @click="move_pin(line, 1)"><UIcon name="i-lucide-chevron-down" /></button>
                </span>
              </td>
              <th scope="row"><span>{{ line.name }}</span><small v-if="line.group">{{ line.group }}</small><small v-if="line_age(line)">{{ line_age(line) }}</small></th>
              <td v-if="line.balance" colspan="2" class="account-quota-balance">{{ t("余额 {amount} {currency}", { amount: line.balance.amount, currency: line.balance.currency }) }}</td>
              <template v-else>
                <td v-for="window in [line.five, line.seven]" :key="window === line.five ? 'five' : 'seven'">
                  <strong :class="level_of(window) && `is-${level_of(window)}`">{{ cell_text(window) }}</strong>
                  <span v-if="Number.isFinite(window?.used)" class="account-quota-bar"><i :class="level_of(window) && `is-${level_of(window)}`" :style="{ width: `${Math.min(window.used, 1) * 100}%` }" /></span>
                  <small v-if="reset_note(window)">{{ reset_note(window) }}</small>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </UPopover>
  <table v-else-if="!pill && lines.length" class="account-quota-table is-standalone" :aria-label="t('账号额度')">
    <thead><tr><th>{{ t("账号") }}</th><th>5h</th><th>7d</th></tr></thead>
    <tbody>
      <tr v-for="line in lines" :key="line.key">
        <th scope="row"><span>{{ line.name }}</span><small v-if="line.group">{{ line.group }}</small><small v-if="line_age(line)">{{ line_age(line) }}</small></th>
        <td v-if="line.balance" colspan="2" class="account-quota-balance">{{ t("余额 {amount} {currency}", { amount: line.balance.amount, currency: line.balance.currency }) }}</td>
        <template v-else>
          <td v-for="window in [line.five, line.seven]" :key="window === line.five ? 'five' : 'seven'">
            <strong :class="level_of(window) && `is-${level_of(window)}`">{{ cell_text(window) }}</strong>
            <span v-if="Number.isFinite(window?.used)" class="account-quota-bar"><i :class="level_of(window) && `is-${level_of(window)}`" :style="{ width: `${Math.min(window.used, 1) * 100}%` }" /></span>
            <small v-if="reset_note(window)">{{ reset_note(window) }}</small>
          </td>
        </template>
      </tr>
    </tbody>
  </table>
</template>

<style>
/* The line under the message box: the line's own grey and size, so it reads as part of it, never above it. */
.account-quota-pill { display: inline-flex; flex: none; align-items: center; gap: 12px; margin: 0 -4px; padding: 0 4px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.account-quota-pill:hover, .account-quota-pill[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.account-quota-pill > .iconify { width: 12px; height: 12px; margin-right: -6px; opacity: .8; }
.account-quota-item { display: inline-flex; align-items: baseline; gap: 5px; }
.account-quota-name { color: var(--ui-text-muted); }
.account-quota-legend { color: var(--ui-text-dimmed); }
.account-quota-pill b { font-weight: 400; }
.account-quota-pill b.is-warn, .account-quota-table .is-warn { color: var(--ui-warning); }
.account-quota-pill b.is-error, .account-quota-table .is-error { color: var(--ui-error); }
@media (pointer: coarse) { .account-quota-pill { min-height: 32px; } }
/* The panel: one table, the header naming each window once, every account and group in a row (#15866). */
.account-quota-panel { width: min(420px, 100vw - 24px); padding: 12px; font-size: 12px; line-height: 18px; color: var(--ui-text-muted); }
.account-quota-panel-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; margin-bottom: 8px; }
.account-quota-panel-head span { color: var(--ui-text-highlighted); font-weight: 500; }
.account-quota-panel-head small { color: var(--ui-text-dimmed); font-size: 11px; }
.account-quota-table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.account-quota-table.is-standalone { max-width: 560px; margin: 0 0 12px; color: var(--ui-text-muted); }
.account-quota-table thead th { padding: 0 8px 6px 0; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 500; text-align: left; }
.account-quota-table tbody tr > * { padding: 6px 8px 6px 0; border-top: 1px solid var(--ui-border); vertical-align: top; }
.account-quota-table tbody.is-others tr:first-child > * { border-top-width: 2px; }
.account-quota-table tbody th { font-weight: 500; text-align: left; color: var(--ui-text); }
.account-quota-table th small, .account-quota-table td small { display: block; color: var(--ui-text-dimmed); font-size: 11px; font-weight: 400; line-height: 16px; }
.account-quota-table td { width: 30%; }
.account-quota-table td strong { font-weight: 500; color: var(--ui-text-highlighted); }
.account-quota-bar { display: block; height: 3px; margin: 3px 0 2px; overflow: hidden; border-radius: 2px; background: var(--ui-border); }
.account-quota-bar i { display: block; height: 100%; border-radius: 2px; background: var(--ui-text-dimmed); }
.account-quota-bar i.is-warn { background: var(--ui-warning); }
.account-quota-bar i.is-error { background: var(--ui-error); }
.account-quota-table .account-quota-pin { width: 1%; white-space: nowrap; }
.account-quota-pin button { display: inline-grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 5px; background: none; color: var(--ui-text-dimmed); cursor: pointer; }
.account-quota-pin button:hover:not(:disabled) { background: var(--ui-bg-elevated); color: var(--ui-text-highlighted); }
.account-quota-pin button.is-on { color: var(--ui-primary); }
.account-quota-pin button:disabled { cursor: not-allowed; opacity: .35; }
.account-quota-pin .iconify { width: 13px; height: 13px; }
.account-quota-order { display: inline-flex; }
.account-quota-order button { width: 18px; }
</style>
