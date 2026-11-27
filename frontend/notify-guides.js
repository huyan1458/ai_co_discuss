/**
 * The setup guide each bot notification channel shows before it is configured: what it needs, where to get the
 * credentials (with the platform's own pages), and any risk. The same steps, in more detail, are in the notify-setup
 * skill; the last line of every guide points there for owners who would rather be walked through by their AI.
 */
import { t } from './i18n.js';

/**
 * The guide for one channel id, or null for a channel without one.
 *
 * @param {string} id The channel id from `launch notify`.
 * @returns {{intro: string, steps: string[], links: {label: string, url: string}[], warning?: string}|null}
 */
export function channel_guide(id) {
  const guides = {
    telegram: {
      intro: t('最省事的渠道：建一个 Telegram 机器人即可，随时能主动提醒你。'),
      steps: [t('在 Telegram 打开 @BotFather，发送 /newbot，按提示起名，复制它给出的 Bot Token。'),
        t('把 Bot Token 填到下面，点“保存并验证”。这个 Token 只给共议用，不要同时给别的程序。')],
      links: [{ label: t('打开 @BotFather'), url: 'https://t.me/BotFather' }],
    },
    discord: {
      intro: t('需要一个你自己管理的 Discord 服务器来安装机器人。'),
      steps: [t('在 Discord 开发者后台新建应用，进入 Bot 页，重置并复制 Bot Token；同一页打开 Message Content Intent。'),
        t('在 Installation 页用 bot 权限范围生成安装链接，把机器人加进你管理的服务器，并允许该服务器的成员私聊你。'),
        t('把 Bot Token 填到下面，点“保存并验证”。')],
      links: [{ label: t('打开 Discord 开发者后台'), url: 'https://discord.com/developers/applications' }],
    },
    qq: {
      intro: t('QQ 官方机器人。个人账号能否主动给你发消息取决于平台权限，以“发送测试”能否收到为准。'),
      steps: [t('在 QQ 开放平台创建机器人，在开发设置里复制 AppID 和 AppSecret。'),
        t('确认机器人能接收单聊消息；如开了 IP 白名单，加入这台电脑的公网出口 IP。'),
        t('把 AppID 和 AppSecret 填到下面，点“保存并验证”。')],
      links: [{ label: t('打开 QQ 开放平台'), url: 'https://q.qq.com/' }],
    },
    onebot: {
      intro: t('用一个 QQ 小号当机器人，能随时私聊你。需要你先运行 NapCat 等 OneBot 程序登录这个小号。'),
      steps: [t('准备一个专用 QQ 小号，安装并运行 NapCat（或 SnowLuma、LLOneBot），用小号扫码登录。'),
        t('在 NapCat 的网络配置里新建“WebSocket 服务器”：地址 127.0.0.1，端口如 3001，设置一个访问令牌。'),
        t('把地址（如 ws://127.0.0.1:3001）和访问令牌填到下面，点“保存并验证”，再用你自己的 QQ 私聊小号发送绑定码。')],
      links: [{ label: t('打开 NapCat 文档'), url: 'https://napneko.github.io/' }],
      warning: t('非官方协议：登录可能失效需要重新扫码，账号有被限制的风险；QQ 客户端常驻约占 500 MB 内存。'),
    },
    feishu: {
      intro: t('需要一个飞书企业自建应用；没有组织可以先免费创建一个。'),
      steps: [t('在飞书开放平台新建企业自建应用，开启“机器人”能力，复制 App ID 和 App Secret。'),
        t('在“权限管理”开通 im:message:send_as_bot 和 im:message.p2p_msg:readonly，发布应用并把自己放进可用范围。'),
        t('把 App ID 和 App Secret 填到下面，点“保存并验证”。'),
        t('保持共议运行，回到开放平台“事件与回调”，选择“使用长连接接收”，添加事件“接收消息”（im.message.receive_v1）。')],
      links: [{ label: t('打开飞书开放平台'), url: 'https://open.feishu.cn/app' }],
    },
  };
  return guides[id] || null;
}
