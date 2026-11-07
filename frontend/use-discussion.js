import { computed, onBeforeUnmount, ref, shallowRef } from "vue";

const LOCAL_ACTIONS = new Set(["room", "tab", "filter", "refresh", "archives", "reply", "cancel_reply", "discard_sending", "choose_attachments",
  "remove_attachment", "preview_attachment", "copy", "copy_cli", "copy_background", "copy_reading"]);

/** Adapt shared controller snapshots and drafts to Vue's reactive bindings. */
export function use_discussion() {
  const bridge = window.discuss_view;
  const view = shallowRef(bridge.snapshot());
  const pending = ref("");
  // Quiet fields keep what was typed here until the next snapshot carries it, so a keystroke re-renders only its readers.
  const typed = shallowRef({});
  const sync = () => { view.value = bridge.snapshot(); typed.value = {}; };
  document.addEventListener("discuss:view", sync);
  onBeforeUnmount(() => document.removeEventListener("discuss:view", sync));
  /**
   * A two-way binding to a controller form field.
   *
   * @param {string} id The controller control's id.
   * @param {{quiet?: boolean}} [options] quiet: the write publishes no snapshot; use only for fields whose input changes no other shared state.
   */
  const field = (id, { quiet = false } = {}) => computed({
    get: () => (id in typed.value ? typed.value[id] : view.value.fields[id] || ""),
    set: (value) => {
      if (!quiet) return bridge.write_field(id, value);
      typed.value = { ...typed.value, [id]: value ?? "" };
      bridge.write_field(id, value, { publish: false });
    } });
  async function act(name, value) {
    // Ordering runs beside other actions, like the directory's moves; the speaking order guards its own sends.
    if (["manage_channel", "move_channel", "create_folder", "rename_folder", "delete_folder", "move_folder", "create", "reorder_speakers"].includes(name)) return bridge.execute(name, value);
    // Navigation and local-only actions never wait for a write in flight: writes check the room they started in.
    if (LOCAL_ACTIONS.has(name)) return bridge.execute(name, value);
    if (pending.value) return bridge.execute("busy", pending.value);
    pending.value = name;
    try { return await bridge.execute(name, value); }
    finally { pending.value = ""; }
  }
  return { bridge, view, pending, field, act };
}
