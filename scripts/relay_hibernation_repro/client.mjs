import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

const sockets = [];
async function connect(name) {
  const socket = new WebSocket("ws://127.0.0.1:8799/connect", "codiscuss-relay");
  sockets.push(socket);
  socket.addEventListener("message", ({ data }) => {
    const frame = JSON.parse(data);
    if (frame.type === "request") socket.send(JSON.stringify({ type: "response", id: frame.id, envelope: { name } }));
  });
  await once(socket, "open", { signal: AbortSignal.timeout(12000) });
}

async function probe(expected) {
  const response = await fetch("http://127.0.0.1:8799/probe", { signal: AbortSignal.timeout(12000) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "done");
  assert.equal(result.response?.name, expected);
  console.log(expected, result.generation);
  return result.generation;
}

try {
  await connect("A");
  await probe("A");
  await connect("B");
  const before = await probe("B");
  await sleep(15000);
  const after = await probe("B");
  await sleep(15000);
  const last = await probe("B");
  assert.ok(before !== after || before !== last, "Durable Object did not hibernate / 未观察到对象休眠重建");
} finally {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.close();
}
