<script setup>
/**
 * Accounts, one at a time: a column listing the owner ("管理员") and, with hosting on, every hosted account and "新建账号";
 * beside it everything about the chosen one (its sign-ins, API keys, skills, and for a hosted account its site,
 * isolation and protection), or the creation wizard.
 */
import { computed, inject, ref } from "vue";
import AccountDetail from "./AccountDetail.vue";
import NewAccount from "./NewAccount.vue";
import OwnerDetail from "./OwnerDetail.vue";

const OWNER = "", NEW = "\u0000new";
const { state } = inject("panel");
const chosen = ref(OWNER);
// An account operation picked from the list's "⋯": the detail page of that account carries it out (with its confirmation).
const request = ref(null);
// A removed account falls back to the owner.
const current = computed(() => (chosen.value === NEW || state.value.accounts.some((item) => item.name === chosen.value) ? chosen.value : OWNER));

/** The list's "⋯" for one account: open that account and hand the operation to its detail page. */
function menu(account) {
  const pick = (action) => () => { chosen.value = account.name; request.value = { action, at: Date.now() }; };
  return [[account.disabled ? { label: "启用账号", icon: "i-lucide-user-check", onSelect: pick("enable") }
    : { label: "停用账号", icon: "i-lucide-user-x", onSelect: pick("disable") }],
  [{ label: "删除账号", icon: "i-lucide-trash-2", color: "error", onSelect: pick("remove") }]];
}

/** What an account still lacks, in the order to fix it. */
function todo(account) {
  if (!account.os_user) return "未隔离";
  if (!account.skills) return "AI 环境未初始化";
  return "";
}
</script>

<template>
  <div class="accounts">
    <nav class="accounts-side" aria-label="账号">
      <button type="button" class="accounts-item" :class="{ 'is-active': current === OWNER }" @click="chosen = OWNER">
        <span class="accounts-avatar is-owner"><UIcon name="i-lucide-user-cog" /></span>
        <span class="accounts-text"><strong>管理员</strong><small>本机账号</small></span>
      </button>
      <template v-if="state.hosting">
        <div class="accounts-group">托管账号</div>
        <div v-for="account in state.accounts" :key="account.name" class="accounts-row">
          <button type="button" class="accounts-item" :class="{ 'is-active': current === account.name }" @click="chosen = account.name">
            <span class="accounts-avatar">{{ account.name.slice(0, 1).toUpperCase() }}<i :class="account.running ? 'is-on' : 'is-off'" :title="account.running ? '运行中' : '已停止'" /></span>
            <span class="accounts-text"><strong>{{ account.name }}</strong>
              <small :class="{ 'is-warn': todo(account) || account.disabled }">{{ account.disabled ? "已停用" : todo(account) ? `待处理：${todo(account)}` : "已隔离" }}</small></span>
          </button>
          <UDropdownMenu :items="menu(account)" :content="{ align: 'start', side: 'right' }">
            <button type="button" class="accounts-more" title="更多操作" aria-label="更多操作"><UIcon name="i-lucide-ellipsis" /></button>
          </UDropdownMenu>
        </div>
        <p v-if="!state.accounts.length" class="accounts-empty">暂无托管账号。创建后，对方可通过登录入口使用本机的 AI。</p>
        <button type="button" class="accounts-item is-new" :class="{ 'is-active': current === NEW }" @click="chosen = NEW">
          <span class="accounts-avatar"><UIcon name="i-lucide-plus" /></span><span class="accounts-text"><strong>新建账号</strong></span>
        </button>
      </template>
    </nav>

    <div class="accounts-main">
      <NewAccount v-if="current === NEW" @cancel="chosen = OWNER" @done="(name) => (chosen = name)" />
      <AccountDetail v-else-if="current" :key="current" :name="current" :request="request" @handled="request = null" @owner="chosen = OWNER" />
      <OwnerDetail v-else />
    </div>
  </div>
</template>

<style scoped>
.accounts { display: flex; align-items: flex-start; gap: 22px; }
.accounts-side { position: sticky; top: 110px; display: flex; flex-shrink: 0; flex-direction: column; gap: 4px; width: 210px; }
.accounts-group { margin: 14px 10px 4px; color: var(--panel-faint); font-size: 12px; }
.accounts-item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px; border-radius: 12px; text-align: left; transition: background-color .15s; }
.accounts-item:hover { background: var(--panel-tint); }
.accounts-item.is-active { background: var(--panel-blue-soft); }
.accounts-item.is-active strong { color: var(--panel-blue); }
.accounts-avatar { position: relative; display: grid; flex-shrink: 0; place-items: center; width: 34px; height: 34px; border: 1px solid var(--panel-line); border-radius: 10px; background: #fafafa;
  color: #374151; font-size: 15px; font-weight: 600; }
.accounts-avatar > [class*="icon"] { width: 17px; height: 17px; }
.accounts-avatar.is-owner { border-color: #bfdbfe; background: var(--panel-blue-soft); color: var(--panel-blue); }
.accounts-avatar i { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border: 2px solid #fff; border-radius: 50%; }
.accounts-avatar i.is-on { background: var(--panel-green); }
.accounts-avatar i.is-off { background: #d1d5db; }
.accounts-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.accounts-text strong { overflow: hidden; font-size: 14px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; }
.accounts-text small { overflow: hidden; color: var(--panel-faint); font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
.accounts-text small.is-warn { color: var(--panel-amber); }
.accounts-row { position: relative; }
.accounts-row .accounts-item { padding-right: 36px; }
.accounts-more { position: absolute; top: 50%; right: 6px; display: grid; place-items: center; width: 26px; height: 26px; border-radius: 8px; color: var(--panel-faint);
  opacity: 0; transform: translateY(-50%); transition: opacity .15s, background-color .15s; }
.accounts-row:hover .accounts-more, .accounts-more:focus-visible, .accounts-more[data-state="open"], .accounts-row:has(.is-active) .accounts-more { opacity: 1; }
.accounts-more:hover, .accounts-more[data-state="open"] { background: rgba(0, 0, 0, .06); color: var(--panel-text); }
.accounts-item.is-new { color: var(--panel-blue); }
.accounts-item.is-new .accounts-avatar { border-style: dashed; color: var(--panel-blue); }
.accounts-empty { margin: 4px 10px; color: var(--panel-faint); font-size: 12px; line-height: 1.6; }
.accounts-main { flex: 1; min-width: 0; }
@media (max-width: 760px) {
  .accounts { flex-direction: column; align-items: stretch; }
  .accounts-side { position: static; width: auto; }
}
</style>
