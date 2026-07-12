import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAllocator } from "../src/allocator.js";
import { createApiServer } from "../src/api.js";
import * as dashboard from "../src/dashboard.js";
import { createGuardManager } from "../src/guard.js";
import { createRegistry } from "../src/registry.js";

async function getEphemeralPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function getJsonWithHost(apiBase, path, hostHeader) {
  const url = new URL(apiBase);
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: url.hostname,
        port: Number(url.port),
        path,
        headers: { Host: hostHeader },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
  });
}

function tmpRegistryPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-portal-api-"));
  return path.join(dir, "registry.json");
}

function failNextSnapshotCreateOnce(filePath) {
  let failed = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          if (!failed && targetPath === `${filePath}.next`) {
            failed = true;
            const error = new Error("injected next snapshot creation failure");
            error.code = "EIO";
            throw error;
          }
          return target.openSync(targetPath, flags, mode);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function setupServer(overrides = {}) {
  const apiPort = overrides.apiPort ?? (await getEphemeralPort());
  const guardPort = overrides.guardPort ?? (await getEphemeralPort());

  const config = {
    apiPort,
    apiBind: "127.0.0.1",
    publicApiBase: overrides.publicApiBase ?? null,
    guardPorts: [guardPort],
    allocRange: { start: 20000, end: 20002 },
    pendingGraceSec: 300,
    staleGraceSec: 90,
    staleEvictSec: 86400,
  };

  const registryPath = overrides.registryPath ?? tmpRegistryPath();
  const registry = createRegistry({
    filePath: registryPath,
    now: overrides.now ?? (() => Date.now()),
    fsImpl: overrides.fsImpl,
  });
  registry.load();

  const occupied = overrides.occupied ?? new Set();
  let listening = overrides.listening ?? new Set();
  let lastScan = { ports: new Map(), source: "ss", at: new Date().toISOString() };

  const scanner = {
    isPortFree: overrides.isPortFree ?? (async (port) => !occupied.has(port)),
    isListening: async (port) => listening.has(port),
  };

  const guards = createGuardManager({
    ports: config.guardPorts,
    apiBase: `http://127.0.0.1:${apiPort}`,
    log: undefined,
  });
  await guards.acquireAll();

  const allocator = createAllocator({
    registry,
    scanner,
    guardPorts: config.guardPorts,
    allocRange: config.allocRange,
    apiPort: config.apiPort,
    getLastScan: () => lastScan,
    log: undefined,
  });

  const server = createApiServer({
    config,
    registry,
    allocator,
    scanner,
    guards,
    dashboard,
    getLastScan: () => lastScan,
    log: undefined,
  });

  await new Promise((resolve) => server.listen(apiPort, "127.0.0.1", resolve));

  return {
    apiBase: `http://127.0.0.1:${apiPort}`,
    guardPort,
    registry,
    registryPath,
    guards,
    setListening: (set) => {
      listening = set;
    },
    setLastScan: (v) => {
      lastScan = v;
    },
    close: async () => {
      guards.releaseAll();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("GET /api/health returns the service signature", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, service: "local-portal", version: "1.0.0", pid: process.pid });
  } finally {
    await ctx.close();
  }
});

test("GET /api/ports uses request Host for apiBase when publicApiBase is unset", async () => {
  const ctx = await setupServer();
  try {
    const port = new URL(ctx.apiBase).port;
    const { status, body } = await getJsonWithHost(ctx.apiBase, "/api/ports", `portal.lan:${port}`);
    assert.equal(status, 200);
    assert.equal(body.portal.apiBase, `http://portal.lan:${new URL(ctx.apiBase).port}`);
  } finally {
    await ctx.close();
  }
});

