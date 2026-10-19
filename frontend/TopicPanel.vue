<script setup>
import { computed, inject } from "vue";
import { motion, useReducedMotion } from "motion-v";
import LaunchSettings from "./LaunchSettings.vue";

defineEmits(["open", "detail"]);
const { view, bridge, act, pending } = inject("discussion");
const reduced_motion = useReducedMotion();
const room = computed(() => view.value.room);
const turn = computed(() => room.value?.current_turn);
const active_turn = computed(() => turn.value && ["pending", "notified"].includes(turn.value.status));
const inactive = computed(() => ["paused", "concluded"].includes(room.value?.phase));
const can_schedule = computed(() => !active_turn.value && !inactive.value && !room.value?.limits?.reached && room.value?.floor?.holder === room.value?.host && Object.keys(room.value?.experts || {}).length > 0);
const base = computed(() => `${location.origin}/r/${room.value?.id}`);
const automatic = computed(() => room.value?.runtime?.mode === "automatic");
const execution = computed(() => room.value?.runtime?.latest_execution);
const repair = computed(() => view.value.launch.repair?.room_id === room.value?.id ? view.value.launch.repair : null);
const runtime_status = computed(() => room.value?.runtime?.expired ? "已到截止时间" : ({ ready: "尚未启动", running: "自动推进已启用", paused: "已暂停", stopped: "已停止", concluded: "已收束" }[room.value?.runtime?.status] || "尚未启动"));
const register_command = computed(() => `codiscuss add --config "discussion-${room.value?.id}.json"`);
const progress_summary = computed(() => {
  const limits = room.value?.limits || {};
  const rounds = limits.max_rounds ? `${limits.completed_rounds || 0} / ${limits.max_rounds} 轮` : `${limits.completed_rounds || 0} 轮`;
  return `${rounds} · 已用 ${Math.floor((limits.elapsed_seconds || 0) / 60)} 分钟`;
});
</script>

