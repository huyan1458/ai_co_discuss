/**
 * Terminal gateway errors — the reasons a {@link GatewayConnection} stops
 * retrying and rejects its `start()` promise.
 */
/** Stable error codes. Match on `code` rather than `instanceof` across module copies. */
export const GatewayErrorCode = {
    /** A finite `reconnect.maxAttempts` was exhausted (never raised with the unlimited default). */
    RETRY_EXHAUSTED: "GATEWAY_RETRY_EXHAUSTED",
    /** Non-retryable close (4914 offline/sandbox-only, 4915 banned). Needs operator action. */
    FATAL_CLOSE: "GATEWAY_FATAL_CLOSE",
};
/** Error used to reject `GatewayConnection.start()` / `QQBot.start()`. */
export class GatewayError extends Error {
    code;
    /** Remote WebSocket close code that caused the failure, when known. */
    closeCode;
    constructor(message, code, closeCode, options) {
        super(message, options);
        this.name = "GatewayError";
        this.code = code;
        this.closeCode = closeCode;
    }
}