test("GET /api/agent-guide honors explicit publicApiBase over request Host", async () => {
  const ctx = await setupServer({ publicApiBase: "http://portal.example.test:7777" });
  try {
    const res = await fetch(`${ctx.apiBase}/api/agent-guide`, {
      headers: { Host: `ignored.lan:${new URL(ctx.apiBase).port}` },
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /local-portal`, a port registry at http:\/\/portal\.example\.test:7777/);
    assert.doesNotMatch(text, /ignored\.lan/);
  } finally {
    await ctx.close();
  }
});

test("POST /api/register grants a port with the expected shape", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "e2e-demo", description: "manual verification" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.existing, false);
    assert.equal(body.granted.port, 20000);
    assert.equal(body.granted.status, "pending");
    assert.ok(body.granted.bindBy);
    assert.equal(body.next_steps.length, 4);
    assert.ok(body.next_steps[0].includes("20000"));
    const restarted = createRegistry({ filePath: ctx.registryPath });
    restarted.load();
    assert.equal(restarted.getByPort(20000)?.id, body.granted.id);
  } finally {
    await ctx.close();
  }
});

test("POST /api/register returns structured 503 without a ghost allocation on persistence failure", async () => {
  const registryPath = tmpRegistryPath();
  const ctx = await setupServer({
    registryPath,
    fsImpl: failNextSnapshotCreateOnce(registryPath),
  });
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ghost-app", preferredPort: 20000 }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "registry_persist_failed");
    assert.equal(body.error.retryable, true);
    assert.equal(body.error.recoveryPending, true);
    assert.equal(ctx.registry.getByPort(20000), null);

    const restarted = createRegistry({ filePath: registryPath });
    restarted.load();
    assert.equal(restarted.getByPort(20000), null);
  } finally {
    await ctx.close();
  }
});

test("POST /api/register is idempotent for the same (name, preferredPort)", async () => {
  const ctx = await setupServer();
  try {
    const first = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "my-app", preferredPort: 20001 }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "my-app", preferredPort: 20001 }),
    });
    assert.equal(second.status, 200);
    const body = await second.json();
    assert.equal(body.existing, true);
    assert.equal(body.granted.port, 20001);
  } finally {
    await ctx.close();
  }
});

test("POST /api/register without preferredPort returns the existing registration for the same name", async () => {
  const ctx = await setupServer();
  try {
    const first = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "repeat-app" }),
    });
    const firstBody = await first.json();

    const second = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "repeat-app" }),
    });
    assert.equal(second.status, 200);
    const secondBody = await second.json();
    assert.equal(secondBody.existing, true);
    assert.equal(secondBody.granted.port, firstBody.granted.port);
  } finally {
    await ctx.close();
  }
});

test("POST /api/register rejects invalid name", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "!!!bad!!!" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "invalid_name");
  } finally {
    await ctx.close();
  }
});

test("POST /api/register rejects a guarded preferredPort", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "greedy", preferredPort: ctx.guardPort }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, "port_guarded");
  } finally {
    await ctx.close();
  }
});

test("GET /api/ports shows guarded and registered-pending states", async () => {
  const ctx = await setupServer();
  try {
    await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "app-a", preferredPort: 20000 }),
    });

    const res = await fetch(`${ctx.apiBase}/api/ports`);
    assert.equal(res.status, 200);
    const body = await res.json();

    const guardEntry = body.ports.find((p) => p.port === ctx.guardPort);
    assert.equal(guardEntry.state, "guarded");

    const regEntry = body.ports.find((p) => p.port === 20000);
    assert.equal(regEntry.state, "registered-pending");
    assert.equal(regEntry.registration.name, "app-a");
    assert.equal(body.allocRange.used, 1);
  } finally {
    await ctx.close();
  }
});

test("a reconcile tick flips a registration from pending to registered-active", async () => {
  const ctx = await setupServer();
  try {
    await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "flips", preferredPort: 20000 }),
    });

    ctx.setListening(new Set([20000]));
    ctx.setLastScan({
      ports: new Map([[20000, { addresses: ["0.0.0.0"], processes: [{ name: "node", pid: 999 }] }]]),
      source: "ss",
      at: new Date().toISOString(),
    });
    ctx.registry.applyScan(
      new Set([20000]),
      new Map([[20000, { name: "node", pid: 999 }]]),
      { pendingGraceSec: 300, staleGraceSec: 90, staleEvictSec: 86400 },
      Date.now()
    );

    const res = await fetch(`${ctx.apiBase}/api/ports/20000`);
    const body = await res.json();
    assert.equal(body.state, "registered-active");
    assert.deepEqual(body.registration.observedProcess, { name: "node", pid: 999 });
  } finally {
    await ctx.close();
  }
});

test("GET /api/ports/:port reports free for an untouched port and occupied-unmanaged when listening", async () => {
  const ctx = await setupServer();
  try {
    const free = await (await fetch(`${ctx.apiBase}/api/ports/20002`)).json();
    assert.equal(free.state, "free");

    ctx.setListening(new Set([20002]));
    const occupied = await (await fetch(`${ctx.apiBase}/api/ports/20002`)).json();
    assert.equal(occupied.state, "occupied-unmanaged");
  } finally {
    await ctx.close();
  }
});

test("GET /api/ports/:port reports occupied-unmanaged with guardWanted for a wanted guard port", async () => {
  const occupierPort = await getEphemeralPort();
  const occupier = net.createServer();
  await new Promise((resolve) => occupier.listen(occupierPort, "0.0.0.0", resolve));

  const ctx = await setupServer({ guardPort: occupierPort });
  try {
    assert.equal(ctx.guards.statusOf(occupierPort), "wanted");
    const res = await fetch(`${ctx.apiBase}/api/ports/${occupierPort}`);
    const body = await res.json();
    assert.equal(body.state, "occupied-unmanaged");
    assert.equal(body.guardWanted, true);
  } finally {
    await ctx.close();
    await new Promise((resolve) => occupier.close(resolve));
  }
});

test("POST /api/release: name mismatch is rejected, then a correct release makes the port free", async () => {
  const ctx = await setupServer();
  try {
    await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-app", preferredPort: 20000 }),
    });

    const mismatch = await fetch(`${ctx.apiBase}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "wrong-app", port: 20000 }),
    });
    assert.equal(mismatch.status, 403);
    assert.equal((await mismatch.json()).error.code, "name_mismatch");

    const ok = await fetch(`${ctx.apiBase}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-app", port: 20000 }),
    });
    assert.equal(ok.status, 200);

    const restarted = createRegistry({ filePath: ctx.registryPath });
    restarted.load();
    assert.equal(restarted.getByPort(20000), null);

    const notFound = await fetch(`${ctx.apiBase}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-app", port: 20000 }),
    });
    assert.equal(notFound.status, 404);

    const view = await (await fetch(`${ctx.apiBase}/api/ports/20000`)).json();
    assert.equal(view.state, "free");
  } finally {
    await ctx.close();
  }
});

