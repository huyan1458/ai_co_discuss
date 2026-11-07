import { defineComponent, Fragment, h, withMemo } from "vue";

/**
 * Re-renders its slot only when `deps` change, with a cache of its own.
 *
 * `v-memo` on an element nested inside a `v-for` (rather than on the `v-for` element itself) compiles to one shared
 * cache slot, so each item compares against the previous item and never hits. Wrapping the item in this component
 * gives every item its own slot. Like `v-memo`, anything the slot reads that is not in `deps` stays stale.
 *
 * @prop {unknown[]} deps Values compared item by item with the previous render.
 */
export default defineComponent({
  name: "MemoBlock",
  inheritAttrs: false,
  props: { deps: { type: Array, required: true } },
  setup(props, { slots }) {
    const cache = [];
    return () => withMemo(props.deps, () => h(Fragment, slots.default?.()), cache, 0);
  },
});
