import { computed, onBeforeUnmount, ref, shallowRef } from "vue";

/** Adapt shared controller snapshots and drafts to Vue's reactive bindings. */
export function use_discussion() {
  const bridge = window.discuss_view;
  const view = shallowRef(bridge.snapshot());
  const pending = ref("");
  const sync = () => { view.value = bridge.snapshot(); };
  document.addEventListener("discuss:view", sync);
  onBeforeUnmount(() => document.removeEventListener("discuss:view", sync));
  const field = (id) => computed({ get: () => view.value.fields[id] || "",
    set: (value) => bridge.write_field(id, value) });
  async function act(name, value) {
    // Ordering runs beside other actions, like the directory's moves; the speaking order guards its own sends.
    if (["manage_channel", "move_channel", "create_folder", "rename_folder", "delete_folder", "move_folder", "create", "reorder_speakers"].includes(name)) return bridge.execute(name, value);
    if (pending.value) return bridge.execute("busy", pending.value);
    pending.value = name;
    try { return await bridge.execute(name, value); }
    finally { pending.value = ""; }
  }
  return { bridge, view, pending, field, act };
}
