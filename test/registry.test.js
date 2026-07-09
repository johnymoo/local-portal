import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRegistry } from "../src/registry.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-portal-registry-"));
  return path.join(dir, "registry.json");
}

const CONFIG = { pendingGraceSec: 300, staleGraceSec: 90, staleEvictSec: 86400 };

function clock(startMs) {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms), get: () => t };
}

test("register creates a pending record", () => {
  const filePath = tmpFile();
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath, now: c.now });

  const rec = registry.register({ name: "my-app", description: "demo", port: 20000, requestedPort: 3000 });

  assert.equal(rec.status, "pending");
  assert.equal(rec.port, 20000);
  assert.equal(rec.requestedPort, 3000);
  assert.equal(rec.lastSeenListeningAt, null);
  assert.equal(rec.staleSince, null);
  assert.match(rec.id, /^reg_[0-9a-f]{8}$/);
});

test("persist + load round trip preserves records, tmp file cleaned up", () => {
  const filePath = tmpFile();
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath, now: c.now });
  registry.register({ name: "my-app", port: 20000 });
  registry.persist();

  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  assert.equal(fs.existsSync(filePath), true);

  const registry2 = createRegistry({ filePath, now: c.now });
  registry2.load();
  assert.equal(registry2.getByPort(20000).name, "my-app");
});

test("corrupt JSON file is quarantined and registry starts empty", () => {
  const filePath = tmpFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{ not json");

  const warnings = [];
  const errors = [];
  const log = { warn: (c, m) => warnings.push(m), error: (c, m) => errors.push(m) };
  const registry = createRegistry({ filePath, log });

  const result = registry.load();
  assert.equal(result.quarantined, true);
  assert.equal(registry.all().length, 0);
  assert.ok(errors.some((m) => m.includes("quarantined")));

  const quarantinedFiles = fs.readdirSync(path.dirname(filePath)).filter((f) => f.includes("corrupt"));
  assert.equal(quarantinedFiles.length, 1);
});

test("unsupported schemaVersion is quarantined", () => {
  const filePath = tmpFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, registrations: [] }));

  const registry = createRegistry({ filePath, log: { warn() {}, error() {} } });
  const result = registry.load();
  assert.equal(result.quarantined, true);
});

test("load drops only the individually invalid record", () => {
  const filePath = tmpFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      registrations: [
        {
          id: "reg_aaaaaaaa",
          name: "good-app",
          description: "",
          port: 20001,
          requestedPort: null,
          status: "active",
          registeredAt: "2026-01-01T00:00:00.000Z",
          lastSeenListeningAt: null,
          staleSince: null,
          observedProcess: null,
          meta: {},
        },
        { id: "reg_bad", name: "!!!invalid!!!", port: 20002, status: "active", registeredAt: "x" },
      ],
    })
  );

  const warnings = [];
  const registry = createRegistry({ filePath, log: { warn: (c, m) => warnings.push(m), error() {} } });
  const result = registry.load();

  assert.equal(result.loaded, 1);
  assert.ok(registry.getByPort(20001));
  assert.equal(registry.getByPort(20002), null);
  assert.ok(warnings.some((w) => w.includes("dropped 1 invalid record")));
});

test("release removes a record and returns it", () => {
  const filePath = tmpFile();
  const registry = createRegistry({ filePath, now: () => 1_000_000 });
  registry.register({ name: "my-app", port: 20000 });

  const released = registry.release(20000);
  assert.equal(released.name, "my-app");
  assert.equal(registry.getByPort(20000), null);
  assert.equal(registry.release(20000), null);
});

// --- State machine transitions (§5) ---

test("rule 2: pending -> active when listening", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });

  const { changed } = registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "active");
  assert.ok(changed[0].includes("pending -> active"));
});

test("rule 3: pending -> stale after pendingGraceSec with no listener", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });

  c.advance(CONFIG.pendingGraceSec * 1000 + 1000);
  const { changed } = registry.applyScan(new Set(), new Map(), CONFIG, c.get());

  const rec = registry.getByPort(20000);
  assert.equal(rec.status, "stale");
  assert.ok(rec.staleSince);
  assert.ok(changed[0].includes("pending -> stale"));
});

