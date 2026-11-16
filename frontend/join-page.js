/**
 * The online site's explanation page for an invitation link, `/join#<payload>`. The payload stays in the URL fragment,
 * which browsers never send to the server: this page reads it locally and shows only who invites, to which room, what
 * is opened and until when (never a path), then hands the whole link to this computer's own CoDiscuss.
 *
 * Built into web/join.html as one self-contained file (vite.config.mjs, join_page()), so it needs no other asset of
 * the site; JOIN_DICTIONARY is filled in at build time with the English entries this file uses.
 */
/* global JOIN_DICTIONARY */
(function () {
  const LOCAL_SITE = "http://127.0.0.1:8765";
  const STORAGE_KEY = "codiscuss.locale";
  const english = (() => {
    let saved = "";
    try { saved = localStorage.getItem(STORAGE_KEY) || ""; } catch { /* storage blocked */ }
    if (saved) return saved === "en";
    return !/^zh\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || "");
  })();
  const dictionary = english && typeof JOIN_DICTIONARY === "object" ? JOIN_DICTIONARY : {};
  function t(source, params) {
    const text = dictionary[source] || source;
    return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
  }
  document.documentElement.lang = english ? "en" : "zh-CN";

  /** The invitation the fragment carries: base64url JSON; anything else is kept only as the link to hand over. */
  function read_payload() {
    const raw = decodeURIComponent((location.hash || "").replace(/^#(join=)?/, ""));
    if (!raw) return null;
    try {
      const text = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch { return {}; }
  }
  const time = (value) => {
    if (!value) return "";
    const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
    return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString(english ? "en" : "zh-CN", { hour12: false });
  };
  const LEVELS = { discuss: t("只讨论：只看点名给它的请求并回答"), read: t("讨论 + 只读项目：另可读对方开放的目录，不能写入或执行") };

  function element(tag, attributes = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    }
    for (const child of children) if (child) node.append(child);
    return node;
  }

  function render() {
    document.title = t("加入共议房间 · AI CoDiscuss");
    const root = document.getElementById("join-root");
    root.replaceChildren();
    const payload = read_payload();
    if (!payload) {
      root.append(element("h1", { text: t("没有邀请内容") }), element("p", { text: t("请打开对方发来的完整链接，或在自己的共议里输入配对码。") }));
      return;
    }
    // Payload fields: 子Task2 CONTRACT §2.1 (`expires_at` is when the link stops working, not the membership).
    const facts = [
      [t("邀请人的电脑"), payload.machine_name || ""],
      [t("房间"), payload.room_name || ""],
      [t("开放"), LEVELS[payload.level] || ""],
      [t("链接须在此前兑换"), time(payload.expires_at)],
    ].filter(([, value]) => value);
    const link = location.href;
    const copy_button = element("button", { type: "button", class: "secondary", text: t("复制邀请链接"), onclick: async () => {
      try { await navigator.clipboard.writeText(link); copy_button.textContent = t("已复制"); }
      catch { copy_button.textContent = t("复制失败，请手动复制地址栏"); }
    } });
    root.append(
      element("h1", { text: t("你被邀请让自己的 AI 加入一个共议房间") }),
      element("dl", {}, facts.flatMap(([label, value]) => [element("dt", { text: label }), element("dd", { text: value })])),
      element("p", { class: "note", text: t("你的 AI 在你自己的电脑上运行，用你自己的账号与额度；对方点名后，默认先问你同意才唤醒。") }),
      element("p", { class: "note", text: t("对方开放的项目内容会经你的 AI 发送给它的模型服务商。") }),
      element("div", { class: "actions" }, [
        element("a", { class: "primary", href: `${LOCAL_SITE}/#join=${encodeURIComponent(link)}`, text: t("用本机共议加入") }),
        copy_button,
      ]),
      element("p", { class: "fine", text: t("按钮打开这台电脑上的共议（需已安装并运行 codiscuss）。也可以复制链接，在共议左栏“被邀请的房间”里粘贴，或运行 codiscuss join。") }),
      element("p", { class: "fine", text: t("邀请内容只在地址的 # 之后，浏览器不会把它发给网站。") }),
    );
  }
  render();
  window.addEventListener("hashchange", render);
})();
