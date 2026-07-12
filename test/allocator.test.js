import assert from "node:assert/strict";
import test from "node:test";

import { AllocError, createAllocator } from "../src/allocator.js";

function makeFakeRegistry(initialRecords = []) {
  const map = new Map(initialRecords.map((r) => [r.port, r]));
  return {
    getByPort: (port) => map.get(port) ?? null,
    release: (port) => {
      const r = map.get(port);
      map.delete(port);
      return r ?? null;
    },
    _set: (rec) => map.set(rec.port, rec),
  };
}

function makeFakeScanner(occupiedPorts = new Set(), { lastScanPorts = new Map() } = {}) {
  return {
    scanner: { isPortFree: async (port) => !occupiedPorts.has(port) },
    getLastScan: () => ({ ports: lastScanPorts, source: "ss", at: "2026-01-01T00:00:00.000Z" }),
  };
}

const GUARD_PORTS = [3000, 3001, 4200, 5000, 5173, 8000, 8080, 8888];
const ALLOC_RANGE = { start: 20000, end: 20999 };
const API_PORT = 7777;

function baseCtx(overrides = {}) {
  const { scanner, getLastScan } = makeFakeScanner(overrides.occupied ?? new Set(), {
    lastScanPorts: overrides.lastScanPorts,
  });
  return {
    registry: overrides.registry ?? makeFakeRegistry(),
    scanner: overrides.scanner ?? scanner,
    guardPorts: GUARD_PORTS,
    allocRange: overrides.allocRange ?? ALLOC_RANGE,
    apiPort: API_PORT,
    getLastScan: overrides.getLastScan ?? getLastScan,
    log: undefined,
  };
}

test("auto-allocate returns the first free candidate, skipping registered/guarded/scanned-occupied ports", async () => {
  const registry = makeFakeRegistry([{ port: 20000, name: "a", status: "active" }]);
  const lastScanPorts = new Map([[20001, { addresses: ["0.0.0.0"], processes: [] }]]);
  const allocator = createAllocator(baseCtx({ registry, lastScanPorts }));

  const { port } = await allocator.grant({ name: "b" });
  assert.equal(port, 20002);
});

test("preferredPort: invalid port number", async () => {
  const allocator = createAllocator(baseCtx());
  await assert.rejects(allocator.grant({ name: "a", preferredPort: 80 }), (err) => {
    assert.ok(err instanceof AllocError);
    assert.equal(err.code, "invalid_port");
    return true;
  });
});

test("preferredPort: guarded port is rejected", async () => {
  const allocator = createAllocator(baseCtx());
  await assert.rejects(allocator.grant({ name: "a", preferredPort: 3000 }), (err) => {
    assert.equal(err.code, "port_guarded");
    return true;
  });
});

test("preferredPort: apiPort itself is rejected as guarded", async () => {
  const allocator = createAllocator(baseCtx());
  await assert.rejects(allocator.grant({ name: "a", preferredPort: API_PORT }), (err) => {
    assert.equal(err.code, "port_guarded");
    return true;
  });
});

test("preferredPort: registered to another active name is rejected with owner info", async () => {
  const registry = makeFakeRegistry([{ port: 20000, name: "owner-app", status: "active" }]);
  const allocator = createAllocator(baseCtx({ registry }));

  await assert.rejects(allocator.grant({ name: "other", preferredPort: 20000 }), (err) => {
    assert.equal(err.code, "port_registered");
    assert.equal(err.owner, "owner-app");
    assert.equal(err.status, "active");
    return true;
  });
});

test("preferredPort: registered to another but stale is retained until durable replacement", async () => {
  const registry = makeFakeRegistry([{ port: 20000, name: "old-app", status: "stale" }]);
  const allocator = createAllocator(baseCtx({ registry }));

  const { port } = await allocator.grant({ name: "new-app", preferredPort: 20000 });
  assert.equal(port, 20000);
  assert.equal(registry.getByPort(20000)?.name, "old-app");
});

test("preferredPort: same name owning the port is not treated as a conflict", async () => {
  const registry = makeFakeRegistry([{ port: 20000, name: "my-app", status: "active" }]);
  const allocator = createAllocator(baseCtx({ registry }));

  const { port } = await allocator.grant({ name: "my-app", preferredPort: 20000 });
  assert.equal(port, 20000);
});

test("preferredPort: free in registry but bind-test fails is port_unmanaged with process info", async () => {
  const occupied = new Set([20000]);
  const lastScanPorts = new Map([[20000, { addresses: ["0.0.0.0"], processes: [{ name: "python3", pid: 123 }] }]]);
  const allocator = createAllocator(baseCtx({ occupied, lastScanPorts }));

  await assert.rejects(allocator.grant({ name: "a", preferredPort: 20000 }), (err) => {
    assert.equal(err.code, "port_unmanaged");
    assert.deepEqual(err.process, { name: "python3", pid: 123 });
    return true;
  });
});

test("preferredPort: free and bind-test passes grants the port", async () => {
  const allocator = createAllocator(baseCtx());
  const { port } = await allocator.grant({ name: "a", preferredPort: 20005 });
  assert.equal(port, 20005);
});

test("range_exhausted when every candidate port is taken", async () => {
  const registry = makeFakeRegistry([
    { port: 20000, name: "a", status: "active" },
    { port: 20001, name: "b", status: "active" },
  ]);
  const allocator = createAllocator(baseCtx({ registry, allocRange: { start: 20000, end: 20001 } }));

  await assert.rejects(allocator.grant({ name: "c" }), (err) => {
    assert.equal(err.code, "range_exhausted");
    return true;
  });
});

test("withLock serializes concurrent grants so they land on distinct ports", async () => {
  const registry = makeFakeRegistry();
  const allocator = createAllocator(baseCtx({ registry }));

  const doRegister = (name) =>
    allocator.withLock(async () => {
      const { port } = await allocator.grant({ name });
      registry._set({ port, name, status: "pending" });
      return port;
    });

  const [portA, portB] = await Promise.all([doRegister("a"), doRegister("b")]);
  assert.notEqual(portA, portB);
});
