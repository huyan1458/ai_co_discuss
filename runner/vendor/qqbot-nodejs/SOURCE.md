# Tencent QQ Bot Node.js SDK

Source: [tencent-connect/qqbot-nodejs](https://github.com/tencent-connect/qqbot-nodejs/tree/b316f184a0eddfeedfca9f724e5fa2b7ddf90aae), npm [@tencent-connect/qqbot-nodejs 1.0.6](https://registry.npmjs.org/@tencent-connect/qqbot-nodejs/-/qqbot-nodejs-1.0.6.tgz). The original MIT LICENSE is retained.

- The Gateway connection, reconnect policy, constants, error and frame-codec modules come from the npm dist files in `protocol/gateway/`. Imports use local ESM files. The connection replaces `ws` with Node 24 WebSocket, uses EventTarget callbacks, sets ArrayBuffer decoding and enforces a HELLO deadline. An unacknowledged socket is retired and reconnects with the upstream resume state rather than calling the unavailable `terminate()`.
- The dispatcher keeps READY, RESUMED and C2C text fields, including the upstream quote index parser. Other event types do not become room messages.
- `rest.mjs` extracts the plain-text C2C, Gateway discovery, access-token caching and fetch/error handling from `protocol/api/{messages,token,api-client,routes}.js`. It drops unrelated methods, tracing and background token refresh, adds fetch injection and retains provider error codes and details. Account binding is CoDiscuss code, not part of the upstream SDK.
