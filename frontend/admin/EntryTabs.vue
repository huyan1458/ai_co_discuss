<script setup>
/**
 * The ways into this computer, two kinds of people by three ways of reaching it (user 2026-11-18, #4764): one tab for the
 * administrator and one for hosted accounts, each with the same three cards, those it does not offer included.
 */
import { inject, ref } from "vue";
import AdminEntries from "./AdminEntries.vue";
import HostingCards from "./HostingCards.vue";
import { t } from '../i18n.js';

const { state } = inject("panel");
const TABS = [{ key: "admin", icon: "i-lucide-shield-check", label: t('管理员入口') }, { key: "hosted", icon: "i-lucide-users", label: t('托管账号入口') }];
const tab = ref("admin");
</script>

<template>
  <div class="entry-head">
    <h3 class="panel-section-title"><UIcon name="i-lucide-door-open" />{{ t('登录入口') }}</h3>
    <div class="entry-tabs" role="tablist" :aria-label="t('登录入口')">
      <button v-for="item in TABS" :key="item.key" type="button" role="tab" class="entry-tab" :class="{ 'is-active': tab === item.key }" :aria-selected="tab === item.key" @click="tab = item.key">
        <UIcon :name="item.icon" />{{ item.label }}</button>
    </div>
  </div>
  <div class="entry-stack">
    <p class="panel-guide entry-guide" :class="{ invisible: tab !== 'admin' }">{{ t('你自己使用这台电脑的入口。') }}</p>
    <p class="panel-guide entry-guide" :class="{ invisible: tab !== 'hosted' }">{{ t('托管账号的使用者打开登录入口，用账号名和密码进入各自的工作台。账号在“账号”页创建和管理。') }}</p>
  </div>
  <div class="entry-stack">
    <div class="entry-pane" :class="{ invisible: tab !== 'admin' }" :inert="tab !== 'admin'">
      <div class="panel-note entry-state invisible" aria-hidden="true"><UIcon name="i-lucide-info" /><div class="entry-status-copy"><span>{{ t('登录入口没有开启自建中转或 Cloudflare 隧道，其他设备打不开') }}</span><span>{{ t('登录入口未运行，使用者暂时无法登录') }}</span><span>{{ t('登录入口已启动') }}</span></div><button type="button" class="panel-button is-small" disabled>{{ t('启动') }}</button></div>
      <AdminEntries />
    </div>
    <div class="entry-pane" :class="{ invisible: tab !== 'hosted' }" :inert="tab !== 'hosted'">
      <HostingCards v-if="state.hosting" />
      <p v-else class="panel-note entry-state"><UIcon name="i-lucide-info" />{{ t('托管管理未打开：运行 codiscuss setup 勾选“托管管理（管理面板）”') }}</p>
    </div>
  </div>
</template>

<style scoped>
.entry-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; margin: 18px 2px 6px 0; }
.entry-head .panel-section-title { margin: 0 2px; }
.entry-tabs { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--panel-tint); }
.entry-tab { display: flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px; border-radius: 8px; color: var(--panel-muted); font-size: 13px; font-weight: 500; white-space: nowrap; transition: background-color .15s, color .15s; }
.entry-tab:hover { color: var(--panel-text); }
.entry-tab.is-active { background: #fff; color: var(--panel-text); box-shadow: 0 1px 3px #0000001a, 0 1px 2px #0000000d; }
.entry-tab > [class*="icon"] { width: 15px; height: 15px; }
.entry-guide { margin: 0 2px 12px; }
.entry-stack { display: grid; }
.entry-stack > * { grid-area: 1 / 1; min-width: 0; }
.entry-status-copy { display: grid; flex: 1; min-width: 0; }
.entry-status-copy > span { grid-area: 1 / 1; }
.entry-state > button { flex-shrink: 0; }
@media (max-width: 640px) {
  .entry-tabs { width: 100%; }
  .entry-tab { flex: 1; padding: 0 6px; }
}
</style>
