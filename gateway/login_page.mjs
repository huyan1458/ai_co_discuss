/**
 * The entry's sign-in page: one self-contained document (no files, no network), so it opens before anything else is up.
 * It works without scripts; the script adds the language and appearance settings, which use the workspace's own storage
 * keys, so what is chosen here is what the workspace opens with.
 */

const LOGO_DARK = `<defs><linearGradient id="brand-d0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#e9ebed"/><stop offset="6.3%" stop-color="#e2e5e7"/><stop offset="12.5%" stop-color="#dcdee1"/><stop offset="18.8%" stop-color="#d5d8db"/><stop offset="25.0%" stop-color="#ced2d5"/><stop offset="31.3%" stop-color="#c8cbcf"/><stop offset="37.5%" stop-color="#c1c5ca"/><stop offset="43.8%" stop-color="#babfc4"/><stop offset="50.0%" stop-color="#b4b9be"/><stop offset="56.3%" stop-color="#a9aeb3"/><stop offset="62.5%" stop-color="#9ea3a9"/><stop offset="68.8%" stop-color="#93999f"/><stop offset="75.0%" stop-color="#888e95"/><stop offset="81.3%" stop-color="#7e848a"/><stop offset="87.5%" stop-color="#737a80"/><stop offset="93.8%" stop-color="#697077"/><stop offset="100.0%" stop-color="#5f666d"/></linearGradient><linearGradient id="brand-d1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#3f86ff"/><stop offset="6.3%" stop-color="#5588ff"/><stop offset="12.5%" stop-color="#6889ff"/><stop offset="18.8%" stop-color="#788aff"/><stop offset="25.0%" stop-color="#878bff"/><stop offset="31.3%" stop-color="#958cff"/><stop offset="37.5%" stop-color="#a78aef"/><stop offset="43.8%" stop-color="#b986d7"/><stop offset="50.0%" stop-color="#ca80bf"/><stop offset="56.3%" stop-color="#da78a6"/><stop offset="62.5%" stop-color="#ea6e8c"/><stop offset="68.8%" stop-color="#f56d78"/><stop offset="75.0%" stop-color="#f77f72"/><stop offset="81.3%" stop-color="#f8906b"/><stop offset="87.5%" stop-color="#f9a163"/><stop offset="93.8%" stop-color="#fab058"/><stop offset="100.0%" stop-color="#fac04a"/></linearGradient><linearGradient id="brand-d2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#d06a49"/><stop offset="6.3%" stop-color="#d36f4f"/><stop offset="12.5%" stop-color="#d67456"/><stop offset="18.8%" stop-color="#d97a5c"/><stop offset="25.0%" stop-color="#dc7f62"/><stop offset="31.3%" stop-color="#df8468"/><stop offset="37.5%" stop-color="#e2896e"/><stop offset="43.8%" stop-color="#e58e74"/><stop offset="50.0%" stop-color="#e8937a"/><stop offset="56.3%" stop-color="#eb9d85"/><stop offset="62.5%" stop-color="#eea68f"/><stop offset="68.8%" stop-color="#f1b09a"/><stop offset="75.0%" stop-color="#f4baa4"/><stop offset="81.3%" stop-color="#f6c3af"/><stop offset="87.5%" stop-color="#f9cdb9"/><stop offset="93.8%" stop-color="#fbd6c4"/><stop offset="100.0%" stop-color="#fde0cf"/></linearGradient><linearGradient id="brand-d3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#4a5cff"/><stop offset="6.3%" stop-color="#5062ff"/><stop offset="12.5%" stop-color="#5768ff"/><stop offset="18.8%" stop-color="#5d6dff"/><stop offset="25.0%" stop-color="#6472ff"/><stop offset="31.3%" stop-color="#6b77ff"/><stop offset="37.5%" stop-color="#717cff"/><stop offset="43.8%" stop-color="#7881ff"/><stop offset="50.0%" stop-color="#7f86ff"/><stop offset="56.3%" stop-color="#8990ff"/><stop offset="62.5%" stop-color="#9399ff"/><stop offset="68.8%" stop-color="#9da2ff"/><stop offset="75.0%" stop-color="#a8abff"/><stop offset="81.3%" stop-color="#b3b4ff"/><stop offset="87.5%" stop-color="#bebdff"/><stop offset="93.8%" stop-color="#c9c5ff"/><stop offset="100.0%" stop-color="#d4ceff"/></linearGradient><clipPath id="brand-d4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-d5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-d6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-d7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-d8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-d9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-d10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-d11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-d4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-d2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-d1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-d3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-d10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#202127" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-d11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-d0)" stroke-width="15" stroke-linecap="round"/></g>`;
const LOGO_LIGHT = `<defs><linearGradient id="brand-l0" gradientUnits="userSpaceOnUse" x1="4.5" y1="64" x2="95.5" y2="64"><stop offset="0.0%" stop-color="#0b0d0f"/><stop offset="6.3%" stop-color="#101315"/><stop offset="12.5%" stop-color="#16191b"/><stop offset="18.8%" stop-color="#1c1f22"/><stop offset="25.0%" stop-color="#222529"/><stop offset="31.3%" stop-color="#282c2f"/><stop offset="37.5%" stop-color="#2e3237"/><stop offset="43.8%" stop-color="#34393e"/><stop offset="50.0%" stop-color="#3b4045"/><stop offset="56.3%" stop-color="#484d52"/><stop offset="62.5%" stop-color="#555a5f"/><stop offset="68.8%" stop-color="#62676d"/><stop offset="75.0%" stop-color="#70757b"/><stop offset="81.3%" stop-color="#7e8389"/><stop offset="87.5%" stop-color="#8c9297"/><stop offset="93.8%" stop-color="#9aa0a6"/><stop offset="100.0%" stop-color="#a9afb5"/></linearGradient><linearGradient id="brand-l1" gradientUnits="userSpaceOnUse" x1="8.5" y1="36" x2="91.5" y2="36"><stop offset="0.0%" stop-color="#2f7bff"/><stop offset="6.3%" stop-color="#487cff"/><stop offset="12.5%" stop-color="#5a7cff"/><stop offset="18.8%" stop-color="#6a7dff"/><stop offset="25.0%" stop-color="#797dff"/><stop offset="31.3%" stop-color="#877dff"/><stop offset="37.5%" stop-color="#997cee"/><stop offset="43.8%" stop-color="#ae79d3"/><stop offset="50.0%" stop-color="#c174b8"/><stop offset="56.3%" stop-color="#d36b9d"/><stop offset="62.5%" stop-color="#e56080"/><stop offset="68.8%" stop-color="#f15d69"/><stop offset="75.0%" stop-color="#f37162"/><stop offset="81.3%" stop-color="#f5835a"/><stop offset="87.5%" stop-color="#f79550"/><stop offset="93.8%" stop-color="#f8a542"/><stop offset="100.0%" stop-color="#f8b52c"/></linearGradient><linearGradient id="brand-l2" gradientUnits="userSpaceOnUse" x1="28.021" y1="95.435" x2="39.978" y2="4.564"><stop offset="0.0%" stop-color="#b9502f"/><stop offset="6.3%" stop-color="#bd5534"/><stop offset="12.5%" stop-color="#c15a39"/><stop offset="18.8%" stop-color="#c55f3e"/><stop offset="25.0%" stop-color="#c96443"/><stop offset="31.3%" stop-color="#cd6848"/><stop offset="37.5%" stop-color="#d16d4d"/><stop offset="43.8%" stop-color="#d57252"/><stop offset="50.0%" stop-color="#d97757"/><stop offset="56.3%" stop-color="#dd8060"/><stop offset="62.5%" stop-color="#e08a69"/><stop offset="68.8%" stop-color="#e49372"/><stop offset="75.0%" stop-color="#e79c7b"/><stop offset="81.3%" stop-color="#eaa584"/><stop offset="87.5%" stop-color="#edae8d"/><stop offset="93.8%" stop-color="#f0b796"/><stop offset="100.0%" stop-color="#f3c09f"/></linearGradient><linearGradient id="brand-l3" gradientUnits="userSpaceOnUse" x1="71.978" y1="95.435" x2="60.021" y2="4.564"><stop offset="0.0%" stop-color="#2b33e6"/><stop offset="6.3%" stop-color="#3139e9"/><stop offset="12.5%" stop-color="#363fec"/><stop offset="18.8%" stop-color="#3c44ef"/><stop offset="25.0%" stop-color="#4249f3"/><stop offset="31.3%" stop-color="#484ef6"/><stop offset="37.5%" stop-color="#4e53f9"/><stop offset="43.8%" stop-color="#5457fc"/><stop offset="50.0%" stop-color="#5a5cff"/><stop offset="56.3%" stop-color="#6569ff"/><stop offset="62.5%" stop-color="#7075ff"/><stop offset="68.8%" stop-color="#7c80ff"/><stop offset="75.0%" stop-color="#888bff"/><stop offset="81.3%" stop-color="#9595ff"/><stop offset="87.5%" stop-color="#a29fff"/><stop offset="93.8%" stop-color="#afa9ff"/><stop offset="100.0%" stop-color="#bdb3ff"/></linearGradient><clipPath id="brand-l4"><polygon points="16,46.5 84,46.5 84,25.5 16,25.5"/></clipPath><clipPath id="brand-l5"><polygon points="16,48.5 84,48.5 84,23.5 16,23.5"/></clipPath><clipPath id="brand-l6"><polygon points="81.410,86.630 71.410,10.630 50.589,13.369 60.589,89.369"/></clipPath><clipPath id="brand-l7"><polygon points="83.393,86.369 73.393,10.369 48.606,13.630 58.606,89.630"/></clipPath><clipPath id="brand-l8"><polygon points="12,74.5 88,74.5 88,53.5 12,53.5"/></clipPath><clipPath id="brand-l9"><polygon points="12,76.5 88,76.5 88,51.5 12,51.5"/></clipPath><clipPath id="brand-l10"><polygon points="39.410,89.369 49.410,13.369 28.589,10.630 18.589,86.630"/></clipPath><clipPath id="brand-l11"><polygon points="41.393,89.630 51.393,13.630 26.606,10.369 16.606,86.369"/></clipPath></defs><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/><g clip-path="url(#brand-l4)"><line x1="29" y1="88" x2="39" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l5)"><line x1="29" y1="88" x2="39" y2="12" stroke="url(#brand-l2)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l6)"><line x1="16" y1="36" x2="84" y2="36" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l7)"><line x1="16" y1="36" x2="84" y2="36" stroke="url(#brand-l1)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l8)"><line x1="71" y1="88" x2="61" y2="12" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l9)"><line x1="71" y1="88" x2="61" y2="12" stroke="url(#brand-l3)" stroke-width="15" stroke-linecap="round"/></g><g clip-path="url(#brand-l10)"><line x1="12" y1="64" x2="88" y2="64" stroke="#f6f6f6" stroke-width="21" stroke-linecap="round"/></g><g clip-path="url(#brand-l11)"><line x1="12" y1="64" x2="88" y2="64" stroke="url(#brand-l0)" stroke-width="15" stroke-linecap="round"/></g>`;

