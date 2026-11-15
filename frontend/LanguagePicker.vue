<script setup>
/**
 * Interface language picker shared by the website settings and the management panel: a compact select showing each
 * language in its own name. Choosing one saves it for this site and reloads the page (see i18n-runtime.js); the website
 * and the panel are different addresses, so each keeps its own choice.
 */
import { locale, locales, set_locale } from "./i18n.js";

const items = locales.map((item) => ({ label: item.label, value: item.code }));
</script>

<template>
  <!-- The name is bilingual so someone who cannot read the current language still finds it. -->
  <USelect :model-value="locale" :items="items" icon="i-lucide-languages" size="sm" aria-label="语言 · Language"
    class="language-picker" @update:model-value="set_locale" />
</template>

<style>
.language-picker { min-width: 128px; }
</style>
