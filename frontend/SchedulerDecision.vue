<script setup>
/**
 * One smart-scheduling decision with its odds, the model's input and the correction form.
 * It owns the input panel and the form, so opening them or typing never re-renders the message list.
 */
import { computed, inject, ref } from "vue";
import ScheduleCard from "./ScheduleCard.vue";

const props = defineProps({
  decision: { type: Object, required: true },
  /** Free collaboration: every decision is advisory, and the correction can also pick everyone or no one. */
  free: Boolean,
});
const { view, bridge, act } = inject("discussion");
const DECISION_OPTIONS = { __host__: "交给主持人", __note__: "仅补充信息", continue: "继续下一轮", __all__: "全体各自回应", __all_seq__: "全体依次回应", __none__: "无需回应" };
// "Only these few" choices carry the names after a prefix, as the scheduler writes them.
const SOME_PREFIX = "__some__:";
// The select needs a non-empty value for "not specified"; it is saved as an empty answer.
const UNSET_CORRECTION = "__unset__";
const option_name = (name) => DECISION_OPTIONS[name]
  || (String(name).startsWith(SOME_PREFIX) ? `${String(name).slice(SOME_PREFIX.length).split("、").map(bridge.display_name).join("、")} 各自回应` : bridge.display_name(name));

/** Every option of one question with its probability, most likely first, so a close call is visible at a glance. */
function decision_odds(item) {
  return (item.choices || []).map((value) => ({ value, name: option_name(value), probability: item.probabilities?.[value] }))
    .sort((left, right) => (right.probability ?? -1) - (left.probability ?? -1));
}
/** Model of the decision, read from the record itself. */
const model = computed(() => {
  try { return (JSON.parse(props.decision.context || "{}") || {}).model || ""; } catch { return ""; }
});

// The model's input is fetched only when asked for; it is several KB per decision and not part of the room view.
const input = ref({ open: false, loading: false, loaded: false, data: null });
/** Open or close the input; the first opening loads it, a failure is reported and leaves it closed. */
async function toggle_input() {
  const current = input.value;
  if (current.loading) return;
  if (current.open || current.loaded) { input.value = { ...current, open: !current.open }; return; }
  input.value = { ...current, loading: true };
  try { input.value = { open: true, loading: false, loaded: true, data: summarize_input(await bridge.load_decision_input(props.decision.id)) }; }
  catch (failure) {
    input.value = { open: false, loading: false, loaded: false, data: null };
    bridge.notify("error", `读取完整输入失败：${failure.message}`);
  }
}
/** Message numbers as a short list: consecutive numbers collapse into a range. */
function message_span(ids) {
  const runs = [];
  for (const id of ids) {
    const last = runs.at(-1);
    if (last && id === last[1] + 1) last[1] = id; else runs.push([id, id]);
  }
  return runs.map(([from, to]) => from === to ? `#${from}` : `#${from}–#${to}`).join("、");
}
/**
 * Split the saved state into the fixed background, the room facts and which messages were passed (numbers only);
 * options keep only their descriptions, since the card already shows their probabilities.
 */
