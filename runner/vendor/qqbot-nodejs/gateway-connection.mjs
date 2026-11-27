/**
 * GatewayConnection ? pure protocol-layer WebSocket lifecycle.
 *
 * Owns: WebSocket connection, heartbeat, reconnect, IDENTIFY/RESUME, event
 * dispatch.
 *
 * Does NOT own: token caching (delegated via callbacks), session persistence
 * (delegated via callbacks), business policies, message queueing.
 *
 * All state injected through the constructor ? no module-level globals.
 *
 * Lifecycle invariants:
 * - State transitions (reconnect scheduling / settling) happen before any
 *   user callback is notified, and every callback is isolated, so a throwing
 *   handler can never stall the loop.
 * - Terminal failures are reported once, by rejecting `start()`.
 */
import { decodeGatewayMessageData } from "./codec.mjs";
import { FULL_INTENTS, GatewayCloseCode, GatewayOp, HANDSHAKE_TIMEOUT_MS, INVALID_SESSION_DELAY, RATE_LIMIT_DELAY, } from "./constants.mjs";
import { GatewayError, GatewayErrorCode } from "./errors.mjs";
import { dispatchEvent } from "./event-dispatcher.mjs";
import { ReconnectState } from "./reconnect.mjs";
/** Pure-protocol gateway connection. Single-use: create a new instance to restart. */
export class GatewayConnection {
    isAborted = false;
    run = null;
    finish = () => { };
    currentWs = null;
    heartbeatInterval = null;
    handshakeTimer = null;
    /** Jittered first heartbeat after HELLO; tracked so cleanup() can release it immediately. */
    firstBeatTimer = null;
    /** True while a heartbeat is awaiting its ACK; a second beat without ACK means a zombie link. */
    awaitingHeartbeatAck = false;
    /** Send timestamp of the in-flight heartbeat (0 when none is pending). */
    lastHeartbeatSentAt = 0;
    sessionId = null;
    lastSeq = null;
    isConnecting = false;
    reconnectTimer = null;
    shouldRefreshToken = false;
    reconnect;
    opts;
    constructor(opts) {
        this.opts = opts;
        this.reconnect = new ReconnectState(opts.account.accountId, opts.log, opts.reconnect);
    }
    /**
     * Start the connection loop.
     *
     * Resolves when `abortSignal` fires. Rejects with a {@link GatewayError} when
     * a finite reconnect budget is exhausted (`RETRY_EXHAUSTED`) or the gateway sends
     * a non-retryable close (`FATAL_CLOSE`). Repeated calls return the same promise.
     */
    start() {
        this.run ??= new Promise((resolve, reject) => {
            const signal = this.opts.abortSignal;
            const onAbort = () => this.finish();
            this.finish = (error) => {
                if (this.isAborted)
                    return;
                this.isAborted = true;
                signal.removeEventListener("abort", onAbort);
                this.clearReconnectTimer();
                this.cleanup();
                if (error) {
                    reject(error);
                }
                else {
                    resolve();
                }
            };
            if (signal.aborted) {
                this.finish();
                return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
            try {
                this.restoreSession();
            }
            catch (error) {
                this.finish(toError(error));
                return;
            }
            void this.connect();
        });
        return this.run;
    }
    // ============ Session persistence ============
    restoreSession() {
        const saved = this.opts.session?.load();
        if (saved) {
            this.sessionId = saved.sessionId;
            this.lastSeq = saved.lastSeq;
            this.opts.log?.info?.(`[${this.opts.account.accountId}] Restored session: sessionId=${saved.sessionId}, lastSeq=${saved.lastSeq}`);
        }
    }
    saveCurrentSession() {
        const { session } = this.opts;
        if (!this.sessionId || !session) {
            return;
        }
        const snapshot = { sessionId: this.sessionId, lastSeq: this.lastSeq };
        this.notify("session.save", () => session.save(snapshot));
    }
    resetSession() {
        this.sessionId = null;
        this.lastSeq = null;
        const { session } = this.opts;
        if (session)
            this.notify("session.clear", () => session.clear());
    }
    // ============ Callbacks + cleanup ============
    /** Invoke a user callback without letting sync throws or async rejections escape. */
    notify(name, invoke) {
        const report = (err) => {
            this.opts.log?.error(`[${this.opts.account.accountId}] ${name} handler threw: ${toError(err).message}`);
        };
        try {
            const result = invoke();
            if (isPromiseLike(result))
                Promise.resolve(result).catch(report);
        }
        catch (err) {
            report(err);
        }
    }
    /** Release the socket and heartbeat. Emits nothing. */
    cleanup() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        this.awaitingHeartbeatAck = false;
        this.lastHeartbeatSentAt = 0;
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        if (this.firstBeatTimer) {
            clearTimeout(this.firstBeatTimer);
            this.firstBeatTimer = null;
        }
        const ws = this.currentWs;
        // Retire ownership before close: ws can emit error/close after a replacement exists.
        this.currentWs = null;
        this.isConnecting = false;
        if (ws && ws.readyState < 2)
            ws.close();
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    // ============ Reconnect ============
    /** Schedule the next attempt, or return the terminal error when the budget is spent. */
    planReconnect(customDelay, failure = {}) {
        if (this.reconnect.isExhausted()) {
            const error = new GatewayError(`Max reconnect attempts reached (${this.reconnect.maxAttempts})`, GatewayErrorCode.RETRY_EXHAUSTED, failure.closeCode, { cause: failure.cause });
            this.opts.log?.error(`[${this.opts.account.accountId}] ${error.message}`);
            return error;
        }
        this.clearReconnectTimer();
        const delay = this.reconnect.getNextDelay(customDelay);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, delay);
        return null;
    }
    /** Report a disconnect after the reconnect decision is made, then settle if terminal. */
    afterDisconnect(code, reason, terminal) {
        const { onDisconnected } = this.opts;
        if (onDisconnected) {
            const event = { code, reason, willReconnect: terminal === null };
            this.notify("onDisconnected", () => onDisconnected(event));
        }
        if (terminal)
            this.finish(terminal);
    }
    // ============ Connect ============
    async connect() {
        const { log, account } = this.opts;
        if (this.isAborted)
            return;
        if (this.isConnecting) {
            log?.debug?.(`[${account.accountId}] Already connecting, skip`);
            return;
        }
        this.cleanup();
        this.isConnecting = true;
        try {
            if (this.shouldRefreshToken) {
                log?.debug?.(`[${account.accountId}] Refreshing token...`);
                this.opts.clearTokenCache?.();
                this.shouldRefreshToken = false;
            }
            const accessToken = await this.opts.getAccessToken();
            if (this.isAborted)
                return;
            log?.info(`[${account.accountId}] Access token obtained`);
            const gatewayUrl = await this.opts.getGatewayUrl(accessToken);
            if (this.isAborted)
                return;
            log?.info(`[${account.accountId}] Connecting to ${gatewayUrl}`);
            this.openSocket(gatewayUrl, accessToken);
        }
        catch (err) {
            if (this.isAborted)
                return;
            this.isConnecting = false;
            const error = toError(err);
            log?.error(`[${account.accountId}] Connection failed: ${error.message}`);
            const terminal = this.planReconnect(isRateLimitError(error.message) ? RATE_LIMIT_DELAY : undefined, { cause: error });
            const { onError } = this.opts;
            if (onError)
                this.notify("onError", () => onError(error));
            if (terminal)
                this.finish(terminal);
        }
    }
    openSocket(gatewayUrl, accessToken) {
        const { log, account } = this.opts;
        const ws = new (this.opts.websocket ?? globalThis.WebSocket)(gatewayUrl);
        ws.binaryType = 'arraybuffer';
        this.handshakeTimer = setTimeout(() => {
            if (ws === this.currentWs)
                this.handleGatewayReconnect('Gateway HELLO timeout');
        }, HANDSHAKE_TIMEOUT_MS);
        this.currentWs = ws;
        ws.addEventListener("open", () => {
            if (ws !== this.currentWs)
                return;
            log?.info(`[${account.accountId}] WebSocket connected`);
            this.isConnecting = false;
            this.reconnect.onSocketOpen();
        });
        ws.addEventListener("message", ({ data }) => {
            if (ws !== this.currentWs)
                return;
            try {
                const payload = JSON.parse(decodeGatewayMessageData(data));
                this.handlePayload(ws, payload, accessToken);
            }
            catch (err) {
                log?.error(`[${account.accountId}] Message parse error: ${toError(err).message}`);
            }
        });
        ws.addEventListener("close", ({ code, reason }) => {
            if (ws !== this.currentWs)
                return;
            const reasonText = reason.toString();
            log?.info(`[${account.accountId}] WebSocket closed: ${code} ${reasonText}`);
            this.isConnecting = false;
            this.handleClose(code, reasonText);
        });
        ws.addEventListener("error", (event) => {
            if (ws !== this.currentWs)
                return;
            const err = event.error ?? new Error("WebSocket error");
            log?.error(`[${account.accountId}] WebSocket error: ${err.message}`);
            const { onError } = this.opts;
            if (onError)
                this.notify("onError", () => onError(err));
        });
    }
    // ============ Protocol handlers ============
    handlePayload(ws, payload, accessToken) {
        const { op, d, s } = payload;
        if (Number.isInteger(s)) {
            this.lastSeq = s;
            this.saveCurrentSession();
        }
        switch (op) {
            case GatewayOp.HELLO:
                clearTimeout(this.handshakeTimer);
                this.handshakeTimer = null;
                this.handleHello(ws, d, accessToken);
                break;
            case GatewayOp.DISPATCH:
                this.handleDispatch(payload);
                break;
            case GatewayOp.HEARTBEAT_ACK: {
                this.awaitingHeartbeatAck = false;
                if (this.lastHeartbeatSentAt !== 0) {
                    const latency = Date.now() - this.lastHeartbeatSentAt;
                    this.lastHeartbeatSentAt = 0;
                    const { onHeartbeat } = this.opts;
                    if (onHeartbeat)
                        this.notify("onHeartbeat", () => onHeartbeat(latency));
                }
                break;
            }
            case GatewayOp.RECONNECT:
                this.handleGatewayReconnect("Gateway requested reconnect");
                break;
            case GatewayOp.INVALID_SESSION:
                // d = whether the session can be resumed
                if (!d) {
                    this.resetSession();
                    this.shouldRefreshToken = true;
                }
                this.handleGatewayReconnect("Invalid gateway session", INVALID_SESSION_DELAY);
                break;
        }
    }
    handleDispatch(payload) {
        const { log, account } = this.opts;
        const { d, t } = payload;
        const result = dispatchEvent(t ?? "", d, account.accountId, log);
        if (result.action === "ready") {
            this.sessionId = result.sessionId;
            this.reconnect.onConnected();
            this.saveCurrentSession();
            const { onReady } = this.opts;
            if (onReady)
                this.notify("onReady", () => onReady(result.data));
        }
        else if (result.action === "resumed") {
            this.reconnect.onConnected();
            this.saveCurrentSession();
            const onResumed = this.opts.onResumed ?? this.opts.onReady;
            if (onResumed)
                this.notify("onResumed", () => onResumed(result.data));
        }
        else if (result.action === "interaction") {
            // Interaction ? handler ? ????? fallback ? rawEvent
            const { onInteraction, onRawEvent } = this.opts;
            if (onInteraction) {
                this.notify("onInteraction", () => onInteraction(result.event));
            }
            else if (onRawEvent) {
                this.notify("onRawEvent", () => onRawEvent(t ?? "", d));
            }
        }
        else if (result.action === "message") {
            this.notify("onMessage", () => this.opts.onMessage(result.msg));
        }
        else if (result.action === "raw") {
            const { onRawEvent } = this.opts;
            if (onRawEvent)
                this.notify("onRawEvent", () => onRawEvent(result.type, result.data));
        }
    }
    handleHello(ws, d, accessToken) {
        // Validate before IDENTIFY/RESUME: a malformed interval would clamp
        // setInterval to 1ms and cause a heartbeat storm.
        const interval = readHeartbeatInterval(d);
        if (interval === null) {
            const { log, account } = this.opts;
            log?.error(`[${account.accountId}] Invalid HELLO heartbeat interval: ${previewPayload(d)}`);
            this.handleGatewayReconnect("Invalid HELLO heartbeat interval");
            return;
        }
        const intents = this.opts.intents ?? FULL_INTENTS;
        if (this.sessionId && this.lastSeq !== null) {
            const { onResuming } = this.opts;
            if (onResuming)
                this.notify("onResuming", () => onResuming());
            ws.send(JSON.stringify({
                op: GatewayOp.RESUME,
                d: {
                    token: `QQBot ${accessToken}`,
                    session_id: this.sessionId,
                    seq: this.lastSeq,
                },
            }));
        }
        else {
            const { onIdentifying } = this.opts;
            if (onIdentifying)
                this.notify("onIdentifying", () => onIdentifying());
            ws.send(JSON.stringify({
                op: GatewayOp.IDENTIFY,
                d: {
                    token: `QQBot ${accessToken}`,
                    intents,
                    shard: [0, 1],
                },
            }));
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        // HELLO ??? interval?random ???????????????
        // ???????????????????????
        const jitter = Math.max(1, Math.floor(Math.random() * interval));
        this.firstBeatTimer = setTimeout(() => {
            this.firstBeatTimer = null;
            if (ws === this.currentWs)
                this.sendHeartbeat(ws);
        }, jitter);
        this.heartbeatInterval = setInterval(() => {
            if (ws !== this.currentWs)
                return;
            if (ws.readyState !== 1)
                return;
            this.sendHeartbeat(ws);
        }, interval);
    }
    /** Send a heartbeat or retire a socket that missed its previous ACK. */
    sendHeartbeat(ws) {
        if (this.awaitingHeartbeatAck) {
            this.handleGatewayReconnect("Heartbeat ACK timeout");
            return;
        }
        this.awaitingHeartbeatAck = true;
        this.lastHeartbeatSentAt = Date.now();
        ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this.lastSeq }));
    }
    /** Opcode 7 / 9: drop the socket locally and reconnect. */
    handleGatewayReconnect(reason, customDelay) {
        this.cleanup();
        const terminal = this.planReconnect(customDelay);
        this.afterDisconnect(GatewayCloseCode.NORMAL, reason, terminal);
    }
    handleClose(code, reason) {
        const action = this.reconnect.handleClose(code, this.isAborted);
        if (action.clearSession) {
            this.resetSession();
        }
        if (action.refreshToken) {
            this.shouldRefreshToken = true;
        }
        this.cleanup();
        const terminal = action.shouldReconnect
            ? this.planReconnect(action.reconnectDelay, { closeCode: code })
            : new GatewayError(`Gateway closed (${code}): ${action.reason}`, GatewayErrorCode.FATAL_CLOSE, code);
        this.afterDisconnect(code, reason, terminal);
    }
}
function toError(err) {
    return err instanceof Error ? err : new Error(String(err));
}
/**
 * Read the HELLO heartbeat interval; numeric strings are coerced so a
 * server-side serialization change stays non-breaking. Returns `null` for
 * any value that cannot schedule a sane heartbeat.
 */
function readHeartbeatInterval(d) {
    const raw = d?.heartbeat_interval;
    const value = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return value;
}
function isPromiseLike(value) {
    return typeof value?.then === "function";
}
function isRateLimitError(message) {
    return message.includes("Too many requests") || message.includes("100001");
}
/**
 * Serialize a gateway event payload for debug logging.
 *
 * JSON-stringifies the payload; returns `"(non-serializable)"` for cyclic
 * or otherwise unserializable values so logging never throws.
 */
function previewPayload(data) {
    if (data === undefined)
        return "undefined";
    if (data === null)
        return "null";
    try {
        const s = JSON.stringify(data);
        return s === undefined ? "(non-serializable)" : s;
    }
    catch {
        return "(non-serializable)";
    }
}

