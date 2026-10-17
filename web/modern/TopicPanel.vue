<script setup>
import { computed, inject } from "vue";
import { motion, useReducedMotion } from "motion-v";

defineEmits(["open", "detail"]);
const { view, bridge, act, pending } = inject("discussion");
const reduced_motion = useReducedMotion();
const room = computed(() => view.value.room);
const turn = computed(() => room.value?.current_turn);
const active_turn = computed(() => turn.value && ["pending", "notified"].includes(turn.value.status));
const inactive = computed(() => ["paused", "concluded"].includes(room.value?.phase));
const can_schedule = computed(() => !active_turn.value && !inactive.value && room.value?.floor?.holder === room.value?.host && Object.keys(room.value?.experts || {}).length > 0);
const base = computed(() => `${location.origin}/r/${room.value?.id}`);
</script>

<template>
  <motion.section class="content-page" role="tabpanel" :aria-label="view.tab === 'topic' ? '主持' : '参与方式'" :initial="{ opacity: 0, y: reduced_motion ? 0 : 5 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: 0.16 }">
    <template v-if="view.tab === 'topic'">
      <div class="page-heading"><div><span class="eyebrow">讨论进程</span><h2>主持与安排</h2><p>当前由 {{ bridge.display_name(room.host) }} 主持，围绕具体问题组织下一轮发言。</p></div><UButton icon="i-lucide-pencil" label="编辑议题" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('open', 'edit')" /></div>
      <div class="topic-brief"><div><h3>讨论目标</h3><p>{{ room.goal || '尚未填写讨论目标' }}</p></div><div><h3>当前焦点</h3><p>{{ room.focus || '尚未设置当前焦点' }}</p></div></div>
      <section v-if="room.floor" class="turn-panel"><div class="turn-header"><h3>发言权</h3><UBadge color="neutral" variant="subtle">{{ bridge.floor_status(room) }}</UBadge></div><div class="button-row"><UButton v-if="!room.floor.holder" :label="`为 ${bridge.display_name(room.floor.next_speaker)} 领取`" :loading="pending === 'take_floor'" class="channel-primary-button" @click="act('take_floor')" /><UButton v-else label="归还发言权" :loading="pending === 'return_floor'" variant="outline" color="neutral" class="channel-surface-button" @click="act('return_floor')" /></div><p class="fine-print">发言或安排保存后自动归还；用户本人可随时留言。</p></section>
      <section class="turn-panel"><div class="turn-header"><h3>当前发言安排</h3><UBadge :color="active_turn ? 'primary' : 'neutral'" variant="subtle">{{ bridge.turn_label(turn, room) }}</UBadge></div>
        <template v-if="turn"><div class="turn-expert"><UAvatar :src="bridge.identities[turn.expert]?.icon" :text="bridge.identities[turn.expert]?.initials" :alt="turn.expert" class="message-mark channel-avatar" :class="bridge.identities[turn.expert]?.style" /><div><strong>{{ turn.expert }}</strong><small>发言安排 #{{ turn.id }}</small></div></div><p class="turn-question">{{ turn.question }}</p>
          <div v-if="active_turn" class="button-row"><UButton icon="i-lucide-copy" label="复制通知" :disabled="inactive" color="neutral" variant="outline" class="channel-surface-button" @click="act('copy_turn')" /><UButton icon="i-lucide-check-check" label="确认已通知" color="neutral" variant="outline" class="channel-surface-button" :disabled="inactive || turn.status !== 'pending'" :loading="pending === 'notify'" @click="act('notify')" /><UButton icon="i-lucide-message-square-plus" label="录入专家回答" :disabled="inactive" class="channel-primary-button" @click="act('prepare_answer')" /><UButton label="取消安排" color="neutral" variant="ghost" @click="act('cancel_turn')" /></div>
          <UButton v-if="turn.answer_id" icon="i-lucide-arrow-up-right" label="查看回答原文" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('detail', turn.answer_id)" />
        </template><p v-else class="turn-empty">把下一轮需要回答的问题，交给一位参与者。</p>
        <p v-if="active_turn" class="fine-print">{{ bridge.turn_guidance(turn, room) }}</p>
      </section>
      <section v-if="Array.isArray(room.latest_receipts)" class="info-section"><h3>最新运行回执</h3><p class="fine-print">每位参与者最近一条；实际运行结果请查看原文。晚于摘要的回执可能尚未整理。</p><div class="button-row"><UButton v-for="receipt in room.latest_receipts" :key="receipt.id" :label="`${bridge.display_name(receipt.author)} #${receipt.id} · ${new Date(receipt.created_at).toLocaleString('zh-CN')}${receipt.id > room.state_until ? ' · 晚于摘要' : ''}`" variant="link" color="neutral" @click="$emit('detail', receipt.id)" /><span v-if="!room.latest_receipts.length" class="fine-print">尚无运行回执。</span></div></section>
      <div class="form-footer"><a :href="`${base}/turns`" target="_blank" rel="noopener" class="subtle-link">发言安排历史 <UIcon name="i-lucide-arrow-up-right" /></a><UButton icon="i-lucide-plus" label="安排下一位专家" class="channel-primary-button" :disabled="!can_schedule" @click="$emit('open', 'schedule')" /></div>
      <p v-if="!can_schedule" class="fine-print">{{ inactive ? '话题已暂停或收束，修改阶段后可以继续安排。' : active_turn ? '先完成或取消当前安排，再安排下一位。' : room.floor?.holder !== room.host ? '主持人领取发言权后可安排下一位。' : '请先在议题资料中配置参与专家。' }}</p>
    </template>
    <template v-else>
      <div class="page-heading"><div><span class="eyebrow">共享讨论入口</span><h2>邀请 AI 参与</h2><p>按运行环境选择参与方式，专家自主决定阅读深度。</p></div></div>
      <section class="access-section"><span class="access-icon"><UIcon name="i-lucide-globe" /></span><div><h3>在线 AI <UBadge color="neutral" variant="subtle">只读</UBadge></h3><p>把阅读入口提供给在线聊天产品。观点留在原聊天窗口，再由用户或主持人代发。</p><div class="access-address"><code>{{ base }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制在线阅读地址" @click="act('copy_reading')" /></div><div class="button-row"><UButton label="复制只读参与指令" variant="outline" color="neutral" class="channel-surface-button" @click="act('copy_online')" /><UButton :to="base" target="_blank" label="打开阅读页" trailing-icon="i-lucide-arrow-up-right" variant="ghost" color="neutral" /></div></div></section>
      <section class="access-section"><span class="access-icon"><UIcon name="i-lucide-terminal" /></span><div><h3>本地 CLI AI <UBadge color="primary" variant="subtle">读写</UBadge></h3><p>使用本地 AI 软件读取话题，通过留言板接口提交观点，按消息编号核对原文。</p><div class="access-address"><code>{{ base }}?mode=cli</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制 CLI 阅读地址" @click="act('copy', `${base}?mode=cli`)" /></div><div class="button-row"><UButton label="复制 CLI 参与指令" variant="outline" color="neutral" class="channel-surface-button" @click="act('copy_cli')" /><UButton label="复制后台首启指令" variant="outline" color="neutral" class="channel-surface-button" @click="act('copy_background')" /><UButton :to="`${base}?mode=cli`" target="_blank" label="打开接入说明" trailing-icon="i-lucide-arrow-up-right" variant="ghost" color="neutral" /></div></div></section>
      <p class="fine-print">指令使用讨论区当前选择的身份：{{ bridge.display_name(view.fields['author-select'] || '用户') }}。通知只提供问题与入口，不附整段上下文。</p>
      <p v-if="base.includes('127.0.0.1') || base.includes('localhost')" class="fine-print">当前是本机地址。在线 AI 需要公网阅读地址，或由用户复制材料提供。</p>
    </template>
  </motion.section>
</template>
