<script setup>
import { computed, inject, ref } from "vue";
import ChannelDiscussion from "./ChannelDiscussion.vue";
import TopicPanel from "./TopicPanel.vue";
import WorkspaceDialogs from "./WorkspaceDialogs.vue";

const { view, bridge, field, act, pending } = inject("discussion");
const room = computed(() => view.value.room);
const modal = ref("");
const detail_id = ref(null);
const nav_open = ref(false);
const info_open = ref(false);
const summary = field("state-input");
const search = field("search-input");
const author = field("author-select");
const selected_tab = computed({ get: () => view.value.tab, set: (value) => act("tab", value) });
const tabs = [
  { value: "discussion", label: "消息", icon: "i-lucide-message-square" },
  { value: "context", label: "共识", icon: "i-lucide-file-text" },
  { value: "topic", label: "主持", icon: "i-lucide-list-checks" },
  { value: "access", label: "接入", icon: "i-lucide-plug" },
];
const channels = computed(() => view.value.rooms.map((item) => ({
  label: item.title, icon: "i-lucide-hash", active: item.id === room.value?.id,
  badge: item.message_count, title: item.title, onSelect: () => choose_room(item.id),
})));
const view_links = computed(() => tabs.map((item) => ({
  ...item, active: view.value.tab === item.value, onSelect: () => { nav_open.value = false; act("tab", item.value); },
})));
const focus = computed(() => ["pending", "notified"].includes(room.value?.current_turn?.status)
  ? room.value.current_turn.question : room.value?.focus || room.value?.goal);
const participants = computed(() => [
  { name: "用户", mode: "发起与协助" },
  ...Object.entries(room.value?.experts || {}).map(([name, mode]) => ({ name, mode: mode === "cli" ? "CLI · 读写" : "在线 AI · 只读" })),
]);
const channel_actions = computed(() => [[
  { label: "频道操作", type: "label" },
  { label: "编辑议题", icon: "i-lucide-pencil", onSelect: () => { modal.value = "edit"; } },
  { label: "复制阅读入口", icon: "i-lucide-link", onSelect: () => act("copy_reading") },
], [{ label: "刷新消息", icon: "i-lucide-refresh-cw", onSelect: () => act("refresh") }]]);

/** Select a shared room and close the mobile navigation. */
async function choose_room(id) { nav_open.value = false; await act("room", id); }

/** Open an exact original message without altering the transcript. */
function open_detail(id) { detail_id.value = id; modal.value = "message"; }

/** Open the shared creation form from either navigation surface. */
function create_channel() { nav_open.value = false; modal.value = "create"; }
</script>

