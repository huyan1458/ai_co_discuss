<script setup>
/**
 * The owner as an account: the owner's command-line sign-ins (which the owner's room members and hosted accounts without
 * their own Windows user use too), the owner's API keys, and the skills in the owner's own folder.
 */
import AccountEnv from "./AccountEnv.vue";
import AccountKeys from "./AccountKeys.vue";
import LoginCard from "./LoginCard.vue";
</script>

<template>
  <section>
    <div class="panel-form-head">
      <h2>我</h2>
      <span class="panel-tag is-blue">管理员</span>
    </div>
    <div class="panel-list">
      <article class="panel-card is-tall">
        <LoginCard target="_" who="本机（你自己）" />
        <p class="panel-sub" style="margin: 10px 4px 0; white-space: normal">房间里你的成员、以及未隔离的托管账号都用这里的登录。Claude Code 推荐用 Setup Token：一次授权，一年有效。</p>
      </article>
      <article class="panel-card is-tall"><AccountKeys account="" /></article>
      <article class="panel-card is-tall"><AccountEnv account="" /></article>
    </div>
  </section>
</template>