// Every text in both languages. A refusal is sent as a key, so the page can say it in the language chosen in this browser.
const TEXTS = {
  'zh-CN': {
    page_title: '登录 · AI CoDiscuss', tagline: '让你的 AI，在同一个房间里协作',
    tagline_detail: '各自保留原来的会话与工具，一起把事情做完。', heading: '欢迎回来', subheading: '登录后进入你的工作台',
    name: '账号', password: '密码', show_password: '显示密码', hide_password: '隐藏密码', submit: '登录', submitting: '正在登录…',
    help: '账号由为你开通服务的人提供，忘记密码也请联系对方。', settings: '设置', language: '语言', appearance: '外观',
    theme_light: '浅色', theme_dark: '深色',
    wrong: '账号或密码不正确', locked: '尝试次数过多，请 10 分钟后再试', disabled: '这个账号已停用，请联系为你开通的服务商',
  },
  en: {
    page_title: 'Sign in · AI CoDiscuss', tagline: 'Your AIs, working together in one room',
    tagline_detail: 'Each keeps its own sessions and tools, and they get the work done together.', heading: 'Welcome back',
    subheading: 'Sign in to open your workspace', name: 'Account', password: 'Password', show_password: 'Show password',
    hide_password: 'Hide password', submit: 'Sign in', submitting: 'Signing in…',
    help: 'Your account comes from whoever set up this service for you. Ask them if you forget your password.', settings: 'Settings',
    language: 'Language', appearance: 'Appearance', theme_light: 'Light', theme_dark: 'Dark',
    wrong: 'Incorrect account or password', locked: 'Too many attempts. Try again in 10 minutes.',
    disabled: 'This account is disabled. Please contact your service provider.',
  },
};

