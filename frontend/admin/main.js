import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import AdminApp from "./AdminApp.vue";
import { i18n_plugin } from "../i18n.js";
import "./admin.css";

/** Mount the computer owner's management panel. */
createApp(AdminApp).use(ui).use(i18n_plugin).mount("#admin-root");
