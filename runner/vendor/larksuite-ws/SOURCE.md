# Lark WebSocket transport

Source: [larksuite/node-sdk](https://github.com/larksuite/node-sdk), npm [1.77.0](https://registry.npmjs.org/@larksuiteoapi%2fnode-sdk/1.77.0), registry gitHead `1889911f0841e669de0be5bd02c737a3f1fd20fa`. The original MIT license comes from the published tarball. Transport was adapted from `ws-client/index.ts`, `enum.ts`, `ws-config.ts`, and `data-cache.ts`. `frame.mjs` implements only the two types defined by `ws-client/proto-buf/pbbp2.js` (`Frame` and `Header`), without the generated protobufjs runtime dependency.

Changes: use Node's fetch and WebSocket with ArrayBuffer messages, port endpoint discovery and the ping/pong, event reassembly and ACK paths to ESM, close on cancellation or credential replacement, and reconnect from the channel loop. Omit client assertions, custom domains/proxies, card callbacks, and the generic event dispatcher. Keep payloads and signed connection URLs out of logs.
