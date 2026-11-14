<script setup>
/**
 * The owner as an account: the owner's command-line sign-ins (which the owner's room members and hosted accounts without
 * their own Windows user use too), the owner's API keys, the skills in the owner's own folder, and its system prompts.
 */
import AccountEnv from "./AccountEnv.vue";
import AccountKeys from "./AccountKeys.vue";
import LoginCard from "./LoginCard.vue";
import OwnerPrompt from "./OwnerPrompt.vue";
</script>

<template>
  <section>
    <div class="panel-form-head">
      <h2>管理员</h2>
      <span class="panel-tag is-blue">本机账号</span>
    </div>
    <div class="panel-list">
      <article class="panel-card is-tall">
        <LoginCard target="_" who="本机（你自己）" />
        <p class="panel-sub" style="margin: 10px 4px 0; white-space: normal">管理员房间中的成员及未隔离的托管账号均使用此处登录。Claude Code 建议使用 Setup Token（一次授权，有效期一年）。</p>
      </article>
      <article class="panel-card is-tall"><AccountKeys account="" /></article>
      <article class="panel-card is-tall"><AccountEnv account="" /></article>
      <article class="panel-card is-tall"><OwnerPrompt /></article>
    </div>
  </section>
</template>
