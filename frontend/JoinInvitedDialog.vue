<script setup>
/**
 * Join a room on another computer with a link or pairing code: pick which AI of this computer goes, its model and
 * effort, and the trust level (starting at 默认) with its limits. The same as `codiscuss join <link or code>`.
 */
import { computed, inject, ref, watch } from "vue";
import RosterAdd from "./RosterAdd.vue";
import EffortSlider from "./EffortSlider.vue";
import TrustLevelField from "./TrustLevelField.vue";
import { lockdown_problem, use_invited_rooms } from "./external-members.js";
import { t } from "./i18n.js";

const { view, bridge } = inject("discussion");
const invited = use_invited_rooms();
const open = invited.joining;
const text = ref(""), site = ref(""), platform = ref("");
const trust = ref({ trust: "default", max_wakes: 20, hours: 24 });
watch(open, (value) => {
  if (!value) return;
  text.value = invited.join_text.value;
});
const platforms = computed(() => Object.keys(bridge.launch_clients));
const items = computed(() => platforms.value.map((name) => ({ value: name, name: bridge.default_name(name), ...bridge.identities[name],
  selected: platform.value === name, aria_label: t("派 {name} 加入", { name: bridge.default_name(name) }) })));
function choose(name) {
  platform.value = name;
  bridge.load_launch_models(name);
}
// Model and effort are the platform's own launch settings, the same ones its expert card sets.
const profile = computed(() => (platform.value && view.value.launch.profiles[platform.value]) || {});
const model = computed({ get: () => profile.value.model || "__default__", set: (value) => bridge.write_launch_model(platform.value, value) });
const effort = computed({ get: () => profile.value.effort || "", set: (value) => bridge.write_launch(platform.value, "effort", value) });
const models = computed(() => platform.value && view.value ? bridge.launch_model_state(platform.value) : null);
const model_items = computed(() => models.value?.items || []);
const effort_items = computed(() => [{ value: "", label: t("默认强度") }, ...(models.value?.efforts || []).map((value) => ({ value, label: value }))]);
// A link carries the inviting computer's key fingerprint; a bare code does not, so the page says so.
const is_link = computed(() => /^https?:\/\//i.test(text.value.trim()));
// Below 信任设备 the AI must be confined to codiscuss commands; software that cannot be is said so before joining.
const lockdown = computed(() => trust.value.trust === "trusted" ? "" : lockdown_problem(profile.value.adapter, profile.value));
// A bare code says nothing about where the inviting computer is: its online site is asked for too.
const ready = computed(() => Boolean(text.value.trim() && (is_link.value || site.value.trim()) && platform.value && profile.value.adapter && invited.available.value));

async function submit() {
  if (!ready.value) return;
  const result = await invited.join({ invite: text.value.trim(), ...(is_link.value ? {} : { site: site.value.trim() }),
    adapter: profile.value.adapter, model: profile.value.model || "", effort: profile.value.effort || "", trust: trust.value });
  if (!result) return;
  open.value = false;
  bridge.notify("info", t("已加入「{room}」", { room: result.record?.room_title || "" }));
  if (result.record?.id) invited.open(result.record.id);
}
</script>

<template>
  <UModal :content="{ onInteractOutside: (event) => event.preventDefault() }" v-model:open="open" :title="t('加入另一台电脑的房间')"
    :description="t('你的 AI 在这台电脑上运行，只读对方开放的目录，在对方房间里回答。')" :ui="{ content: 'glass-panel studio-modal', body: 'dialog-body' }">
    <template #body>
      <form class="join-invited" @submit.prevent="submit">
        <UFormField :label="t('邀请链接或配对码')">
          <UInput v-model="text" class="w-full" :placeholder="t('粘贴对方发来的链接，或输入配对码')" autocomplete="off" />
        </UFormField>
        <UFormField v-if="text.trim() && !is_link" :label="t('对方的线上站点')">
          <UInput v-model="site" class="w-full" placeholder="https://….pages.dev" autocomplete="off" inputmode="url" />
        </UFormField>
        <p v-if="text.trim() && !is_link" class="fine-print">{{ t("配对码不含对方电脑的公钥指纹，无法核对连到的是不是对方；能用链接或扫码时优先用。") }}</p>
        <RosterAdd :label="t('派哪个 AI')" :items="items" @add="choose" />
        <template v-if="platform">
          <UFormField :label="t('模型')">
            <USelect v-model="model" :items="model_items" class="w-full" :loading="models?.loading" :placeholder="t('软件默认模型')" />
          </UFormField>
          <EffortSlider v-if="effort_items.length > 1" v-model="effort" :items="effort_items" :label="t('强度')" />
        </template>
        <TrustLevelField v-model="trust" />
        <p v-if="lockdown" class="fine-print join-invited-warning" role="note">{{ t("这个软件不能限制为只用共议命令（{reason}），只能在“信任设备”等级下服务；其他等级下被点名时不会启动。", { reason: lockdown }) }}</p>
        <p v-if="!invited.available.value" class="fine-print" role="alert">{{ t("加入需要本机服务，请在运行 AI 的电脑打开本机网站。") }}</p>
        <div class="join-invited-footer">
          <UButton :label="t('取消')" color="neutral" variant="ghost" @click="open = false" />
          <UButton type="submit" icon="i-lucide-log-in" :label="t('加入')" class="channel-primary-button" :loading="invited.busy.value === 'join'" :disabled="!ready || Boolean(invited.busy.value)" />
        </div>
      </form>
    </template>
  </UModal>
</template>

<style scoped>
.join-invited { display: flex; flex-direction: column; gap: 12px; }
.join-invited .fine-print { margin: -6px 0 0; }
.join-invited-warning { color: var(--ui-warning, #e0a33a); }
.join-invited-footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
