import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { createGuardManager } from "../src/guard.js";

const API_BASE = "http://127.0.0.1:7777";

async function getEphemeralPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("guard answers any method/path with 409 and guidance JSON", async () => {
  const port = await getEphemeralPort();
  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();
  assert.equal(guard.statusOf(port), "held");

  try {
    const res = await fetch(`http://127.0.0.1:${port}/some/random/path`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get("x-local-portal"), "guard");
    assert.equal(res.headers.get("x-local-portal-api"), API_BASE);

    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "port_guarded");
    assert.ok(body.how_to_get_a_port["3_register"].includes("/api/register"));
  } finally {
    guard.releaseAll();
  }
});

test("guard returns HTML when Accept: text/html", async () => {
  const port = await getEphemeralPort();
  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { headers: { Accept: "text/html" } });
    assert.equal(res.status, 409);
    assert.match(res.headers.get("content-type"), /text\/html/);
    const text = await res.text();
    assert.match(text, /local-portal/);
  } finally {
    guard.releaseAll();
  }
});

test("guard reports 'wanted' when the port is already occupied, then acquires on retry after it frees", async () => {
  const port = await getEphemeralPort();
  const occupier = net.createServer();
  await new Promise((resolve) => occupier.listen(port, "0.0.0.0", resolve));

  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();
  assert.equal(guard.statusOf(port), "wanted");

  await new Promise((resolve) => occupier.close(resolve));

  await guard.retryWanted(new Set()); // empty listen-set: occupier is gone
  assert.equal(guard.statusOf(port), "held");

  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 409);

  guard.releaseAll();
});

test("retryWanted skips ports still shown occupied in the latest scan", async () => {
  const port = await getEphemeralPort();
  const occupier = net.createServer();
  await new Promise((resolve) => occupier.listen(port, "0.0.0.0", resolve));

  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();
  assert.equal(guard.statusOf(port), "wanted");

  await guard.retryWanted(new Set([port])); // scan still sees it listening
  assert.equal(guard.statusOf(port), "wanted");

  await new Promise((resolve) => occupier.close(resolve));
  guard.releaseAll();
});

test("releaseAll frees held ports so another process can bind them", async () => {
  const port = await getEphemeralPort();
  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();
  assert.equal(guard.statusOf(port), "held");

  guard.releaseAll();

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
});

test("HEAD request to a guarded port returns 409 with no body", async () => {
  const port = await getEphemeralPort();
  const guard = createGuardManager({ ports: [port], apiBase: API_BASE, log: undefined });
  await guard.acquireAll();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
    assert.equal(res.status, 409);
    const text = await res.text();
    assert.equal(text, "");
  } finally {
    guard.releaseAll();
  }
});
