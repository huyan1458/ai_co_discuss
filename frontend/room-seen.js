// The owner's read position per room, kept by the room backend so every device agrees (#15998, #16003, Fable #16010):
// a room with messages after it shows "有新结果"; "标为已读" moves it to the latest message (and may hide the current
// failure), "标为未读" moves it back one message. The room list carries `owner_read_until` and `failure_dismissed_at`;
// a change shows at once from a local override and is sent in the background, rolled back with a notice if it fails.
import { ref } from "vue";
import { t } from "./i18n.js";

// { [room_id]: { read, dismissed } } — local intent not yet reflected in the room list.
const overrides = ref({});

function current(room) {
  const local = overrides.value[room.id];
  return {
    read: local ? local.read : room.owner_read_until ?? room.latest_id ?? 0,
    dismissed: local ? local.dismissed : room.failure_dismissed_at ?? 0,
  };
}

/** Whether the room has messages after the owner's read position. */
export const is_unread = (room) => (room.latest_id || 0) > current(room).read;

/** Whether the room's failure was dismissed and nothing has happened since. */
export const failure_dismissed = (room) => {
  const { dismissed } = current(room);
  return dismissed > 0 && (room.latest_id || 0) <= dismissed;
};

async function send(bridge, room, payload, next) {
  const before = overrides.value[room.id];
  overrides.value = { ...overrides.value, [room.id]: next };
  try {
    await bridge.request(`/api/rooms/${encodeURIComponent(room.id)}/owner-read`, payload);
  } catch (problem) {
    const rest = { ...overrides.value };
    if (before) rest[room.id] = before; else delete rest[room.id];
    overrides.value = rest;
    bridge.notify?.("error", t("已读状态没有保存：{reason}", { reason: problem?.message || "" }));
  }
}

/** Mark the room read up to its latest message; `dismiss` also hides its current failure until there is new activity. */
export function mark_read(bridge, room, dismiss = false) {
  const latest = room.latest_id || 0;
  const now = current(room);
  if (now.read >= latest && (!dismiss || now.dismissed >= latest)) return;
  send(bridge, room, { message_id: latest, ...(dismiss ? { dismiss_failure: true } : {}) },
    { read: Math.max(now.read, latest), dismissed: dismiss ? latest : now.dismissed });
}

/** Mark the room unread: its latest message counts as not yet seen. */
export function mark_unread(bridge, room) {
  const latest = room.latest_id || 0;
  if (!latest) return;
  send(bridge, room, { message_id: latest, unread: true }, { read: latest - 1, dismissed: current(room).dismissed });
}