<template>
  <div class="channel-shell">
    <aside class="channel-sidebar" aria-label="频道导航">
      <header class="channel-workspace-heading">
        <span class="channel-brand-icon"><UIcon name="i-lucide-messages-square" /></span>
        <strong>共议</strong><span>AI CoDiscuss</span>
      </header>
      <div class="channel-sidebar-content">
        <div class="channel-directory-heading"><span><UIcon name="i-lucide-chevron-down" />讨论频道</span><UTooltip text="新建讨论"><UButton icon="i-lucide-plus" color="neutral" variant="ghost" size="xs" aria-label="新建讨论" @click="create_channel" /></UTooltip></div>
        <UNavigationMenu :items="channels" orientation="vertical" color="neutral" variant="pill" class="channel-directory" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkLeadingIcon: 'channel-link-icon', linkTrailingBadge: 'channel-count' }" />
        <template v-if="room">
          <div class="channel-directory-heading channel-tools-heading"><span><UIcon name="i-lucide-chevron-down" />频道工具</span></div>
          <UNavigationMenu :items="view_links" orientation="vertical" color="neutral" variant="pill" class="channel-directory channel-view-links" aria-label="频道视图" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkLeadingIcon: 'channel-link-icon' }" />
        </template>
      </div>
      <footer class="channel-sidebar-footer">
        <UAvatar :text="bridge.identities[author]?.initials" :alt="author" size="sm" class="channel-avatar" :class="bridge.identities[author]?.style" />
        <div class="channel-self"><strong>{{ author }}</strong><div class="channel-connection"><span :class="{ connected: view.connected }"></span>{{ view.connected ? '服务已连接' : '服务未连接' }}</div></div>
        <UTooltip text="外观设置"><UButton icon="i-lucide-settings-2" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="外观设置" @click="modal = 'settings'" /></UTooltip>
      </footer>
    </aside>

    <main class="channel-main">
      <header class="channel-header">
        <UButton icon="i-lucide-panel-left" color="neutral" variant="ghost" size="sm" class="channel-mobile-nav" aria-label="打开频道导航" @click="nav_open = true" />
        <span class="channel-title-icon"><UIcon name="i-lucide-hash" /></span>
        <div class="channel-title"><h1 :title="room?.title">{{ room?.title || '共议' }}</h1></div>
        <span v-if="room" class="channel-header-context">{{ tabs.find((item) => item.value === view.tab)?.label }}<span>·</span>{{ room.message_count }} 条记录</span>
        <div v-if="room" class="channel-header-actions">
          <form v-if="view.tab === 'discussion'" class="channel-search" @submit.prevent="act('filter', { query: search })">
            <UInput v-model="search" icon="i-lucide-search" variant="none" size="sm" placeholder="搜索消息" aria-label="搜索讨论记录" class="channel-search-input">
              <template #trailing><UButton v-if="search || view.query" icon="i-lucide-x" color="neutral" variant="ghost" size="xs" aria-label="清除搜索" @click="search = ''; act('filter', { query: '' })" /><UButton type="submit" icon="i-lucide-corner-down-left" color="neutral" variant="ghost" size="xs" aria-label="搜索" /></template>
            </UInput>
          </form>
          <UTooltip v-if="view.tab === 'discussion'" text="只看提到当前身份的消息"><UButton icon="i-lucide-at-sign" :variant="view.mention_only ? 'soft' : 'ghost'" color="neutral" size="sm" class="channel-icon-button channel-mention-filter" :aria-pressed="view.mention_only" aria-label="提到我" @click="act('filter', { mention: !view.mention_only })" /></UTooltip>
          <UTooltip text="频道资料与参与者"><UButton icon="i-lucide-panel-right" color="neutral" variant="ghost" size="sm" class="channel-icon-button channel-info-button" aria-label="频道资料" @click="info_open = true" /></UTooltip>
          <UDropdownMenu :items="channel_actions" :content="{ align: 'end', sideOffset: 8 }" :ui="{ content: 'channel-menu' }"><UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="sm" class="channel-icon-button" aria-label="频道菜单" /></UDropdownMenu>
        </div>
      </header>
      <div v-if="room" class="channel-tabbar">
        <UTabs v-model="selected_tab" :items="tabs" :content="false" variant="pill" color="neutral" size="sm" class="channel-tabs" aria-label="频道视图" />
      </div>
      <div v-if="room" class="channel-body" :class="{ 'channel-body-discussion': view.tab === 'discussion' }">
        <div class="channel-content">
        <ChannelDiscussion v-show="view.tab === 'discussion'" @detail="open_detail" />
        <section v-if="view.tab === 'context'" class="content-page channel-summary" role="tabpanel" aria-label="共识">
          <div class="page-heading"><div><h2>共识与分歧</h2><p>整理讨论进展，用 #消息编号 保留依据。</p></div><UBadge color="neutral" variant="outline">截止 #{{ room.state_until }}</UBadge></div>
          <form @submit.prevent="act('save_context')">
            <UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="15" :maxlength="4000" class="summary-editor" placeholder="已达成的共识、尚未解决的问题与下一步…" />
            <div class="form-footer"><span>依据消息截止 #{{ view.snapshot_id }}</span><UButton type="submit" color="neutral" icon="i-lucide-check" label="保存共识" class="channel-primary-button" :loading="pending === 'save_context'" /></div>
          </form>
        </section>
        <TopicPanel v-if="view.tab === 'topic' || view.tab === 'access'" :key="view.tab" @open="modal = $event" @detail="open_detail" />
        </div>
        <aside v-if="view.tab === 'discussion'" class="channel-member-rail" aria-label="频道概览与参与者">
          <section class="channel-overview">
            <div class="channel-overview-heading"><span>频道概览</span><UBadge color="neutral" variant="subtle" size="sm" class="channel-phase"><span class="channel-phase-dot" :class="room.phase"></span>{{ bridge.phases[room.phase] }}</UBadge></div>
            <h2>{{ room.title }}</h2>
            <p v-if="room.goal" class="channel-overview-goal">{{ room.goal }}</p>
            <div v-if="focus && focus !== room.goal" class="channel-current-focus"><span><UIcon name="i-lucide-pin" />当前焦点</span><p>{{ focus }}</p></div>
            <UButton label="查看频道资料" trailing-icon="i-lucide-chevron-right" color="neutral" variant="link" class="channel-detail-link" @click="info_open = true" />
          </section>
          <section class="channel-participants">
            <div class="channel-directory-heading"><span>参与者 — {{ participants.length }}</span><UTooltip text="配置的参与身份，不代表在线状态"><UIcon name="i-lucide-info" /></UTooltip></div>
            <UButton v-for="person in participants" :key="person.name" color="neutral" variant="ghost" class="channel-person" @click="act('tab', 'access')">
              <UAvatar :text="bridge.identities[person.name]?.initials" :alt="person.name" size="sm" class="channel-avatar" :class="bridge.identities[person.name]?.style" />
              <span class="channel-person-label"><strong>{{ person.name }}<UIcon v-if="person.name === room.host" name="i-lucide-crown" title="主持人" /></strong><small>{{ person.name === room.host ? `主持人 · ${person.mode}` : person.mode }}</small></span>
            </UButton>
          </section>
        </aside>
      </div>
      <div v-else class="channel-empty"><UIcon name="i-lucide-hash" /><h2>新建一个讨论频道</h2><p>每个频道围绕一个议题，保留所有人的观点。</p><UButton icon="i-lucide-plus" label="新建讨论" color="neutral" @click="create_channel" /></div>
    </main>

    <USlideover v-model:open="nav_open" side="left" title="讨论频道" description="共议 · AI CoDiscuss" :ui="{ content: 'channel-navigation-drawer', body: 'channel-drawer-body' }">
      <template #body><UNavigationMenu :items="channels" orientation="vertical" color="neutral" :ui="{ link: 'channel-link', linkLabel: 'channel-link-label', linkTrailingBadge: 'channel-count' }" /><UButton block icon="i-lucide-plus" color="neutral" variant="outline" class="channel-surface-button" label="新建讨论" @click="create_channel" /><UButton block icon="i-lucide-settings-2" color="neutral" variant="ghost" label="外观设置" @click="nav_open = false; modal = 'settings'" /></template>
    </USlideover>
    <USlideover v-model:open="info_open" title="频道资料" description="目标、背景与参与方式" :ui="{ content: 'channel-details', body: 'space-y-6' }">
      <template #body><template v-if="room">
        <div class="channel-detail-title"><UIcon name="i-lucide-hash" /><h2>{{ room.title }}</h2></div>
        <section v-for="item in [{ key: 'goal', label: '讨论目标' }, { key: 'focus', label: '当前焦点' }, { key: 'background', label: '背景' }, { key: 'boundaries', label: '讨论边界' }]" :key="item.key" class="info-section"><h3>{{ item.label }}</h3><p>{{ room[item.key] || '尚未填写' }}</p></section>
        <USeparator />
        <section class="info-section"><h3>参与身份</h3><div v-for="person in participants" :key="person.name" class="expert-row"><UAvatar :text="bridge.identities[person.name]?.initials" :alt="person.name" size="sm" class="channel-avatar" :class="bridge.identities[person.name]?.style" /><b>{{ person.name }}</b><small>{{ person.mode }}</small></div></section>
        <UButton icon="i-lucide-pencil" color="neutral" variant="outline" block class="channel-surface-button" label="编辑议题" @click="info_open = false; modal = 'edit'" />
      </template></template>
    </USlideover>
    <WorkspaceDialogs v-model="modal" :detail-id="detail_id" />
  </div>
</template>
