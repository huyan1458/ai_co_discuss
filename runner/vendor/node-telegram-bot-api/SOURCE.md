# node-telegram-bot-api 2.5.0

Source: [npm artifact](https://registry.npmjs.org/node-telegram-bot-api/-/node-telegram-bot-api-2.5.0.tgz) · [upstream release](https://github.com/yagop/node-telegram-bot-api/releases/tag/v2.5.0).

`text.mjs` adapts the timeout, JSON envelope and retry-after transport from `dist/core/transport.js` and the getUpdates request from `dist/core/longpoll.js`. It sends JSON only, uses native AbortSignal composition, and leaves durable offset ownership to the caller. Multipart, debug, queueing and ambiguous-send retries are omitted.