test("POST /api/release returns structured 503 and retains owner on persistence failure", async () => {
  const registryPath = tmpRegistryPath();
  const seed = createRegistry({ filePath: registryPath, now: () => 1_000_000 });
  seed.register({ name: "owner-app", port: 20000 });
  seed.persist();

  const ctx = await setupServer({
    registryPath,
    fsImpl: failNextSnapshotCreateOnce(registryPath),
  });
  try {
    const res = await fetch(`${ctx.apiBase}/api/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "owner-app", port: 20000 }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "registry_persist_failed");
    assert.equal(ctx.registry.getByPort(20000)?.name, "owner-app");

    const restarted = createRegistry({ filePath: registryPath });
    restarted.load();
    assert.equal(restarted.getByPort(20000)?.name, "owner-app");
  } finally {
    await ctx.close();
  }
});

test("failed stale-port takeover keeps the foreign registration and returns 503", async () => {
  const registryPath = tmpRegistryPath();
  const seed = createRegistry({ filePath: registryPath, now: () => 1_000_000 });
  seed.register({ name: "foreign-owner", port: 20000 });
  seed.applyScan(
    new Set(),
    new Map(),
    { pendingGraceSec: 0, staleGraceSec: 90, staleEvictSec: 86400 },
    1_001_000,
  );
  seed.persist();
  assert.equal(seed.getByPort(20000)?.status, "stale");

  const ctx = await setupServer({
    registryPath,
    fsImpl: failNextSnapshotCreateOnce(registryPath),
  });
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "replacement", preferredPort: 20000 }),
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "registry_persist_failed");
    assert.equal(ctx.registry.getByPort(20000)?.name, "foreign-owner");
  } finally {
    await ctx.close();
  }
});

test("same-name reregister cannot race a stale foreign replacement to two successes", async () => {
  const registryPath = tmpRegistryPath();
  const seed = createRegistry({ filePath: registryPath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });
  seed.applyScan(
    new Set(),
    new Map(),
    { pendingGraceSec: 0, staleGraceSec: 90, staleEvictSec: 86400 },
    1_001_000,
  );
  seed.persist();

  let announceProbe;
  const probeEntered = new Promise((resolve) => {
    announceProbe = resolve;
  });
  let allowProbe;
  const probeGate = new Promise((resolve) => {
    allowProbe = resolve;
  });
  const ctx = await setupServer({
    registryPath,
    isPortFree: async () => {
      announceProbe();
      await probeGate;
      return true;
    },
  });
  try {
    const replacement = fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "replacement", preferredPort: 20000 }),
    });
    await probeEntered;
    const reregister = fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "old-owner", preferredPort: 20000 }),
    });
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const reregisterMutatedWhileReplacementWasProbing =
      ctx.registry.getByPort(20000)?.status === "pending";
    allowProbe();

    const [replacementResult, reregisterResult] = await Promise.all([replacement, reregister]);
    assert.equal(replacementResult.status, 201);
    assert.equal(reregisterResult.status, 409);
    assert.equal(reregisterMutatedWhileReplacementWasProbing, false);
    assert.equal(ctx.registry.getByPort(20000)?.name, "replacement");
  } finally {
    await ctx.close();
  }
});

test("unknown /api/* route returns 404 with available endpoints hint", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error.code, "not_found");
    assert.ok(body.error.hint.includes("/api/register"));
  } finally {
    await ctx.close();
  }
});

test("wrong method on a known route returns 405 with Allow header", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/register`, { method: "GET" });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  } finally {
    await ctx.close();
  }
});

test("oversized request body is rejected with 413", async () => {
  const ctx = await setupServer();
  try {
    const bigBody = JSON.stringify({ name: "big", description: "x".repeat(20_000) });
    const res = await fetch(`${ctx.apiBase}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bigBody,
    });
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, "payload_too_large");
  } finally {
    await ctx.close();
  }
});

test("GET /api/agent-guide returns markdown containing the register instructions", async () => {
  const ctx = await setupServer();
  try {
    const res = await fetch(`${ctx.apiBase}/api/agent-guide`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/markdown/);
    const text = await res.text();
    assert.ok(text.includes("/api/register"));

    const jsonRes = await fetch(`${ctx.apiBase}/api/agent-guide?format=json`);
    const jsonBody = await jsonRes.json();
    assert.ok(jsonBody.markdown.includes("/api/register"));
  } finally {
    await ctx.close();
  }
});
