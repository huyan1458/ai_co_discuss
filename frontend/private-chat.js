/**
 * Which member and execution the private-chat page shows. The jump buttons on message cards set them before switching
 * to the page; the page keeps them while the user changes tabs.
 */
import { reactive } from "vue";

export const private_chat = reactive({ member: "", execution_id: null });

/** Show one member's execution on the private-chat page; `act` is the room's action dispatcher. */
export function open_private_chat(act, member, execution_id = null) {
  private_chat.member = member;
  private_chat.execution_id = execution_id;
  act("tab", "private");
}
