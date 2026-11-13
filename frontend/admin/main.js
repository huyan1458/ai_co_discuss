import { createApp } from "vue";
import ui from "@nuxt/ui/vue-plugin";
import AdminApp from "./AdminApp.vue";
import "./admin.css";

/** Mount the computer owner's management panel. */
createApp(AdminApp).use(ui).mount("#admin-root");
