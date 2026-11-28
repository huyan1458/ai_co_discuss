<script setup>
/**
 * The usage limits and balances of the accounts this room's members draw on, each account once (rule one of #15754):
 * a room may hold many members of one software, so the limits are not repeated per member. Three levels of detail:
 * the summary list (the room page) gives every window with when it resets; `pill` is the indicator, each account's
 * tightest window (`Claude 5h 44% · Codex 7d 44%`, folded past three as `+2`) under the message box, where dispatch is
 * decided while writing; `alert` is the phone's one line, shown only once an account runs low. Indicators open the
 * summary on press. `account` narrows it all to one account (the private chat).
 */
import { computed, inject } from "vue";
import { t } from "./i18n.js";
import { account_peaks, quota_rows, room_accounts } from "./quota.js";

const SHOWN_ACCOUNTS = 3;
const props = defineProps({ pill: Boolean, alert: Boolean, account: { type: String, default: "" } });
const { view } = inject("discussion");
const accounts = computed(() => room_accounts(view.value).filter((item) => !props.account || item.account === props.account)
  .map((item) => ({ ...item, rows: quota_rows(item.quota) })));
const peaks = computed(() => account_peaks(view.value).filter((item) => !props.account || item.account === props.account));
const low = computed(() => peaks.value.filter((item) => item.level));
const shown = computed(() => (props.alert ? low.value : peaks.value).slice(0, SHOWN_ACCOUNTS));
const folded = computed(() => (props.alert ? low.value : peaks.value).length - shown.value.length);
const label = computed(() => t('账号额度：{value1}', { value1: peaks.value.map((item) => item.text).join("，") }));
</script>

<template>
  <UPopover v-if="(pill && accounts.length) || (alert && low.length)" :content="{ side: 'top', align: alert ? 'start' : 'end', sideOffset: 6 }">
    <button type="button" class="account-quota-pill" :class="{ 'is-alert': alert }" :aria-label="label">
      <UIcon name="i-lucide-gauge" aria-hidden="true" />
      <template v-for="(item, index) in shown" :key="item.account">
        <span v-if="index" class="account-quota-more">·</span>
        <span class="account-quota-item"><i v-if="item.level" class="context-meter-dot" :class="`is-${item.level}`" aria-hidden="true" />{{ item.text }}</span>
      </template>
      <span v-if="folded > 0" class="account-quota-more">+{{ folded }}</span>
    </button>
    <template #content>
      <div class="context-meter-panel account-quota-panel">
        <div class="context-meter-head"><span class="context-meter-muted">{{ t('账号额度') }}</span></div>
        <ul class="account-quotas">
          <li v-for="item in accounts" :key="item.account"><strong>{{ item.name }}</strong>
            <span v-for="row in item.rows" :key="row.key"><i v-if="row.level" class="context-meter-dot" :class="`is-${row.level}`" aria-hidden="true" />{{ `${row.name} ${row.value}` }}<small v-if="row.note">{{ row.note }}</small></span>
          </li>
        </ul>
      </div>
    </template>
  </UPopover>
  <ul v-else-if="!props.pill && accounts.length" class="account-quotas" :aria-label="t('账号额度')">
    <li v-for="item in accounts" :key="item.account"><strong>{{ item.name }}</strong>
      <span v-for="row in item.rows" :key="row.key"><i v-if="row.level" class="context-meter-dot" :class="`is-${row.level}`" aria-hidden="true" />{{ `${row.name} ${row.value}` }}<small v-if="row.note">{{ row.note }}</small></span>
    </li>
  </ul>
</template>

<style>
.account-quotas { display: grid; gap: 4px; margin: 0 0 12px; padding: 0; list-style: none; font-size: 12px; color: var(--ui-text-muted); }
.account-quotas li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; }
.account-quotas strong { min-width: 6em; color: var(--ui-text); font-weight: 500; }
.account-quotas span { display: inline-flex; align-items: center; gap: 4px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.account-quotas small { margin-left: 4px; color: var(--ui-text-dimmed); font-size: 11px; }
/* In the message box's note line: the line's own grey and size, so it reads as part of it, never above it. */
.account-quota-pill { display: inline-flex; flex: none; align-items: center; gap: 4px; margin: 0 -4px; padding: 0 4px; border: 0; border-radius: 5px; background: none; color: inherit; font: inherit; font-variant-numeric: tabular-nums; white-space: nowrap; cursor: pointer; }
.account-quota-pill:hover, .account-quota-pill[aria-expanded="true"] { background: var(--ui-bg-elevated); color: var(--ui-text-muted); }
.account-quota-pill .iconify { width: 12px; height: 12px; opacity: .8; }
.account-quota-more { color: var(--ui-text-dimmed); }
.account-quota-item { display: inline-flex; align-items: center; gap: 4px; }
/* The phone's line above the message box, only while an account runs low. */
.account-quota-pill.is-alert { margin: 0 0 6px; font-size: 12px; color: var(--ui-text-muted); }
.account-quota-panel { width: min(320px, 100vw - 24px); }
.account-quota-panel .account-quotas { margin: 8px 0 0; }
@media (pointer: coarse) { .account-quota-pill { min-height: 32px; } }
</style>