function summarize_input(saved) {
  const state = saved?.input;
  if (!state?.state) return null;
  const blocks = String(state.state).split("\n\n");
  const lines = blocks[0].split("\n");
  const start = lines.findIndex((line) => line.startsWith("房间："));
  const message_block = blocks.find((block) => /^(近期消息|本轮及最近发言)/.test(block)) || "";
  const pending_block = blocks.find((block) => block.startsWith("待处理的用户消息")) || "";
  const ids = (block) => [...block.matchAll(/^#(\d+)/gm)].map((match) => Number(match[1]));
  const recent = ids(message_block);
  return {
    background: (start > 0 ? lines.slice(0, start) : []).join("\n"),
    facts: (start >= 0 ? lines.slice(start) : lines).join("\n"),
    messages: recent.length ? `${recent.length} 条：${message_span(recent)}` : "无",
    pending: message_span(ids(pending_block)),
    questions: (state.questions || []).map((question) => ({ instructions: question.instructions,
      choices: (question.choices || []).map((choice) => ({ name: option_name(choice.value), description: choice.description })) })),
  };
}

/** Clicking the current verdict again withdraws it; a bad one saves at once and opens an optional correction form. */
const correcting = ref(null);
function rate(rating) {
  const { decision } = props;
  const withdraw = decision.feedback === rating;
  correcting.value = !withdraw && rating === "bad" ? { should_be: decision.should_be || "", note: decision.note || "" } : null;
  act("rate_decision", { decision_id: decision.id, rating: withdraw ? null : rating,
    ...(rating === "bad" && !withdraw ? { should_be: decision.should_be, note: decision.note } : {}) });
}
function save_correction() {
  const { should_be, note } = correcting.value;
  correcting.value = null;
  act("rate_decision", { decision_id: props.decision.id, rating: "bad", should_be, note });
}
/** Who could have answered: every member present, plus the host; a free room's routing can also pick everyone or no one. */
const correction_options = computed(() => [{ label: "未指定", value: UNSET_CORRECTION }, ...(view.value.room.members || []).filter((member) => member.status === "active")
  .map((member) => ({ label: bridge.display_name(member.name), value: member.name })),
  ...(props.free ? ["__all__", "__all_seq__", "__none__"].map((value) => ({ label: DECISION_OPTIONS[value], value })) : [])]);
</script>

<template>
  <ScheduleCard icon="i-lucide-zap" :skipped="free ? true : !decision.applied" :title="decision.title" label="智能调度决策" toggle-label="展开或收起判断详情" :expandable="Boolean(decision.detail?.length)">
    <template #text>智能调度：{{ decision.label }}<small v-if="decision.confidence !== null">置信度 {{ Number(decision.confidence).toFixed(2) }}</small><small v-if="decision.duration">耗时 {{ decision.duration }}</small></template>
    <template #actions>
      <button v-if="view.access?.can_manage" type="button" class="channel-schedule-rate" :class="{ 'is-on': decision.feedback === 'good' }" :aria-pressed="decision.feedback === 'good'" aria-label="这次调度判断得好" title="判断得好" @click="rate('good')"><UIcon name="i-lucide-thumbs-up" /></button>
      <button v-if="view.access?.can_manage" type="button" class="channel-schedule-rate" :class="{ 'is-on': decision.feedback === 'bad' }" :aria-pressed="decision.feedback === 'bad'" aria-label="这次调度判断得不好" title="判断得不好" @click="rate('bad')"><UIcon name="i-lucide-thumbs-down" /></button>
    </template>
    <div class="channel-schedule-meta">
      <div class="channel-schedule-odds-list">
        <p v-for="(item, index) in decision.detail" :key="index" class="channel-schedule-odds">
          <b v-if="decision.detail.length > 1">第 {{ index + 1 }} 题</b>
          <span v-for="option in decision_odds(item)" :key="option.value" :class="{ 'is-chosen': option.value === item.choice }">{{ option.name }}<small v-if="option.probability !== undefined">{{ Number(option.probability).toFixed(2) }}</small></span>
        </p>
      </div>
      <span class="channel-schedule-model">{{ [decision.provider_label, model].filter(Boolean).join(" · ") }}</span>
      <UButton :label="input.open ? '收起输入' : '模型输入'" :trailing-icon="input.open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :loading="input.loading" variant="link" color="neutral" size="xs" class="channel-schedule-input-toggle"
        :aria-expanded="input.open" :aria-label="input.open ? '收起模型看到的完整输入' : '查看模型看到的完整输入'" @click="toggle_input" />
    </div>
    <p v-if="input.open && input.data === null" class="channel-schedule-input is-empty">这条判断没有保存输入。</p>
    <div v-else-if="input.open" class="channel-schedule-input">
      <p v-if="input.data.background"><b>固定背景</b><span :title="input.data.background">{{ input.data.background }}</span></p>
      <p><b>房间与成员</b><span :title="input.data.facts">{{ input.data.facts }}</span></p>
      <p><b>对话上下文</b><span>近期消息 {{ input.data.messages }}<template v-if="input.data.pending">；待处理 {{ input.data.pending }}</template></span></p>
      <template v-for="(question, index) in input.data.questions" :key="index">
        <p><b>问题{{ input.data.questions.length > 1 ? ` ${index + 1}` : "" }}</b><span :title="question.instructions">{{ question.instructions }}</span></p>
        <p v-for="choice in question.choices" :key="choice.name" class="is-choice"><b>{{ choice.name }}</b><span :title="choice.description">{{ choice.description }}</span></p>
      </template>
    </div>
  </ScheduleCard>
  <form v-if="correcting && decision.feedback === 'bad'" class="channel-schedule-correction" @submit.prevent="save_correction">
    <label>应该由谁回答<USelect :model-value="correcting.should_be || UNSET_CORRECTION" :items="correction_options" aria-label="应该由谁回答" size="xs" class="channel-schedule-correction-select"
      @update:model-value="correcting.should_be = $event === UNSET_CORRECTION ? '' : $event" /></label>
    <UInput v-model="correcting.note" maxlength="200" placeholder="想说的话（可选）" aria-label="对这次调度判断想说的话" size="xs" class="channel-schedule-correction-note" />
    <span class="channel-schedule-correction-actions">
      <UButton type="submit" label="保存" size="xs" variant="soft" color="primary" />
      <UButton label="关闭" size="xs" variant="ghost" color="neutral" @click="correcting = null" />
    </span>
  </form>
</template>
