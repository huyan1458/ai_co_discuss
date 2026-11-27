/**
 * WebSocket reconnection state machine and close-code handler.
 */
import { GatewayCloseCode, MAX_QUICK_DISCONNECT_COUNT, MAX_RECONNECT_ATTEMPTS, QUICK_DISCONNECT_THRESHOLD, RATE_LIMIT_DELAY, RECONNECT_DELAYS, } from "./constants.mjs";
const DEFAULT_RECONNECT_POLICY = {
    maxAttempts: MAX_RECONNECT_ATTEMPTS,
    delays: RECONNECT_DELAYS,
};
/** Merge a partial policy with defaults, rejecting values that would break the retry loop. */
export function resolveReconnectPolicy(policy) {
    const maxAttempts = policy?.maxAttempts ?? DEFAULT_RECONNECT_POLICY.maxAttempts;
    const delays = policy?.delays ?? DEFAULT_RECONNECT_POLICY.delays;
    const isUnlimited = maxAttempts === Number.POSITIVE_INFINITY;
    if (!isUnlimited && (!Number.isInteger(maxAttempts) || maxAttempts < 0)) {
        throw new RangeError(`reconnect.maxAttempts must be a non-negative integer or Infinity, got ${maxAttempts}`);
    }
    if (delays.length === 0 || delays.some((d) => !Number.isFinite(d) || d < 0)) {
        throw new RangeError("reconnect.delays must be a non-empty list of non-negative numbers");
    }
    return { maxAttempts, delays: [...delays] };
}
export class ReconnectState {
    accountId;
    log;
    attempts = 0;
    lastConnectTime = 0;
    quickDisconnectCount = 0;
    policy;
    constructor(accountId, log, policy) {
        this.accountId = accountId;
        this.log = log;
        this.policy = resolveReconnectPolicy(policy);
    }
    /** Socket opened — starts the quick-disconnect window. Does not reset the budget. */
    onSocketOpen() {
        this.lastConnectTime = Date.now();
    }
    /**
     * Session established (READY / RESUMED) — resets the reconnect budget.
     *
     * Resetting on socket open instead would let "open then immediately kicked"
     * loops (e.g. repeated 4004) retry forever.
     */
    onConnected() {
        this.attempts = 0;
        this.lastConnectTime = Date.now();
    }
    isExhausted() {
        return this.attempts >= this.policy.maxAttempts;
    }
    /** Maximum consecutive attempts allowed by the active policy. */
    get maxAttempts() {
        return this.policy.maxAttempts;
    }
    getNextDelay(customDelay) {
        const { delays } = this.policy;
        const delay = customDelay ?? delays[Math.min(this.attempts, delays.length - 1)];
        this.attempts++;
        this.log?.debug?.(`[${this.accountId}] Reconnecting in ${delay}ms (attempt ${this.attempts})`);
        return delay;
    }
    handleClose(code, isAborted) {
        if (code === GatewayCloseCode.INSUFFICIENT_INTENTS ||
            code === GatewayCloseCode.DISALLOWED_INTENTS) {
            const reason = code === GatewayCloseCode.INSUFFICIENT_INTENTS ? "offline/sandbox-only" : "banned";
            this.log?.error(`[${this.accountId}] Bot is ${reason}. Please contact QQ platform.`);
            return {
                shouldReconnect: false,
                clearSession: false,
                refreshToken: false,
                fatal: true,
                reason,
            };
        }
        if (code === GatewayCloseCode.AUTH_FAILED) {
            this.log?.info(`[${this.accountId}] Invalid token (4004), will refresh token and reconnect`);
            return {
                shouldReconnect: !isAborted,
                clearSession: false,
                refreshToken: true,
                fatal: false,
                reason: "invalid token (4004)",
            };
        }
        if (code === GatewayCloseCode.RATE_LIMITED) {
            this.log?.info(`[${this.accountId}] Rate limited (4008), waiting ${RATE_LIMIT_DELAY}ms`);
            return {
                shouldReconnect: !isAborted,
                reconnectDelay: RATE_LIMIT_DELAY,
                clearSession: false,
                refreshToken: false,
                fatal: false,
                reason: "rate limited (4008)",
            };
        }
        // 4009 是服务端"请重连"的通用关闭码（最大连接时长到期、负载转移、Ping 超时等），
        // 服务端会保留 session 等待客户端 RESUME 并按 seq 重放断线期间的事件。
        // 这里必须保留 session：清掉会让重连退化为 IDENTIFY 新会话，丢失积压消息。
        if (code === GatewayCloseCode.SESSION_TIMEOUT) {
            this.log?.info(`[${this.accountId}] Server requested reconnect (4009), will resume`);
            return {
                shouldReconnect: !isAborted,
                clearSession: false,
                refreshToken: false,
                fatal: false,
                reason: "server requested reconnect",
            };
        }
        if (code === GatewayCloseCode.INVALID_SESSION ||
            code === GatewayCloseCode.SEQ_OUT_OF_RANGE) {
            const codeDesc = {
                [GatewayCloseCode.INVALID_SESSION]: "session no longer valid",
                [GatewayCloseCode.SEQ_OUT_OF_RANGE]: "invalid seq on resume",
            };
            this.log?.info(`[${this.accountId}] Error ${code} (${codeDesc[code]}), will re-identify`);
            return {
                shouldReconnect: !isAborted,
                clearSession: true,
                refreshToken: true,
                fatal: false,
                reason: codeDesc[code],
            };
        }
        if (code >= GatewayCloseCode.SERVER_ERROR_START && code <= GatewayCloseCode.SERVER_ERROR_END) {
            this.log?.info(`[${this.accountId}] Internal error (${code}), will re-identify`);
            return {
                shouldReconnect: !isAborted,
                clearSession: true,
                refreshToken: true,
                fatal: false,
                reason: `internal error (${code})`,
            };
        }
        const connectionDuration = Date.now() - this.lastConnectTime;
        if (connectionDuration < QUICK_DISCONNECT_THRESHOLD && this.lastConnectTime > 0) {
            this.quickDisconnectCount++;
            this.log?.debug?.(`[${this.accountId}] Quick disconnect detected (${connectionDuration}ms), count: ${this.quickDisconnectCount}`);
            if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
                this.log?.error(`[${this.accountId}] Too many quick disconnects. This may indicate a permission issue.`);
                this.quickDisconnectCount = 0;
                return {
                    shouldReconnect: !isAborted,
                    reconnectDelay: RATE_LIMIT_DELAY,
                    clearSession: false,
                    refreshToken: false,
                    fatal: false,
                    reason: "too many quick disconnects",
                };
            }
        }
        else {
            this.quickDisconnectCount = 0;
        }
        // A remote 1000 is a server-side graceful close (deploy / drain), not a
        // client shutdown: local closes retire the socket before its close event.
        return {
            shouldReconnect: !isAborted,
            clearSession: false,
            refreshToken: false,
            fatal: false,
            reason: `close code ${code}`,
        };
    }
}
