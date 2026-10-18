import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import App from "./App.vue";
import "./theme.css";
import "./channel.css";

/** Mount the channel workspace once, sharing its controller with millennium chat. */
function mount_workspace() {
  createApp(App).use(ui).mount("#modern-root");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount_workspace);
else mount_workspace();
