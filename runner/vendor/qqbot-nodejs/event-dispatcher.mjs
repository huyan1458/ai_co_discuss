import { GatewayEvent } from "./constants.mjs";
const REF_INDEX_KEY = "msg_idx";
function parseRefIndices(ext, msgType, msgElements) {
    let refMsgIdx;
    let msgIdx;
    if (Array.isArray(ext)) {
        for (const entry of ext) {
            if (typeof entry !== "string") {
                continue;
            }
            const eq = entry.indexOf("=");
            if (eq < 0) {
                continue;
            }
            const key = entry.slice(0, eq).trim();
            const val = entry.slice(eq + 1).trim();
            if (!val) {
                continue;
            }
            if (key === REF_INDEX_KEY) {
                msgIdx = val;
            }
            else if (key === "ref_msg_idx") {
                refMsgIdx = val;
            }
        }
    }
    if (msgType === 103 && Array.isArray(msgElements)) {
        for (const el of msgElements) {
            if (el?.msg_idx) {
                refMsgIdx = el.msg_idx;
                break;
            }
        }
    }
    return { refMsgIdx, msgIdx };
}

/** Keep only the upstream gateway events used by the C2C channel. */
export function dispatchEvent(eventType, data) {
    if (eventType === GatewayEvent.READY) return { action: "ready", data, sessionId: data.session_id };
    if (eventType === GatewayEvent.RESUMED) return { action: "resumed", data };
    if (eventType !== GatewayEvent.C2C_MESSAGE_CREATE) return { action: "raw", type: eventType, data };
    const { refMsgIdx } = parseRefIndices(data.message_scene?.ext, data.message_type, data.msg_elements);
    return { action: "message", msg: {
        senderId: data.author?.user_openid, content: data.content, messageId: data.id,
        attachments: data.attachments, refMsgIdx,
        messageReference: data.message_reference?.message_id,
        quoteText: refMsgIdx || data.message_type === 103 ? data.msg_elements?.[0]?.content : undefined,
    } };
}
