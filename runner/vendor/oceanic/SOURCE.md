# Oceanic.js 1.15.0

Source: [npm artifact](https://registry.npmjs.org/oceanic.js/-/oceanic.js-1.15.0.tgz) · [upstream](https://github.com/OceanicJS/Oceanic).

`gateway.mjs` adapts the Hello, heartbeat acknowledgment, identify, resume and dispatch handlers from `dist/lib/gateway/Shard.js` to native WebSocket and JSON. The single-shard client only emits private-message events to our channel adapter. Compression, caches and guild features are omitted. Text REST calls live in the channel adapter and use fetch.
