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
    if (pending.value) return false;
    pending.value = name;
    try { return await bridge.execute(name, value); }
    finally { pending.value = ""; }
  }
  return { bridge, view, pending, field, act };
}
