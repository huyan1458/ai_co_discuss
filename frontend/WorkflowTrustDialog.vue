<script setup>
/**
 * The trust prompt for a project workflow: its elevated cards and registered commands, then 信任 or 取消. The room's
 * composer ("/", the right column, enabling) and the workflow page's card (#16106) open the same one.
 * `prompt` is the workflow as listed (`label`, `project_name`, `untrusted_reasons`), null when closed.
 */
import { t } from "./i18n.js";

defineProps({ prompt: { type: Object, default: null }, submitting: Boolean, confirmLabel: { type: String, default: "" } });
const emit = defineEmits(["confirm", "cancel"]);
const ACCESS_LABELS = { read: t("只读"), write: t("可写"), auto: t("自动"), full: t("全放开") };
</script>

<template>
  <UModal :open="Boolean(prompt)" :title="prompt ? t('信任项目工作流「{name}」', { name: prompt.label || prompt.id }) : ''"
    :description="t('这个项目工作流来自项目目录，尚未在这台电脑上确认信任。启用前请核对以下权限与命令：')"
    :content="{ onInteractOutside: (event) => event.preventDefault() }"
    :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }" @update:open="(open) => { if (!open && !submitting) emit('cancel'); }">
    <template #body>
      <div v-if="prompt" class="workflow-trust-dialog">
        <p v-if="prompt.project_name" class="workflow-trust-meta">{{ t('所属项目：{name}', { name: prompt.project_name }) }}</p>
        <div v-if="prompt.untrusted_reasons?.elevated_cards?.length" class="workflow-trust-section">
          <h4>{{ t('高权限成员卡片') }}</h4>
          <ul>
            <li v-for="card in prompt.untrusted_reasons.elevated_cards" :key="card.card">
              <strong>{{ card.label || card.card }}</strong>
              <span class="workflow-trust-access">{{ ACCESS_LABELS[card.project_access] || card.project_access }}</span>
            </li>
          </ul>
        </div>
        <div v-if="prompt.untrusted_reasons?.commands?.length" class="workflow-trust-section">
          <h4>{{ t('登记的命令（commands.json）') }}</h4>
          <ul>
            <li v-for="(cmd, idx) in prompt.untrusted_reasons.commands" :key="idx"><code>{{ cmd }}</code></li>
          </ul>
        </div>
        <p class="workflow-trust-note">{{ t('确认后将记录在这台电脑的信任清单中；若工作流内容发生变更，会再次要求确认。') }}</p>
        <div class="workflow-trust-actions">
          <UButton :label="t('取消')" color="neutral" variant="ghost" :disabled="submitting" @click="emit('cancel')" />
          <UButton :label="confirmLabel || t('信任')" icon="i-lucide-shield-check" class="channel-primary-button" :loading="submitting" @click="emit('confirm')" />
        </div>
      </div>
    </template>
  </UModal>
</template>
