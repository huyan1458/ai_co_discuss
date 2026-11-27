/**
 * The online site's explanation page for an invitation link, `/join#<payload>`. The payload stays in the URL fragment,
 * which browsers never send to the server: this page reads it locally and shows only who invites, to which room, what
 * is opened and until when (never a path or the code), then hands the whole link to this computer's own CoDiscuss.
 *
 * Built into web/join.html as one self-contained file (vite.config.mjs, join_page()), so it needs no other asset of
 * the site; JOIN_DICTIONARY (the English entries this file uses) and JOIN_ICON (the site icon) are filled in at build time.
 */
/* global JOIN_DICTIONARY, JOIN_ICON */
(function () {
  const LOCAL_SITE = "http://127.0.0.1:8765";
  const STORAGE_KEY = "codiscuss.locale";
  // The site's own theme choice (web/app.js THEME_STORAGE_KEY); without one the page follows the system.
  const THEME_KEY = "ai-codiscuss-theme";
  const saved = (key) => { try { return localStorage.getItem(key) || ""; } catch { return ""; } };
  const english = (() => {
    const locale = saved(STORAGE_KEY);
    if (locale) return locale === "en";
    return !/^zh\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || "");
  })();
  const dictionary = english && typeof JOIN_DICTIONARY === "object" ? JOIN_DICTIONARY : {};
  function t(source, params) {
    const text = dictionary[source] || source;
    return params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text;
  }
  document.documentElement.lang = english ? "en" : "zh-CN";
  const theme = saved(THEME_KEY);
  if (theme) document.documentElement.dataset.theme = theme.endsWith("-light") ? "light" : "dark";

  /** The invitation the fragment carries: base64url JSON; null without a fragment, {} when it cannot be read. */
  function read_payload() {
    const raw = (location.hash || "").replace(/^#(join=)?/, "");
    if (!raw) return null;
    try {
      const text = atob(decodeURIComponent(raw).replace(/-/g, "+").replace(/_/g, "/"));
      const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return value && typeof value === "object" ? value : {};
    } catch { return {}; }
  }
  const to_ms = (value) => (typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value));
  const time = (value) => {
    const ms = value ? to_ms(value) : NaN;
    return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString(english ? "en" : "zh-CN", { hour12: false });
  };
  const LEVELS = { discuss: t("房间消息：只看点名给它的消息"), read: t("消息和项目：另可只读对方开放的目录") };

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

  const brand = () => element("header", { class: "brand" }, [
    typeof JOIN_ICON === "string" && JOIN_ICON ? element("img", { src: JOIN_ICON, alt: "" }) : null,
    element("strong", { text: t("共议") }), element("span", { text: "AI CoDiscuss" }),
  ]);

  /** No invitation to show: a missing fragment and one that cannot be read share one layout, with what to do next. */
  function empty_state(title, detail, fine) {
    return element("section", { class: "card empty", role: "status" }, [
      element("h1", { text: title }),
      element("p", { text: detail }),
      fine ? element("p", { class: "fine", text: fine }) : null,
    ]);
  }

  function invitation(payload) {
    // Payload fields: 子Task2 CONTRACT §2.1 (`expires_at` is when the link stops working, not the membership).
    const facts = [
      [t("邀请人的电脑"), payload.machine_name || ""],
      [t("房间"), payload.room_name || ""],
      [t("开放"), LEVELS[payload.level] || ""],
      [t("链接须在此前兑换"), time(payload.expires_at)],
    ].filter(([, value]) => value);
    const expired = payload.expires_at && to_ms(payload.expires_at) <= Date.now();
    const link = location.href;
    const copy_button = element("button", { type: "button", class: "button secondary", text: t("复制邀请链接"), onclick: async () => {
      try { await navigator.clipboard.writeText(link); copy_button.textContent = t("已复制"); }
      catch { copy_button.textContent = t("复制失败，请手动复制地址栏"); }
    } });
    return element("section", { class: "card" }, [
      element("h1", { text: t("你被邀请让自己的 AI 加入一个共议房间") }),
      element("dl", {}, facts.flatMap(([label, value]) => [element("dt", { text: label }), element("dd", { text: value })])),
      expired ? element("p", { class: "warning", role: "status", text: t("这个链接已过期，请让对方重新生成邀请。") }) : null,
      element("ul", { class: "notes" }, [
        element("li", { text: t("你的 AI 在你自己的电脑上运行，用你自己的账号与额度；加入后对方点名即唤醒，受次数与期限上限约束。") }),
        element("li", { text: t("对方开放的项目内容会经你的 AI 发送给它的模型服务商。") }),
      ]),
      element("div", { class: "actions" }, [
        element("a", { class: "button primary", href: `${LOCAL_SITE}/#join=${encodeURIComponent(link)}`, text: t("用本机共议加入") }),
        copy_button,
      ]),
      element("p", { class: "fine", text: t("按钮打开这台电脑上的共议（需已安装并运行 codiscuss）。也可以复制链接，在共议左栏“外部房间”里粘贴，或运行 codiscuss join。") }),
      element("p", { class: "fine", text: t("旧版客户端若提示找不到电脑，请更新 AI CoDiscuss，再打开这个邀请链接。") }),
      element("p", { class: "fine", text: t("邀请内容只在地址的 # 之后，浏览器不会把它发给网站。") }),
    ]);
  }

  function render() {
    document.title = t("加入共议房间 · AI CoDiscuss");
    const root = document.getElementById("join-root");
    root.replaceChildren();
    const payload = read_payload();
    // A link without the code or the computer cannot be redeemed, so it is shown as unreadable rather than as an invitation.
    const body = !payload
      ? empty_state(t("没有邀请内容"), t("请打开对方发来的完整链接。"))
      : !payload.code || !payload.machine
        ? empty_state(t("无法读取这个邀请链接"), t("链接可能被截断或改动过。请让对方重新复制完整链接发给你。"))
        : invitation(payload);
    root.append(brand(), body);
  }
  render();
  window.addEventListener("hashchange", render);
})();
