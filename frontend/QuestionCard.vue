<script setup>
import { t } from './i18n.js';
import { computed, inject, ref, watch } from "vue";

/**
 * The owner's answer card for questions members asked (backend/questions.py), above the composer: one card at a time,
 * in the site's order; the others wait as a one-line queue. Every write sends the version the card shows, so a
 * recommendation that arrived meanwhile is refused and the card shows the new version instead.
 */
const props = defineProps({ questions: { type: Array, required: true } });
const { bridge, act, pending } = inject("discussion");
const current = computed(() => props.questions.find((item) => item.status === "waiting_user") || null);
const waiting = computed(() => props.questions.filter((item) => item !== current.value));
// Choices and free text per item of the current card; a new card or a new version starts empty.
const picked = ref({});
const notes = ref("");
let submission = "";
watch(() => current.value && `${current.value.id}:${current.value.version}`, () => {
  picked.value = {};
  notes.value = "";
  submission = "";
}, { immediate: true });

const STATUS = { waiting_recommendation: () => t('等主持人推荐'), delegated: () => t('已交主持人决定'), waiting_user: () => t('待你回答') };
const route_text = computed(() => {
  const gate = current.value?.gate;
  if (!gate) return t('答案交回 {value1}', { value1: bridge.display_name(current.value.asker) });
  return gate.route === "repeat" ? t('答后接力再来一圈') : t('答后接力交下一棒');
});

function toggle(item, option) {
  const chosen = picked.value[item.id] || [];
  const next = chosen.includes(option.id) ? chosen.filter((id) => id !== option.id) : item.multiple ? [...chosen, option.id] : [option.id];
  picked.value = { ...picked.value, [item.id]: next };
}

const answerable = computed(() => Object.values(picked.value).some((chosen) => chosen.length) || notes.value.trim());

/** Send one action for the current card; a retry of the same click keeps its submission id. */
async function send(action) {
  const question = current.value;
  if (!question) return;
  submission ||= crypto.randomUUID();
  const choices = Object.fromEntries(Object.entries(picked.value).filter(([, chosen]) => chosen.length));
  const body = { version: question.version, action, submission_id: submission, choices, ...(notes.value.trim() ? { text: notes.value } : {}) };
  if (await act("question_answer", { id: question.id, operation: "answer", body })) submission = "";
}

async function cancel() {
  const question = current.value;
  if (question) await act("question_answer", { id: question.id, operation: "cancel", body: { version: question.version } });
}
</script>

<template>
  <section v-if="questions.length" class="question-card" :aria-label="t('待你回答的问题')">
    <template v-if="current">
      <header class="question-head">
        <UIcon name="i-lucide-circle-help" class="question-icon" />
        <span class="question-title">{{ t('{value1} 在问你', { value1: bridge.display_name(current.asker) }) }}</span>
        <span class="question-meta">{{ t('问题 #{value1} · 第 {value2} 版 · 说明见消息 #{value3}', { value1: current.id, value2: current.version, value3: current.message_id }) }}</span>
      </header>
      <p v-if="current.recommendation_message_id" class="question-note">{{ t('主持人已给推荐（消息 #{value1}），请确认或另选', { value1: current.recommendation_message_id }) }}</p>
      <div v-for="item in current.questions" :key="item.id" class="question-item">
        <p class="question-prompt">{{ item.prompt }}<span v-if="item.multiple" class="question-multi">{{ t('（可多选）') }}</span></p>
        <div v-if="item.options.length" class="question-options" role="group" :aria-label="item.prompt">
          <UButton v-for="option in item.options" :key="option.id" size="sm" :variant="(picked[item.id] || []).includes(option.id) ? 'solid' : 'outline'"
            color="neutral" :aria-pressed="(picked[item.id] || []).includes(option.id)" :disabled="!!pending" @click="toggle(item, option)">
            {{ option.id }} · {{ option.label }}
          </UButton>
        </div>
      </div>
      <UTextarea v-model="notes" :rows="1" autoresize :maxrows="6" :placeholder="t('补充说明或其他意见（可选）')" class="question-notes" :disabled="!!pending" />
      <p class="question-scope">{{ t('{value1}；问题与回答按房间阅读权限公开，不要填写密钥、令牌或密码', { value1: route_text }) }}</p>
      <footer class="question-actions">
        <UButton size="sm" :label="t('提交回答')" icon="i-lucide-check" :disabled="!!pending || !answerable" @click="send(answerable && !Object.values(picked).some((chosen) => chosen.length) ? 'other' : 'answer')" />
        <UButton size="sm" color="neutral" variant="ghost" :label="t('请主持人先讨论并给推荐')" :disabled="!!pending" @click="send('recommend')" />
        <UButton size="sm" color="neutral" variant="ghost" :label="t('交给主持人决定')" :disabled="!!pending" @click="send('delegate')" />
        <UButton size="sm" color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="t('取消这个问题')" :title="t('取消这个问题；绑定接力的问题取消后接力停止')" :disabled="!!pending" @click="cancel" />
      </footer>
    </template>
    <ul v-if="waiting.length" class="question-queue" :aria-label="t('排队中的问题')">
      <li v-for="item in waiting" :key="item.id">
        <UIcon name="i-lucide-clock" />
        <span>{{ t('#{value1} {value2}：{value3}', { value1: item.id, value2: bridge.display_name(item.asker), value3: item.questions[0]?.prompt || '' }) }}</span>
        <span class="question-status">{{ (STATUS[item.status] || STATUS.waiting_user)() }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.question-card { display: flex; flex-direction: column; gap: 8px; margin: 0 12px 8px; padding: 10px 12px; border: 1px solid var(--ui-border-accented); border-radius: 12px; background: var(--ui-bg-elevated); font-size: 13px; }
.question-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.question-icon { color: var(--ui-primary); }
.question-title { font-weight: 600; color: var(--ui-text-highlighted); }
.question-meta, .question-scope, .question-status, .question-multi { color: var(--ui-text-dimmed); font-size: 12px; }
.question-note { color: var(--ui-text-toned); }
.question-prompt { margin-bottom: 4px; color: var(--ui-text-highlighted); }
.question-options { display: flex; flex-wrap: wrap; gap: 6px; }
.question-notes { width: 100%; }
.question-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.question-queue { display: flex; flex-direction: column; gap: 2px; color: var(--ui-text-muted); }
.question-queue li { display: flex; align-items: center; gap: 6px; min-width: 0; }
.question-queue li > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
</style>
