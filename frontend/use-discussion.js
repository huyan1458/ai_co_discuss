import { computed, onBeforeUnmount, ref, shallowRef } from "vue";

/** Adapt shared controller snapshots and drafts to Vue's reactive bindings. */
export function use_discussion() {
  const bridge = window.discuss_view;
  const view = shallowRef(bridge.snapshot());
  const running = ref(new Map());
  const is_running = name => running.value.has(name);
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
    const counts = running.value;
    counts.set(name, (counts.get(name) || 0) + 1);
    try { return await bridge.execute(name, value); }
    finally {
      const remaining = counts.get(name) - 1;
      if (remaining) counts.set(name, remaining);
      else counts.delete(name);
    }
  }
  return { bridge, view, is_running, field, act };
}