test("rule 3b: pending stays pending before grace expires", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });

  c.advance(CONFIG.pendingGraceSec * 1000 - 1000);
  registry.applyScan(new Set(), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "pending");
});

test("rule 4: active refreshes lastSeenListeningAt and observedProcess while listening", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());

  c.advance(10_000);
  const proc = { name: "node", pid: 555 };
  registry.applyScan(new Set([20000]), new Map([[20000, proc]]), CONFIG, c.get());

  const rec = registry.getByPort(20000);
  assert.equal(rec.status, "active");
  assert.deepEqual(rec.observedProcess, proc);
  assert.equal(rec.lastSeenListeningAt, new Date(c.get()).toISOString());
});

test("rule 5: active -> stale after staleGraceSec with no listener", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());

  c.advance(CONFIG.staleGraceSec * 1000 + 1000);
  const { changed } = registry.applyScan(new Set(), new Map(), CONFIG, c.get());

  assert.equal(registry.getByPort(20000).status, "stale");
  assert.ok(changed[0].includes("active -> stale"));
});

test("rule 6: stale -> active recovery clears staleSince", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());
  c.advance(CONFIG.staleGraceSec * 1000 + 1000);
  registry.applyScan(new Set(), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "stale");

  c.advance(1000);
  const { changed } = registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());

  const rec = registry.getByPort(20000);
  assert.equal(rec.status, "active");
  assert.equal(rec.staleSince, null);
  assert.ok(changed[0].includes("stale -> active"));
});

test("rule 7: reregister moves stale -> pending and refreshes registeredAt", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  c.advance(CONFIG.pendingGraceSec * 1000 + 1000);
  registry.applyScan(new Set(), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "stale");

  c.advance(5000);
  const rec = registry.reregister(20000);
  assert.equal(rec.status, "pending");
  assert.equal(rec.staleSince, null);
  assert.equal(rec.registeredAt, new Date(c.get()).toISOString());
});

test("reregister is a no-op when record is not stale", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "active");

  const before = { ...registry.getByPort(20000) };
  const rec = registry.reregister(20000);
  assert.deepEqual(rec, before);
});

test("rule 8: stale -> evicted after staleEvictSec", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  c.advance(CONFIG.pendingGraceSec * 1000 + 1000);
  registry.applyScan(new Set(), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "stale");

  c.advance(CONFIG.staleEvictSec * 1000 + 1000);
  const { changed } = registry.applyScan(new Set(), new Map(), CONFIG, c.get());

  assert.equal(registry.getByPort(20000), null);
  assert.ok(changed[0].includes("evicted"));
});

test("rule 9/10: release deletes regardless of status (used for stale eviction by takeover, or explicit release)", () => {
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath: tmpFile(), now: c.now });
  registry.register({ name: "app", port: 20000 });
  c.advance(CONFIG.pendingGraceSec * 1000 + 1000);
  registry.applyScan(new Set(), new Map(), CONFIG, c.get());
  assert.equal(registry.getByPort(20000).status, "stale");

  const released = registry.release(20000);
  assert.equal(released.name, "app");
  assert.equal(registry.getByPort(20000), null);
});

test("applyScan marks registry dirty only when something changed", () => {
  const filePath = tmpFile();
  const c = clock(1_000_000);
  const registry = createRegistry({ filePath, now: c.now });
  registry.register({ name: "app", port: 20000 });
  registry.persist();

  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get()); // pending->active: dirty
  registry.persistIfDirty();
  const mtime1 = fs.statSync(filePath).mtimeMs;

  // no change this tick (still active, still listening)
  registry.applyScan(new Set([20000]), new Map(), CONFIG, c.get());
  const dirtyBefore = fs.statSync(filePath).mtimeMs;
  assert.equal(dirtyBefore, mtime1); // not persisted, since persistIfDirty not called
});