<template>
  <motion.section class="content-page" :class="{ 'access-page': view.tab === 'access', 'host-page': view.tab === 'topic' }" role="tabpanel" :aria-label="view.tab === 'topic' ? '主持' : '参与方式'" :initial="{ opacity: 0, y: reduced_motion ? 0 : 5 }" :animate="{ opacity: 1, y: 0 }" :transition="{ duration: 0.16 }">
    <template v-if="view.tab === 'topic'">
      <div class="page-heading"><div><span class="eyebrow">讨论进程</span><h2>主持与安排</h2><p>当前由 {{ bridge.display_name(room.host) }} 主持，围绕具体问题组织下一轮发言。</p></div><UButton icon="i-lucide-pencil" label="编辑议题" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('open', 'edit')" /></div>
      <div class="topic-brief"><div><h3>讨论目标</h3><p>{{ room.goal || '待主持人根据用户原文补全' }}</p></div><div><h3>当前焦点</h3><p>{{ room.focus || '尚未设置当前焦点' }}</p></div></div>
      <div class="host-status">
        <section v-if="room.limits" class="turn-panel"><div class="turn-header"><h3>讨论上限与进度</h3><UBadge :color="room.limits.reached && room.phase !== 'concluded' ? 'warning' : 'neutral'" variant="subtle">{{ room.phase === 'concluded' ? '已收束' : room.limits.closing ? '正在收束' : room.limits.reached ? '已达上限' : room.limits.started_at ? '已开始计时' : '尚未计时' }}</UBadge></div><p>{{ bridge.limits_label(room.limits) }}</p><UButton v-if="room.limits.reached && !inactive" label="检查并执行到限处理" variant="outline" color="neutral" :loading="pending === 'check_limits'" @click="act('check_limits')" /><p class="fine-print">在“编辑议题”中调整参数。自动模式由接入程序检查；手动模式由主持人或此按钮执行到限处理。</p></section>
        <section v-if="room.floor" class="turn-panel"><div class="turn-header"><h3>发言权</h3><UBadge color="neutral" variant="subtle">{{ bridge.floor_status(room) }}</UBadge></div><div class="button-row"><UButton v-if="!room.floor.holder" :label="`为 ${bridge.display_name(room.floor.next_speaker)} 领取`" :loading="pending === 'take_floor'" class="channel-primary-button" @click="act('take_floor')" /><UButton v-else label="归还发言权" :loading="pending === 'return_floor'" variant="outline" color="neutral" class="channel-surface-button" @click="act('return_floor')" /></div><p class="fine-print">发言或安排保存后自动归还；用户本人可随时留言。</p></section>
      </div>
      <section class="turn-panel host-turn"><div class="turn-header"><h3>当前发言安排</h3><UBadge :color="active_turn ? 'primary' : 'neutral'" variant="subtle">{{ bridge.turn_label(turn, room) }}</UBadge></div>
        <template v-if="turn"><div class="turn-expert"><UAvatar :src="bridge.identities[turn.expert]?.icon" :text="bridge.identities[turn.expert]?.initials" :alt="turn.expert" class="message-mark channel-avatar" :class="bridge.identities[turn.expert]?.style" /><div><strong>{{ turn.expert }}</strong><small>发言安排 #{{ turn.id }}</small></div></div><p class="turn-question">{{ turn.question }}</p>
          <div v-if="active_turn" class="button-row turn-actions"><UButton icon="i-lucide-copy" label="复制通知" :disabled="inactive" color="neutral" variant="outline" class="channel-surface-button" @click="act('copy_turn')" /><UButton icon="i-lucide-check-check" label="确认已通知" color="neutral" variant="outline" class="channel-surface-button" :disabled="inactive || turn.status !== 'pending'" :loading="pending === 'notify'" @click="act('notify')" /><UButton icon="i-lucide-message-square-plus" label="录入专家回答" :disabled="inactive" class="channel-primary-button" @click="act('prepare_answer')" /><UButton label="取消安排" color="neutral" variant="ghost" @click="act('cancel_turn')" /></div>
          <UButton v-if="turn.answer_id" icon="i-lucide-arrow-up-right" label="查看回答原文" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('detail', turn.answer_id)" />
        </template><p v-else class="turn-empty">把下一轮需要回答的问题，交给一位参与者。</p>
        <p v-if="active_turn" class="fine-print">{{ bridge.turn_guidance(turn, room) }}</p>
      </section>
      <section v-if="Array.isArray(room.latest_receipts)" class="info-section host-receipts"><h3>最新运行回执</h3><p class="fine-print">每位参与者最近一条；实际运行结果请查看原文。晚于摘要的回执可能尚未整理。</p><div class="button-row"><UButton v-for="receipt in room.latest_receipts" :key="receipt.id" :label="`${bridge.display_name(receipt.author)} #${receipt.id} · ${new Date(receipt.created_at).toLocaleString('zh-CN')}${receipt.id > room.state_until ? ' · 晚于摘要' : ''}`" variant="link" color="neutral" @click="$emit('detail', receipt.id)" /><span v-if="!room.latest_receipts.length" class="fine-print">尚无运行回执。</span></div></section>
      <div class="form-footer"><a :href="`${base}/turns`" target="_blank" rel="noopener" class="subtle-link">发言安排历史 <UIcon name="i-lucide-arrow-up-right" /></a><UButton icon="i-lucide-plus" label="安排下一位专家" class="channel-primary-button" :disabled="!can_schedule" @click="$emit('open', 'schedule')" /></div>
      <p v-if="!can_schedule" class="fine-print host-schedule-hint">{{ inactive ? '话题已暂停或收束，修改阶段后可以继续安排。' : active_turn ? '先完成或取消当前安排，再安排下一位。' : room.limits?.reached ? '已达到讨论上限，请检查到限处理；需要继续时先暂停并调整参数。' : room.floor?.holder !== room.host ? '主持人领取发言权后可安排下一位。' : '请先在议题资料中配置参与专家。' }}</p>
    </template>
    <template v-else>
      <div class="page-heading access-heading">
        <div><h2>接入 AI</h2><p>选择推进方式，再按步骤完成接入。</p></div>
        <UBadge v-if="automatic" :color="room.runtime?.status === 'running' ? 'primary' : 'neutral'" variant="subtle">{{ runtime_status }}</UBadge>
      </div>
      <div class="access-modes" aria-label="讨论推进方式">
        <button type="button" class="access-mode" :class="{ 'is-selected': automatic }" :aria-pressed="automatic" :disabled="Boolean(pending)" @click="act('choose_runtime', 'automatic')">
          <UIcon name="i-lucide-zap" class="mode-icon" /><span><strong>全自动讨论</strong><small>本机服务按安排唤醒 AI，接续讨论。</small></span><UIcon v-if="automatic" name="i-lucide-check" class="mode-check" />
        </button>
        <button type="button" class="access-mode" :class="{ 'is-selected': !automatic }" :aria-pressed="!automatic" :disabled="Boolean(pending)" @click="act('choose_runtime', 'manual')">
          <UIcon name="i-lucide-copy" class="mode-icon" /><span><strong>手动复制冷启动</strong><small>复制参与指令，由你或软件定时触发。</small></span><UIcon v-if="!automatic" name="i-lucide-check" class="mode-check" />
        </button>
      </div>
      <section v-if="automatic" class="access-evidence" aria-label="实际执行进展" role="status"><strong>实际执行进展</strong><p>{{ bridge.execution_label(execution) }}</p><p v-if="room.runtime?.status === 'running' && (!execution || ['pending', 'dispatched'].includes(execution.status))" class="fine-print">尚无 AI 进入记录。请核对本机服务及对应软件的登录和工具权限。</p></section>
      <div v-if="room.runtime?.status === 'running'" class="access-running"><span>切换方式前，先暂停讨论并核对原会话。</span><UButton label="暂停讨论" variant="outline" color="neutral" class="channel-surface-button" :loading="pending === 'pause_runtime'" @click="act('pause_runtime')" /></div>
      <section v-if="automatic && view.launch.available" class="access-setup" aria-label="网页启动入口">
        <div class="access-section-title"><h3>从网页启动</h3><span class="fine-print">本机执行</span></div>
        <template v-if="room.runtime?.status === 'ready'">
          <LaunchSettings :participants="[room.host, ...Object.keys(room.experts || {})]" />
          <UButton label="启动讨论" icon="i-lucide-play" class="channel-primary-button" :loading="pending === 'launch_current_room'" @click="act('launch_current_room')" />
        </template>
        <div v-else-if="room.runtime?.status === 'paused' && !room.archived && !view.launch.remote" class="launch-settings">
          <h3>修正本场软件连接</h3>
          <p class="fine-print">登录或软件权限问题请先在对应软件中处理。路径变化可在这里修正，保存后再到进度看板重启。客户端类型、工作目录、项目及会话设置保持不变。</p>
          <UButton label="读取本场配置" variant="outline" color="neutral" :loading="pending === 'load_room_configuration'" @click="act('load_room_configuration')" />
          <template v-if="repair">
            <UFormField v-for="(profile, name) in repair.participants" :key="name" :label="`${name} · ${profile.adapter === 'antigravity' ? 'Sidecar 目录' : '软件路径'}`"><UInput :model-value="profile[profile.adapter === 'antigravity' ? 'ipc_directory' : 'executable'] || ''" class="w-full" @update:model-value="bridge.write_room_connection(name, $event)" /></UFormField>
            <UButton label="保存本场路径" :loading="pending === 'save_room_configuration'" @click="act('save_room_configuration')" />
            <p v-if="repair.notice" role="status" class="fine-print">{{ repair.notice }}</p>
          </template>
          <p v-if="view.launch.repair_error" role="alert" class="fine-print">{{ view.launch.repair_error }}</p>
        </div>
        <p v-else-if="room.runtime?.status === 'paused' && view.launch.remote" class="fine-print">讨论已暂停，可在进度看板重启。线上连接暂不提供已登记房间的软件路径修正。</p>
        <p v-else-if="room.runtime?.status === 'running'" class="fine-print">讨论正在运行。</p>
        <p v-else class="fine-print">本场讨论已停止或结束，已有记录保留。</p>
        <p class="fine-print">另一种入口：在 AI 工具对话中调用 discuss-host，由当前会话主持。</p>
      </section>
      <section v-else-if="automatic" class="access-setup" aria-label="全自动接入步骤">
        <LaunchSettings :participants="[room.host, ...Object.keys(room.experts || {})]" />
        <details><summary>手动下载与登记配置</summary>
        <div class="access-section-title"><h3>首次接入</h3><a href="https://github.com/huyan1458/ai_co_discuss/blob/main/docs/runner.md#常驻讨论服务" target="_blank" rel="noopener" class="subtle-link">配置说明 <UIcon name="i-lucide-arrow-up-right" /></a></div>
        <ol class="access-steps">
          <li><span class="access-step-number">1</span><div><h4>下载接入配置</h4><p>包含当前房间信息。下载后，补齐本机软件路径与会话配置。</p></div><UButton v-if="room.runtime?.protected" icon="i-lucide-download" label="下载接入配置" class="channel-primary-button" :loading="pending === 'export_runtime'" @click="act('export_runtime')" /></li>
          <li><span class="access-step-number">2</span><div><h4>登记到本机服务</h4><p>在下载文件所在目录执行；也可以将文件名换成完整路径。</p><div class="access-command"><code>{{ register_command }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制房间登记命令" @click="act('copy', register_command)" /></div></div></li>
          <li><span class="access-step-number">3</span><div><h4>启动服务，保持终端打开</h4><p>启动服务不会自动开始讨论。已暂停的讨论可在进度看板点“重启”。</p><div class="access-command"><code>codiscuss</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制服务启动命令" @click="act('copy', 'codiscuss')" /></div></div></li>
        </ol>
        </details>
      </section>
      <details v-if="!automatic || !view.launch.available" class="access-disclosure access-workspace">
        <summary><span>项目与工作目录 <small>可选</small></span><UIcon name="i-lucide-chevron-down" class="disclosure-icon" /></summary>
        <div class="access-disclosure-body"><p>指定 AI 使用的本机项目和目录，留空使用默认位置。仅保存在本机配置中。</p><div class="form-two-columns"><UFormField label="AI 软件中的项目"><UInput :model-value="view.fields['runtime-project']" placeholder="项目名称" class="w-full" @update:model-value="bridge.write_field('runtime-project', $event)" /></UFormField><UFormField label="工作目录"><UInput :model-value="view.fields['runtime-cwd']" placeholder="已有本机目录的完整路径" class="w-full" @update:model-value="bridge.write_field('runtime-cwd', $event)" /></UFormField></div></div>
      </details>
      <details class="access-disclosure access-instructions" :open="!automatic">
        <summary><span>{{ automatic ? '手动参与指令与阅读地址' : '复制指令，交给对应的 AI' }}</span><UIcon name="i-lucide-chevron-down" class="disclosure-icon" /></summary>
        <div class="access-disclosure-body">
          <div v-if="!automatic && room.runtime?.protected" class="access-running"><span>本房间已启用写入保护，请将接入配置的本机路径交给参与的本地 AI。</span><UButton icon="i-lucide-download" label="下载接入配置" variant="outline" color="neutral" class="channel-surface-button" @click="act('export_runtime')" /></div>
          <section class="access-section"><span class="access-icon"><UIcon name="i-lucide-terminal" /></span><div><h3>本地 AI 软件 <UBadge color="primary" variant="subtle">可提交回答</UBadge></h3><p>在 Codex、Claude Code 等本地会话中发送参与指令。AI 可自行读取讨论、提交回答。</p><div class="button-row"><UButton icon="i-lucide-copy" label="复制本地参与指令" variant="outline" color="neutral" class="channel-surface-button" @click="act('copy_cli')" /><UButton label="复制后台首启指令" variant="ghost" color="neutral" @click="act('copy_background')" /></div><details class="access-reading"><summary>查看阅读地址</summary><div class="access-address"><code>{{ base }}?mode=cli</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制 CLI 阅读地址" @click="act('copy', `${base}?mode=cli`)" /></div><a :href="`${base}?mode=cli`" target="_blank" rel="noopener" class="subtle-link">打开接入说明 <UIcon name="i-lucide-arrow-up-right" /></a></details></div></section>
          <section class="access-section"><span class="access-icon"><UIcon name="i-lucide-globe" /></span><div><h3>在线聊天 AI <UBadge color="neutral" variant="subtle">由用户或主持人代发</UBadge></h3><p>在网页聊天中发送参与指令。AI 在原聊天回答，再由用户或主持人复制到本讨论。</p><div class="button-row"><UButton icon="i-lucide-copy" label="复制在线参与指令" variant="outline" color="neutral" class="channel-surface-button" @click="act('copy_online')" /><UButton :to="base" target="_blank" label="打开阅读页" trailing-icon="i-lucide-arrow-up-right" variant="ghost" color="neutral" /></div><details class="access-reading"><summary>查看阅读地址</summary><div class="access-address"><code>{{ base }}</code><UButton icon="i-lucide-copy" color="neutral" variant="ghost" aria-label="复制在线阅读地址" @click="act('copy_reading')" /></div></details></div></section>
          <p class="fine-print">当前参与身份：{{ bridge.display_name(view.fields['author-select'] || '用户') }}。复制前，请在消息页选择实际参与的 AI 身份。</p>
          <p v-if="base.includes('127.0.0.1') || base.includes('localhost')" class="fine-print">本机地址仅本机可访问。在线 AI 需要公网阅读地址，或由用户提供材料。</p>
        </div>
      </details>
      <details v-if="room.limits" class="access-disclosure access-limits">
        <summary><span>讨论上限与进度</span><span class="access-limit-summary">{{ progress_summary }}</span><UIcon name="i-lucide-chevron-down" class="disclosure-icon" /></summary>
        <div class="access-disclosure-body"><p>{{ bridge.limits_label(room.limits) }}</p><div class="button-row"><UButton icon="i-lucide-pencil" label="编辑讨论上限" variant="outline" color="neutral" class="channel-surface-button" @click="$emit('open', 'edit')" /><UButton v-if="room.limits.reached && !inactive" label="检查并执行到限处理" variant="outline" color="neutral" class="channel-surface-button" :loading="pending === 'check_limits'" @click="act('check_limits')" /></div></div>
      </details>
    </template>
  </motion.section>
</template>

<style scoped>
.access-page { color: var(--ui-text); }
.access-heading { align-items: flex-start; }
.access-heading > span { margin-top: 2px; white-space: nowrap; }
.access-evidence { margin-bottom: 18px; padding: 12px 0; overflow-wrap: anywhere; }
.access-evidence strong { font-size: 13px; }
.access-evidence p { margin: 6px 0 0; }
.access-modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 28px; }
.access-mode { display: flex; align-items: flex-start; gap: 12px; min-width: 0; padding: 17px 16px; border: 1px solid var(--ui-border); border-radius: 8px; background: transparent; color: var(--ui-text-muted); text-align: left; cursor: pointer; }
.access-mode:hover { background: var(--ui-bg-elevated); }
.access-mode:focus-visible { outline: 2px solid var(--channel-accent); outline-offset: 3px; }
.access-mode.is-selected { border-color: color-mix(in srgb, var(--channel-accent) 60%, var(--ui-border)); background: color-mix(in srgb, var(--channel-accent) 6%, transparent); }
.access-mode > span:not(.mode-icon):not(.mode-check) { flex: 1; min-width: 0; }
.access-mode strong { display: block; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 600; }
.access-mode small { display: block; margin-top: 5px; font-size: 12px; line-height: 1.6; }
.mode-icon { flex-shrink: 0; width: 18px; height: 18px; margin-top: 1px; }
.mode-check { flex-shrink: 0; width: 16px; height: 16px; color: var(--channel-accent); margin-top: 1px; }
.access-section-title { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; }
.access-section-title h3 { font-size: 13px; font-weight: 600; color: var(--ui-text-highlighted); }
.access-steps { list-style: none; margin: 0; padding: 0; }
.access-steps > li { display: flex; align-items: flex-start; gap: 14px; padding: 20px 0; }
.access-steps > li + li { border-top: 1px solid var(--ui-border-muted); }
.access-steps > li > div { flex: 1; min-width: 0; }
.access-step-number { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 24px; border: 1px solid var(--ui-border); border-radius: 50%; color: var(--ui-text-muted); font-size: 12px; }
.access-steps h4 { margin: 1px 0 6px; color: var(--ui-text-highlighted); font-size: 13px; font-weight: 500; }
.access-steps p, .access-disclosure-body > p { margin: 0; color: var(--ui-text-muted); font-size: 12px; line-height: 1.8; }
.access-steps > li > button { flex-shrink: 0; margin-top: 2px; }
.access-command { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 5px 7px 5px 13px; border: 1px solid var(--ui-border); border-radius: 6px; background: var(--ui-bg-muted); }
.access-command code { flex: 1; min-width: 0; font-size: 12px; color: var(--ui-text); overflow-wrap: anywhere; }
.access-command > button { flex-shrink: 0; color: var(--ui-text-muted); }
.access-disclosure { border-top: 1px solid var(--ui-border-muted); }
.access-disclosure > summary { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 14px 0; cursor: pointer; list-style: none; font-size: 12px; color: var(--ui-text); }
.access-disclosure summary::-webkit-details-marker, .access-reading summary::-webkit-details-marker { display: none; }
.access-disclosure > summary > span:first-child { flex: 1; }
.access-disclosure summary small { margin-left: 6px; color: var(--ui-text-dimmed); font-size: 11px; }
.disclosure-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--ui-text-muted); }
.access-disclosure[open] > summary .disclosure-icon { transform: rotate(180deg); }
.access-disclosure-body { padding: 0 0 20px; }
.access-workspace .form-two-columns, .access-disclosure-body > .button-row { margin-top: 16px; }
.access-instructions .access-section { padding: 18px 0 22px; }
.access-instructions .access-section:last-of-type { border-bottom: 0; }
.access-instructions .access-icon { background: var(--ui-bg-elevated); border-color: var(--ui-border); color: var(--ui-text-muted); border-radius: 7px; box-shadow: none; }
.access-reading { margin-top: 14px; }
.access-reading > summary { display: inline-block; cursor: pointer; color: var(--ui-text-muted); font-size: 12px; list-style: none; text-decoration: underline; text-underline-offset: 3px; }
.access-reading .access-address { margin: 12px 0; }
.access-limit-summary { font-size: 11px; color: var(--ui-text-muted); }
.access-failure { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 22px; padding: 12px 14px; border-left: 2px solid var(--ui-warning); background: color-mix(in srgb, var(--ui-warning) 5%, transparent); border-radius: 0 6px 6px 0; color: var(--ui-warning); }
.access-failure > span { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }
.access-failure > div { min-width: 0; }
.access-failure strong { color: var(--ui-text-highlighted); font-size: 12px; font-weight: 500; }
.access-failure summary { cursor: pointer; margin-top: 6px; color: var(--ui-text-muted); font-size: 11px; }
.access-failure p { margin-top: 8px; color: var(--ui-text-muted); font-size: 12px; overflow-wrap: anywhere; line-height: 1.7; }
.access-running { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; font-size: 12px; color: var(--ui-text-muted); }
.access-running > button { flex-shrink: 0; }
@media (max-width: 640px) {
  .access-modes { grid-template-columns: 1fr; gap: 8px; margin-bottom: 22px; }
  .access-mode { padding: 14px; }
  .access-workspace .form-two-columns { grid-template-columns: 1fr; }
  .access-steps > li { flex-wrap: wrap; gap: 10px; padding: 17px 0; }
  .access-steps > li > div { flex-basis: calc(100% - 34px); }
  .access-steps > li > button { margin-left: 34px; min-height: 44px; }
  .access-command > button { min-width: 44px; min-height: 44px; }
  .access-page :is(button, a), .access-reading > summary, .access-failure summary { min-height: 44px; }
  .access-reading > summary, .access-failure summary { display: flex; align-items: center; }
  .access-limit-summary { max-width: 45%; text-align: right; }
  .access-instructions .button-row > :is(button, a), .access-running > button { min-height: 44px; }
  .access-running { flex-wrap: wrap; gap: 10px; }
}
</style>
