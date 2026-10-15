<script setup>
import { computed, onBeforeUnmount, provide, ref, watch } from "vue";
import { MotionConfig, motion, useReducedMotion } from "motion-v";
import { useToast } from "@nuxt/ui/composables";
import { zh_cn } from "@nuxt/ui/locale";
import { use_discussion } from "./use-discussion.js";
import Discussion from "./Discussion.vue";
import TopicPanel from "./TopicPanel.vue";
import WorkspaceDialogs from "./WorkspaceDialogs.vue";
import ChannelWorkspace from "./ChannelWorkspace.vue";

const discussion = use_discussion();
provide("discussion", discussion);
const { view, bridge, act, pending, field } = discussion;
const toast = useToast();
const reduced_motion = useReducedMotion();
const modal = ref("");
const detail_id = ref(null);
const info_open = ref(false);
const nav_open = ref(false);
const room = computed(() => view.value.room);
const summary = field("state-input");
const tabs = [
  { value: "discussion", label: "讨论", icon: "i-lucide-messages-square" },
  { value: "context", label: "共识与分歧", icon: "i-lucide-notebook-pen" },
  { value: "topic", label: "主持", icon: "i-lucide-sliders-horizontal" },
  { value: "access", label: "参与方式", icon: "i-lucide-plug" },
];
const focus = computed(() => room.value?.current_turn?.status === "pending" || room.value?.current_turn?.status === "notified"
  ? room.value.current_turn.question : room.value?.focus || room.value?.goal || "明确一个问题，让讨论开始。");

/** Route operation feedback into the active workspace's accessible toaster. */
function on_toast(event) {
  if (!["modern", "channel"].includes(view.value.theme)) return;
  toast.add({ title: event.detail.message, color: event.detail.is_error ? "error" : "success", duration: 3500 });
}
document.addEventListener("discuss:toast", on_toast);
onBeforeUnmount(() => document.removeEventListener("discuss:toast", on_toast));
watch(() => view.value.theme, () => { modal.value = ""; info_open.value = false; nav_open.value = false; });

/** Select a room and dismiss its narrow-screen navigation. */
async function choose_room(id) { nav_open.value = false; await act("room", id); }

/** Open an exact original message without adding it to the loaded history page. */
function open_detail(id) { detail_id.value = id; modal.value = "message"; }

/** Move keyboard focus together with the active tab. */
function move_tab(event, offset) {
  const buttons = Array.from(event.currentTarget.parentElement.querySelectorAll('[role="tab"]'));
  const index = (buttons.indexOf(event.currentTarget) + offset + buttons.length) % buttons.length;
  buttons[index].focus();
  act("tab", tabs[index].value);
}
</script>