// Threads running in from the edges to the mark: several AIs meeting in one room. [path, colour, seconds, delay]
const THREADS = [
  ['M-40 120C160 150 250 300 400 450', '#3f86ff', 7, 0], ['M840 90C660 160 540 300 400 450', '#f8906b', 8, 1.4],
  ['M-40 800C140 720 270 590 400 450', '#fac04a', 9, 2.6], ['M840 820C650 740 530 590 400 450', '#7881ff', 7.5, 0.8],
  ['M-40 450C120 420 260 440 400 450', '#ca80bf', 10, 3.2], ['M840 460C680 480 540 450 400 450', '#5588ff', 8.5, 2],
  ['M250 -40C270 130 330 290 400 450', '#d97757', 9.5, 4], ['M560 940C530 760 460 600 400 450', '#958cff', 8, 3.6],
];

const escape_html = text => String(text).replace(/[&<>"']/g, mark => `&#${mark.charCodeAt(0)};`);

const threads_svg = () => THREADS.map(([path, colour, seconds, delay]) => `<path class="thread" d="${path}"/>`
  + `<path class="pulse" d="${path}" pathLength="100" stroke="${colour}" style="animation-duration:${seconds}s;animation-delay:-${delay}s"/>`).join('');

const STYLE = `
:root{color-scheme:light;--bg:#f6f6f6;--panel:#ececef;--field:#fff;--line:#d9d9de;--line-strong:#b9b9c2;--text:#1b1c20;--muted:#61636d;--dim:#767885;--accent:#4f51e8;--accent-text:#fff;--danger:#b4243d;--danger-bg:#c4314b14;--thread:#1b1c2014;--shadow:0 16px 40px #1b1c2024}
:root[data-mode=dark]{color-scheme:dark;--bg:#202127;--panel:#191a1f;--field:#2a2b32;--line:#393a43;--line-strong:#50515c;--text:#f1f2f5;--muted:#a8abb6;--dim:#8d909e;--accent:#8791ff;--accent-text:#14151a;--danger:#ff8a9b;--danger-bg:#ff8a9b18;--thread:#ffffff12;--shadow:0 16px 40px #0007}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
.entry{min-height:100%;display:grid;grid-template-columns:minmax(0,1.15fr) minmax(420px,1fr)}
.stage{position:relative;overflow:hidden;background:var(--panel);display:flex;flex-direction:column;justify-content:flex-end;padding:48px 56px}
.threads{position:absolute;inset:0;width:100%;height:100%}
.thread,.pulse{fill:none;stroke-linecap:round}.thread{stroke:var(--thread);stroke-width:1.5}
.pulse{stroke-width:2.5;stroke-dasharray:14 86;stroke-dashoffset:100;animation:flow linear infinite}
@keyframes flow{to{stroke-dashoffset:0}}
.emblem{position:absolute;left:50%;top:50%;width:132px;height:132px;margin:-66px 0 0 -66px;display:grid;place-items:center;border-radius:32px;background:var(--bg);box-shadow:var(--shadow);animation:arrive .8s cubic-bezier(.2,.9,.3,1.2) both}
.emblem::before,.emblem::after{content:"";position:absolute;inset:0;border-radius:32px;border:1.5px solid var(--accent);opacity:0;animation:ring 4.5s ease-out infinite}
.emblem::after{animation-delay:2.25s}
.emblem svg{width:88px;height:88px}
@keyframes arrive{from{opacity:0;transform:scale(.72)}}
@keyframes ring{0%{opacity:.45;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.7)}}
.logo-light,:root[data-mode=dark] .logo-dark{display:block}.logo-dark,:root[data-mode=dark] .logo-light{display:none}
.pitch{position:relative;max-width:460px;animation:rise .7s .15s ease-out both}
.pitch h2{margin:0 0 8px;font-size:26px;line-height:1.3;font-weight:650;letter-spacing:-.01em}.pitch p{margin:0;color:var(--muted)}
.side{position:relative;display:grid;place-items:center;padding:72px 32px 40px}
.card{width:min(360px,100%);animation:rise .6s .05s ease-out both}
@keyframes rise{from{opacity:0;transform:translateY(14px)}}
.wordmark{display:flex;align-items:center;gap:10px;margin-bottom:32px;font-weight:650}.wordmark svg{width:28px;height:28px}
h1{margin:0;font-size:28px;line-height:1.25;font-weight:680;letter-spacing:-.015em}.sub{margin:6px 0 26px;color:var(--muted)}
.notice{display:flex;gap:8px;align-items:flex-start;margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--danger-bg);color:var(--danger);font-size:14px;animation:nudge .36s ease-out}
.notice svg{flex:none;width:17px;height:17px;margin-top:2px}
@keyframes nudge{25%{transform:translateX(-6px)}50%{transform:translateX(5px)}75%{transform:translateX(-3px)}}
label{display:block;margin-bottom:16px}label>span:first-child{display:block;margin-bottom:6px;font-size:13px;font-weight:550;color:var(--muted)}
.field{position:relative;display:block}
input{width:100%;height:46px;padding:0 14px;border:1px solid var(--line);border-radius:10px;background:var(--field);outline:0;font-size:16px;transition:border-color .15s,box-shadow .15s}
input:hover{border-color:var(--line-strong)}input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 24%,transparent)}
.has-toggle input{padding-right:46px}
.icon-button{display:grid;place-items:center;width:36px;height:36px;padding:0;border:0;border-radius:8px;background:none;color:var(--muted);cursor:pointer;transition:background .15s,color .15s}
.icon-button:hover{background:color-mix(in srgb,var(--text) 9%,transparent);color:var(--text)}.icon-button svg{width:18px;height:18px}
.reveal{position:absolute;right:5px;top:5px}.reveal .eye-off,.reveal[aria-pressed=true] .eye{display:none}.reveal[aria-pressed=true] .eye-off{display:block}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input:focus-visible{outline:0}
.submit{position:relative;width:100%;height:46px;margin-top:6px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-text);font-weight:620;cursor:pointer;transition:filter .15s,transform .1s}
.submit:hover{filter:brightness(1.08)}.submit:active{transform:scale(.985)}.submit[disabled]{cursor:progress;filter:saturate(.7);opacity:.85}
.spinner{display:none;width:16px;height:16px;margin-right:8px;vertical-align:-3px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}
.submit[disabled] .spinner{display:inline-block}@keyframes spin{to{transform:rotate(1turn)}}
.help{margin:18px 0 0;color:var(--dim);font-size:13px}
.settings{position:absolute;right:20px;top:20px;z-index:2}.settings>.icon-button{width:40px;height:40px}
.menu{position:absolute;right:0;top:46px;width:260px;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--field);box-shadow:var(--shadow);transform-origin:top right;animation:pop .16s ease-out}
.menu[hidden]{display:none}@keyframes pop{from{opacity:0;transform:scale(.96) translateY(-4px)}}
.menu fieldset{margin:0;padding:0;border:0}.menu fieldset+fieldset{margin-top:14px}.menu legend{padding:0;margin-bottom:6px;font-size:12px;font-weight:600;color:var(--muted)}
.choices{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:2px;padding:3px;border-radius:9px;background:color-mix(in srgb,var(--text) 7%,transparent)}
.choices button{height:32px;padding:0 6px;border:0;border-radius:7px;background:none;color:var(--muted);font-size:13px;cursor:pointer;white-space:nowrap}
.choices button[aria-pressed=true]{background:var(--bg);color:var(--text);font-weight:600;box-shadow:0 1px 3px #0003}
@media (max-width:860px){.entry{grid-template-columns:1fr;grid-template-rows:auto 1fr}.stage{height:176px;padding:0}.pitch{display:none}.emblem{width:84px;height:84px;margin:-42px 0 0 -42px;border-radius:22px}.emblem::before,.emblem::after{border-radius:22px}.emblem svg{width:56px;height:56px}.side{place-items:start center;padding:28px 24px 36px}.wordmark{display:none}.settings{position:fixed;right:12px;top:12px}}
`;

// Runs before the first paint, so the page never flashes the other theme or language.
const EARLY_SCRIPT = `(function(){var d=document.documentElement,g=function(k){try{return localStorage.getItem(k)||""}catch(e){return""}},t=g("ai-codiscuss-theme"),l=g("codiscuss.locale");
d.dataset.mode=t?(/light$/.test(t)?"light":"dark"):(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
d.lang=l==="en"||l==="zh-CN"?l:(/^zh\\b/i.test((navigator.languages&&navigator.languages[0])||navigator.language||"")?"zh-CN":"en")})()`;

const PAGE_SCRIPT = `(function(){var T=__TEXTS__,LOCALE="codiscuss.locale",THEME="ai-codiscuss-theme",d=document.documentElement,$=function(s){return document.querySelector(s)},$$=function(s){return Array.prototype.slice.call(document.querySelectorAll(s))};
function get(k){try{return localStorage.getItem(k)||""}catch(e){return""}}function put(k,v){try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch(e){}}
var dark=matchMedia("(prefers-color-scheme: dark)"),menu=$("#settings-menu"),gear=$("#settings-button"),form=$("#login"),pass=$("#password"),eye=$("#reveal"),send=$("#submit");
function say(){var t=T[d.lang]||T["zh-CN"];document.title=t.page_title;$$("[data-text]").forEach(function(n){n.textContent=t[n.dataset.text]});$$("[data-label]").forEach(function(n){n.setAttribute("aria-label",t[n.dataset.label]);n.title=t[n.dataset.label]});var e=t[pass.type==="text"?"hide_password":"show_password"];eye.setAttribute("aria-label",e);eye.title=e;$$("[data-locale]").forEach(function(n){n.setAttribute("aria-pressed",String(n.dataset.locale===d.lang))})}
function paint(){var saved=get(THEME),mode=saved?(/light$/.test(saved)?"light":"dark"):(dark.matches?"dark":"light");d.dataset.mode=mode;$$("[data-theme-choice]").forEach(function(n){n.setAttribute("aria-pressed",String(n.dataset.themeChoice===mode))})}
function show_menu(show){menu.hidden=!show;gear.setAttribute("aria-expanded",String(show))}
gear.addEventListener("click",function(e){e.stopPropagation();show_menu(menu.hidden)});menu.addEventListener("click",function(e){e.stopPropagation()});document.addEventListener("click",function(){show_menu(false)});document.addEventListener("keydown",function(e){if(e.key==="Escape"&&!menu.hidden){show_menu(false);gear.focus()}});
$$("[data-locale]").forEach(function(n){n.addEventListener("click",function(){d.lang=n.dataset.locale;put(LOCALE,d.lang);say()})});
$$("[data-theme-choice]").forEach(function(n){n.addEventListener("click",function(){put(THEME,n.dataset.themeChoice==="light"?"channel-light":"channel");paint()})});
dark.addEventListener("change",paint);
eye.addEventListener("click",function(){var show=pass.type==="password";pass.type=show?"text":"password";eye.setAttribute("aria-pressed",String(show));say();pass.focus()});
form.addEventListener("submit",function(){send.disabled=true;var l=$("#submit-label");l.dataset.text="submitting";l.textContent=(T[d.lang]||T["zh-CN"]).submitting});
window.addEventListener("pageshow",function(e){if(e.persisted){send.disabled=false;$("#submit-label").dataset.text="submit";say()}});
say();paint();if(matchMedia("(hover: hover)").matches){var first=$("#name");(first.value?pass:first).focus()}})()`;

const ICON = {
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  eye: '<svg class="eye" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eye_off: '<svg class="eye-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.6A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.5 6.9A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.3-1.1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/></svg>',
};

/**
 * The sign-in page.
 * @param {object} options
 * @param {string} options.action Where the form posts.
 * @param {'wrong'|'locked'|'disabled'} [options.refusal] Why the last attempt was refused.
 * @param {string} [options.name] The account just tried, kept in its field.
 * @returns {string} The whole HTML document.
 */
export function login_page({ action, refusal = '', name = '' }) {
  const zh = TEXTS['zh-CN'];
  const text = key => `data-text="${key}">${zh[key]}`;
  const logos = `<svg class="logo-dark" viewBox="0 0 100 100" aria-hidden="true">${LOGO_DARK}</svg><svg class="logo-light" viewBox="0 0 100 100" aria-hidden="true">${LOGO_LIGHT}</svg>`;
  const small_logos = logos.replaceAll('brand-d', 'small-d').replaceAll('brand-l', 'small-l');
  const notice = refusal ? `<p class="notice" role="alert">${ICON.alert}<span ${text(refusal)}</span></p>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${zh.page_title}</title><script>${EARLY_SCRIPT}</script><style>${STYLE}</style></head><body><main class="entry">
<section class="stage"><svg class="threads" viewBox="0 0 800 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${threads_svg()}</svg><div class="emblem" aria-hidden="true">${logos}</div>
<div class="pitch"><h2 ${text('tagline')}</h2><p ${text('tagline_detail')}</p></div></section>
<section class="side"><div class="settings"><button id="settings-button" class="icon-button" type="button" aria-expanded="false" aria-controls="settings-menu" data-label="settings" aria-label="${zh.settings}" title="${zh.settings}">${ICON.settings}</button>
<div id="settings-menu" class="menu" hidden><fieldset><legend ${text('language')}</legend><div class="choices"><button type="button" data-locale="zh-CN">简体中文</button><button type="button" data-locale="en">English</button></div></fieldset>
<fieldset><legend ${text('appearance')}</legend><div class="choices"><button type="button" data-theme-choice="light" ${text('theme_light')}</button><button type="button" data-theme-choice="dark" ${text('theme_dark')}</button></div></fieldset></div></div>
<div class="card"><div class="wordmark">${small_logos}<span>AI CoDiscuss</span></div><h1 ${text('heading')}</h1><p class="sub" ${text('subheading')}</p>${notice}
<form id="login" method="post" action="${action}"><label><span ${text('name')}</span><span class="field"><input id="name" name="name" value="${escape_html(name)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></span></label>
<label><span ${text('password')}</span><span class="field has-toggle"><input id="password" name="password" type="password" autocomplete="current-password" required><button id="reveal" class="icon-button reveal" type="button" aria-pressed="false" aria-label="${zh.show_password}" title="${zh.show_password}">${ICON.eye}${ICON.eye_off}</button></span></label>
<button id="submit" class="submit" type="submit"><i class="spinner" aria-hidden="true"></i><span id="submit-label" ${text('submit')}</span></button></form><p class="help" ${text('help')}</p></div></section></main>
<script>${PAGE_SCRIPT.replace('__TEXTS__', () => JSON.stringify(TEXTS))}</script></body></html>`;
}
