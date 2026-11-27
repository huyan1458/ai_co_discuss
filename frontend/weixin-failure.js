/**
 * The owner-facing reason a Weixin notice failed, from the local service's `last_failure` (iLink's code and its own
 * message), shared by the settings page and the room's notice line. A bare "-2" tells the owner nothing.
 */
import { t } from './i18n.js';

/**
 * Say why the last Weixin notice failed and what fixes it.
 *
 * @param {{code?: number|null, detail?: string, message?: string}|null} failure The service's `last_failure`.
 * @returns {string} One readable sentence, or "" when nothing failed.
 */
export function weixin_failure_text(failure) {
  if (!failure) return "";
  const detail = failure.detail ? t('（微信返回：{value1}）', { value1: failure.detail }) : "";
  if (failure.code === -14) return t('微信登录已过期，请在“设置 → 通知”的微信一栏解除绑定后重新扫码。');
  if (failure.code === -2) return t('微信拒绝了这条通知{value1}。常见原因是太久没在微信里给机器人发消息、发送凭据已失效：在微信里给机器人发一句任意消息即可恢复。', { value1: detail });
  if (failure.code != null) return t('微信拒绝了这条通知（错误码 {value1}）{value2}。', { value1: failure.code, value2: detail });
  return t('这台电脑连不上微信服务器，通知没有发出：{value1}', { value1: failure.message || t('原因未知') });
}