<template>
  <UApp :locale="zh_cn" :tooltip="{ delayDuration: 300 }" :toaster="{ position: 'bottom-right' }">
    <MotionConfig reduced-motion="user">
      <ChannelWorkspace v-if="view.theme === 'channel'" />
      <div v-show="view.theme === 'modern'" class="studio-shell">
        <div v-if="nav_open" class="nav-scrim" @click="nav_open = false"></div>
        <aside class="studio-sidebar" :class="{ 'is-open': nav_open }" aria-label="房间导航" @keydown.esc="nav_open = false">
          <div class="studio-brand"><span class="brand-emblem"><UIcon name="i-lucide-messages-square" /></span><div><strong>共议</strong><span>讨论工作空间</span></div>
            <UButton class="mobile-only" icon="i-lucide-x" color="neutral" variant="ghost" aria-label="关闭房间导航" @click="nav_open = false" />
          </div>
          <UButton icon="i-lucide-plus" color="neutral" variant="outline" class="create-discussion" label="新建讨论" @click="modal = 'create'; nav_open = false" />
          <div class="sidebar-label"><span>讨论房间</span><span>{{ view.rooms.length }}</span></div>
          <nav class="studio-rooms">
            <button v-for="item in view.rooms" :key="item.id" class="studio-room" :class="{ selected: item.id === room?.id }" :aria-current="item.id === room?.id ? 'page' : undefined" :title="item.title" @click="choose_room(item.id)">
              <UIcon name="i-lucide-hash" /><span>{{ item.title }}</span><small>{{ item.message_count }}</small>
            </button>
            <p v-if="!view.rooms.length" class="sidebar-empty">还没有讨论房间</p>
          </nav>
          <div class="sidebar-bottom">
            <div class="workspace-note"><UIcon name="i-lucide-message-square-text" /><p>不同的观点，<br>在同一份记录中讨论。</p></div>
            <UButton icon="i-lucide-settings-2" label="外观设置" color="neutral" variant="ghost" block class="settings-entry" @click="modal = 'settings'" />
            <div class="service-status" role="status"><span :class="{ connected: view.connected }"></span>{{ view.connected ? '讨论服务已连接' : '讨论服务未连接' }}</div>
          </div>
        </aside>

        <main class="studio-main">
          <header class="studio-header">
            <div class="header-title"><UButton class="mobile-only" icon="i-lucide-panel-left" color="neutral" variant="ghost" aria-label="打开房间导航" :aria-expanded="nav_open" @click="nav_open = !nav_open" />
              <div><div class="breadcrumb">工作空间 <span>/</span> 讨论房间</div><h1>{{ room?.title || '你的讨论工作空间' }}</h1></div>
            </div>
            <div v-if="room" class="header-actions"><UBadge color="neutral" variant="subtle" class="phase-badge"><span class="phase-dot" :class="room.phase"></span>{{ bridge.phases[room.phase] }}</UBadge>
              <UTooltip text="刷新讨论"><UButton icon="i-lucide-refresh-cw" color="neutral" variant="ghost" aria-label="刷新讨论" :loading="pending === 'refresh'" @click="act('refresh')" /></UTooltip>
              <UButton icon="i-lucide-panel-right" label="议题资料" color="neutral" variant="outline" class="info-button" @click="info_open = true" />
            </div>
          </header>
          <div v-if="room" class="studio-tabs" role="tablist" aria-label="讨论视图">
            <button v-for="tab in tabs" :key="tab.value" role="tab" :aria-selected="view.tab === tab.value" :tabindex="view.tab === tab.value ? 0 : -1" :class="{ active: view.tab === tab.value }" @click="act('tab', tab.value)" @keydown.right.prevent="move_tab($event, 1)" @keydown.left.prevent="move_tab($event, -1)">
              <UIcon :name="tab.icon" /><span>{{ tab.label }}</span><small v-if="tab.value === 'discussion'">{{ room.message_count }}</small>
            </button>
            <span class="host-caption">主持人 <b>{{ room.host }}</b></span>
          </div>
          <template v-if="room">
            <section v-show="view.tab === 'discussion'" class="discussion-page" role="tabpanel" aria-label="讨论">
              <div class="focus-strip"><UIcon name="i-lucide-focus" /><div><span>当前焦点</span><p>{{ focus }}</p></div><UButton icon="i-lucide-arrow-up-right" color="neutral" variant="ghost" aria-label="查看主持安排" @click="act('tab', 'topic')" /></div>
              <Discussion @detail="open_detail" />
            </section>
            <motion.section v-if="view.tab === 'context'" class="content-page" role="tabpanel" aria-label="共识与分歧" :initial="{ opacity: 0, y: reduced_motion ? 0 : 5 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: 0.16 }">
              <div class="page-heading"><div><span class="eyebrow">共享记录</span><h2>共识与分歧</h2><p>保留讨论的进展，也保留尚未解决的问题。</p></div><UBadge color="neutral" variant="outline">整理至 #{{ room.state_until }}</UBadge></div>
              <form class="summary-form" @submit.prevent="act('save_context')">
                <UTextarea v-model="summary" aria-label="共识与分歧正文" :rows="15" :maxlength="4000" class="summary-editor" placeholder="已达成的共识…&#10;&#10;尚未解决的分歧…&#10;&#10;需要补充的证据…&#10;&#10;用 #消息编号 引用原始发言。" />
                <div class="form-footer"><span>依据记录截止 #{{ view.snapshot_id }} · 原始发言保持不变</span><UButton type="submit" icon="i-lucide-check" label="保存共识" :loading="pending === 'save_context'" /></div>
              </form>
            </motion.section>
            <TopicPanel v-if="view.tab === 'topic' || view.tab === 'access'" :key="view.tab" @open="modal = $event" @detail="open_detail" />
          </template>
          <div v-else class="workspace-empty"><UIcon name="i-lucide-messages-square" /><h2>从一个值得讨论的问题开始</h2><p>创建房间，记录不同观点，逐步形成共识。</p><UButton icon="i-lucide-plus" label="新建讨论" @click="modal = 'create'" /></div>
        </main>

        <USlideover v-model:open="info_open" title="议题资料" description="目标、边界与参与方式" :ui="{ content: 'glass-panel', body: 'space-y-7' }">
          <template #body><template v-if="room">
            <section v-for="item in [{ key: 'goal', label: '讨论目标' }, { key: 'focus', label: '当前焦点' }, { key: 'background', label: '背景' }, { key: 'boundaries', label: '讨论边界' }]" :key="item.key" class="info-section"><h3>{{ item.label }}</h3><p>{{ room[item.key] || '尚未填写' }}</p></section>
            <section class="info-section"><h3>参与身份</h3><div class="expert-row"><span class="mini-avatar">我</span><b>用户</b><small>{{ room.host === '用户' ? '主持人' : '发起与协助' }}</small></div><div v-for="(mode, name) in room.experts" :key="name" class="expert-row"><span class="mini-avatar" :class="bridge.identities[name]?.style">{{ bridge.identities[name]?.initials }}</span><b>{{ name }}</b><small>{{ mode === 'cli' ? '本地 CLI · 读写' : '在线 AI · 只读' }}</small></div><p class="fine-print">参与身份不表示已连接或已完成认证。</p></section>
            <UButton icon="i-lucide-pencil" color="neutral" variant="outline" label="编辑议题资料" @click="info_open = false; modal = 'edit'" />
          </template></template>
        </USlideover>
        <WorkspaceDialogs v-model="modal" :detail-id="detail_id" />
      </div>
    </MotionConfig>
  </UApp>
</template>
