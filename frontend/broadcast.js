/**
 * Voice broadcast: while on, new replies are announced by their summary and a few room events by one short line, through
 * the reader's broadcast queue. Only what happens after it is turned on is announced; the user's own messages are not.
 *
 * Narration, in the default voice:
 * - a discussion round starting, with its speakers in order, and whose turn it is (discussion only);
 * - an execution failing, or an operation refused and waiting for the user's approval;
 * - a discussion ending, with why.
 * A turn already named by the host's latest announced message is not repeated.
 */
import { ref, watch } from "vue";

// A host message naming the next speaker makes the turn line redundant within this time.
const HOST_NAMED_MS = 60000;

/**
 * Watch the room and feed the reader's broadcast queue.
 * @param {object} options
 * @param {import("vue").Ref} options.view Room view.
 * @param {object} options.bridge Page bridge; uses display_name and stop_reason_label.
 * @param {object} options.reader The transcript reader (announce, set_broadcast, state).
 * @returns {{ on: import("vue").Ref<boolean>, toggle: Function }}
 */
export function use_broadcast({ view, bridge, reader }) {
  const on = ref(false);
  let seen = null, host_said = { text: "", at: 0 };
  const room = () => view.value.room || {};
  const name = (value) => bridge.display_name(value);

  /** What has already happened, so only later changes are announced. */
  function snapshot() {
    const executions = room().free?.executions || [];
    return {
      room_id: room().id,
      message_id: Math.max(0, ...view.value.messages.map((message) => Number(message.id) || 0)),
      failed: new Set(executions.filter((item) => item.status === "failed").map((item) => item.id)),
      refused: new Set(executions.filter((item) => item.denials?.length).map((item) => item.id)),
      round: discussion_round(), speaker: speaker(), concluded: room().session?.status === "concluded",
    };
  }

  const in_discussion = () => room().speaking_order?.kind === "turns" && !["paused", "concluded"].includes(room().phase);
  const discussion_round = () => in_discussion() ? room().current_turn?.round || 0 : 0;
  const speaker = () => in_discussion() && ["pending", "notified"].includes(room().current_turn?.status) ? room().current_turn.expert : "";

  /** Turn on inside the click (so phones allow sound later), or off. */
  function toggle() {
    on.value = !on.value;
    reader.set_broadcast(on.value);
    seen = on.value ? snapshot() : null;
  }

  function new_messages() {
    const items = [];
    for (const message of view.value.messages) {
      const id = Number(message.id) || 0;
      if (id <= seen.message_id) continue;
      seen.message_id = id;
      if (message.author === "用户" || message.kind === "receipt" || message.withdrawn) continue;
      if (message.kind === "moderation") host_said = { text: message.text || "", at: Date.now() };
      items.push({ message_id: id });
    }
    return items;
  }

  function execution_lines() {
    const lines = [];
    const members = new Map((room().free?.members || []).map((member) => [member.id, member.name]));
    for (const execution of room().free?.executions || []) {
      const who = name(execution.member || members.get(execution.member_id) || "成员");
      const refused = Boolean(execution.denials?.length) && !seen.refused.has(execution.id);
      if (execution.status === "failed" && !seen.failed.has(execution.id)) {
        seen.failed.add(execution.id);
        if (refused) seen.refused.add(execution.id);
        lines.push({ text: refused ? `${who} 执行失败，有操作被拒绝，等你允许。` : `${who} 执行失败。` });
      } else if (refused) {
        seen.refused.add(execution.id);
        lines.push({ text: `${who} 有操作被拒绝，等你允许。` });
      }
    }
    return lines;
  }

  function discussion_lines() {
    const lines = [];
    const round = discussion_round(), next = speaker();
    let listed = "";
    if (round && round !== seen.round) {
      const order = (room().speaking_order?.items || []).filter((item) => item.state !== "idle").map((item) => name(item.name));
      lines.push({ text: `第 ${round} 轮开始${order.length ? `，依次是 ${order.join("、")}` : ""}。` });
      listed = order[0] || "";
    }
    if (next && next !== seen.speaker) {
      const shown = name(next);
      const named = Date.now() - host_said.at < HOST_NAMED_MS && (host_said.text.includes(shown) || host_said.text.includes(next));
      if (shown !== listed && !named) lines.push({ text: `轮到 ${shown}。` });
    }
    seen.round = round || seen.round;
    seen.speaker = next;
    const concluded = room().session?.status === "concluded";
    if (concluded && !seen.concluded) lines.push({ text: `讨论已结束：${bridge.stop_reason_label(room().limits || {})}。` });
    seen.concluded = concluded;
    return lines;
  }

  watch(() => [view.value.messages, room()], () => {
    if (!on.value || !seen) return;
    // Another room starts from what is already there.
    if (room().id !== seen.room_id) { seen = snapshot(); return; }
    // Replies first, so a host message naming the next speaker is known before the turn line is decided.
    const replies = new_messages();
    reader.announce(...replies, ...discussion_lines(), ...execution_lines());
  }, { deep: false });

  return { on, toggle };
}
