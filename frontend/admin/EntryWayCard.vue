<script setup>
/** One way into this computer, a card of equal size on both entry tabs: what it is, its state, its address and actions. */
defineProps({
  icon: { type: String, required: true },
  title: { type: String, required: true },
  tag: { type: String, default: "" },
  mark: { type: String, default: "" },
  tone: { type: String, default: "is-gray" },
  note: { type: String, default: "" },
  value: { type: String, default: "" },
  hint: { type: String, default: "" },
  active: Boolean,
  unsupported: Boolean,
});
</script>

<template>
  <article class="way" :class="{ 'is-active': active, 'is-unsupported': unsupported }">
    <header class="way-head">
      <span class="way-icon"><UIcon :name="icon" /></span>
      <span v-if="tag" class="panel-tag way-tag" :class="tone">{{ tag }}</span>
      <span class="way-corner"><slot name="corner" /></span>
    </header>
    <h4 class="way-title">{{ title }}<span v-if="mark" class="way-mark">{{ mark }}</span></h4>
    <p class="way-note">{{ note }}</p>
    <code v-if="value" class="way-value" :title="value">{{ value }}</code>
    <small v-if="hint" class="way-hint">{{ hint }}</small>
    <footer v-if="$slots.actions" class="way-actions"><slot name="actions" /></footer>
  </article>
</template>

<style scoped>
.way { display: flex; flex-direction: column; min-width: 0; min-height: 214px; padding: 16px; border: 1px solid var(--panel-line); border-radius: 16px; background: #fff;
  box-shadow: 0 1px 2px #0000000a; transition: border-color .15s, box-shadow .15s; }
.way:hover { border-color: #d1d5db; box-shadow: 0 2px 4px #0000000d, 0 6px 18px #0000000d; }
.way.is-active { border-color: #bfdbfe; }
.way.is-active:hover { border-color: #93c5fd; }
.way.is-unsupported, .way.is-unsupported:hover { border-style: dashed; background: #fafafa; box-shadow: none; }
.way-head { display: flex; align-items: center; gap: 8px; min-height: 36px; }
.way-icon { display: grid; flex-shrink: 0; place-items: center; width: 36px; height: 36px; border-radius: 11px; background: var(--panel-tint); color: var(--panel-muted); }
.way-icon > [class*="icon"] { width: 18px; height: 18px; }
.way.is-active .way-icon { background: var(--panel-blue-soft); color: var(--panel-blue); }
.way.is-unsupported .way-icon { background: #f0f1f3; color: var(--panel-faint); }
.way-tag { height: 22px; margin-left: auto; padding: 0 8px; }
.way-corner { display: flex; align-items: center; }
.way-corner:empty { display: none; }
.way-title { margin: 12px 0 4px; color: var(--panel-text); font-size: 15px; font-weight: 600; }
.way.is-unsupported .way-title { color: var(--panel-muted); }
.way-mark { margin-left: 8px; padding: 1px 7px; border-radius: 6px; background: var(--panel-blue); color: #fff; font-size: 11px; font-weight: 500; vertical-align: 1px; }
.way-note { margin: 0; color: var(--panel-muted); font-size: 12px; line-height: 1.6; }
.way.is-unsupported .way-note { color: var(--panel-faint); }
.way-value { overflow: hidden; margin-top: 10px; padding: 5px 8px; border-radius: 8px; background: var(--panel-tint); color: #374151; font: 12px ui-monospace, "Cascadia Mono", Consolas, monospace; white-space: nowrap; text-overflow: ellipsis; }
.way-hint { margin-top: 6px; color: var(--panel-amber); font-size: 12px; line-height: 1.5; }
.way-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-top: auto; padding-top: 12px; }
/* One above the other, a card needs only the height of what it says. */
@media (max-width: 760px) { .way { min-height: 0; } }
</style>
