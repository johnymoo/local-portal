import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_META_BYTES = 2048;

export function isValidName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

function genId() {
  return "reg_" + crypto.randomBytes(4).toString("hex");
}

function isValidRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (typeof rec.id !== "string") return false;
  if (!isValidName(rec.name)) return false;
  if (!Number.isInteger(rec.port) || rec.port < 1 || rec.port > 65535) return false;
  if (!["pending", "active", "stale"].includes(rec.status)) return false;
  if (typeof rec.registeredAt !== "string") return false;
  return true;
}

/**
 * Registration records: CRUD + the port state machine (§5 of the plan) +
 * atomic JSON persistence. No timers, no network — clock is injected so
 * tests never sleep.
 */
export function createRegistry({ filePath, log, now = () => Date.now() }) {
  /** @type {Map<number, object>} */
  let byPort = new Map();
  let dirty = false;

  function quarantine(text, reason) {
    const quarantinePath = `${filePath}.corrupt-${now()}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(quarantinePath, text);
    } catch {
      // best effort - do not let quarantine failure crash startup
    }
    log?.error?.(
      "registry",
      `registry file corrupt (${reason}); quarantined to ${quarantinePath}, starting empty`
    );
  }

  function load() {
    if (!fs.existsSync(filePath)) {
      byPort = new Map();
      return { loaded: 0, quarantined: false };
    }

    const text = fs.readFileSync(filePath, "utf8");
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      quarantine(text, `invalid JSON: ${err.message}`);
      byPort = new Map();
      return { loaded: 0, quarantined: true };
    }

    if (!data || typeof data !== "object" || data.schemaVersion !== SCHEMA_VERSION || !Array.isArray(data.registrations)) {
      quarantine(text, "unsupported schemaVersion or shape");
      byPort = new Map();
      return { loaded: 0, quarantined: true };
    }

    byPort = new Map();
    let dropped = 0;
    for (const rec of data.registrations) {
      if (!isValidRecord(rec)) {
        dropped++;
        log?.warn?.("registry", `dropping invalid registry record: ${JSON.stringify(rec).slice(0, 200)}`);
        continue;
      }
      byPort.set(rec.port, rec);
    }
    if (dropped > 0) {
      log?.warn?.("registry", `dropped ${dropped} invalid record(s) while loading ${filePath}`);
    }
    return { loaded: byPort.size, quarantined: false };
  }

  function persist() {
    const data = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date(now()).toISOString(),
      registrations: [...byPort.values()],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf8");
      fs.renameSync(tmpPath, filePath);
      dirty = false;
    } catch (err) {
      log?.error?.("registry", `failed to persist registry: ${err.message}`);
    }
  }

  function persistIfDirty() {
    if (dirty) persist();
  }

  function markDirty() {
    dirty = true;
  }

  function all() {
    return [...byPort.values()];
  }

  function getByPort(port) {
    return byPort.get(port) ?? null;
  }

  function getByName(name) {
    return all().filter((r) => r.name === name);
  }

  function register({ name, description = "", port, requestedPort = null, meta = {} }) {
    const record = {
      id: genId(),
      name,
      description,
      port,
      requestedPort,
      status: "pending",
      registeredAt: new Date(now()).toISOString(),
      lastSeenListeningAt: null,
      staleSince: null,
      observedProcess: null,
      meta,
    };
    byPort.set(port, record);
    markDirty();
    return record;
  }

  /** Idempotent re-registration by (name, port): only mutates if currently stale (rule 7). */
  function reregister(port) {
    const record = byPort.get(port);
    if (!record) return null;
    if (record.status === "stale") {
      record.status = "pending";
      record.registeredAt = new Date(now()).toISOString();
      record.staleSince = null;
      markDirty();
    }
    return record;
  }

  function release(port) {
    const record = byPort.get(port);
    if (!record) return null;
    byPort.delete(port);
    markDirty();
    return record;
  }

  /**
   * Drive the registration state machine from a fresh OS scan (§5).
   * listenSet: Set<number> of ports currently listening (any address family).
   * processInfo: Map<number, {name, pid}> observed process for a listening port.
   * config: {pendingGraceSec, staleGraceSec, staleEvictSec}.
   * nowMs: injected clock (epoch ms) so grace-period math never sleeps in tests.
   */
  function applyScan(listenSet, processInfo, config, nowMs) {
    const changed = [];
    const nowIso = new Date(nowMs).toISOString();
    const toDelete = [];

    for (const record of byPort.values()) {
      const listening = listenSet.has(record.port);
      const proc = processInfo?.get(record.port) ?? null;

      if (listening) {
        const prevStatus = record.status;
        record.lastSeenListeningAt = nowIso;
        if (proc) record.observedProcess = proc;
        if (record.status !== "active") {
          record.status = "active";
          record.staleSince = null;
          changed.push(`${record.name}:${record.port} ${prevStatus} -> active`);
        }
        continue;
      }

      if (record.status === "pending") {
        const registeredAtMs = Date.parse(record.registeredAt);
        if (nowMs - registeredAtMs > config.pendingGraceSec * 1000) {
          record.status = "stale";
          record.staleSince = nowIso;
          changed.push(`${record.name}:${record.port} pending -> stale (grace expired)`);
        }
      } else if (record.status === "active") {
        const lastSeenMs = Date.parse(record.lastSeenListeningAt ?? record.registeredAt);
        if (nowMs - lastSeenMs > config.staleGraceSec * 1000) {
          record.status = "stale";
          record.staleSince = nowIso;
          changed.push(`${record.name}:${record.port} active -> stale`);
        }
      } else if (record.status === "stale") {
        const staleSinceMs = Date.parse(record.staleSince ?? record.registeredAt);
        if (nowMs - staleSinceMs > config.staleEvictSec * 1000) {
          toDelete.push(record.port);
          changed.push(`${record.name}:${record.port} stale -> evicted`);
        }
      }
    }

    for (const port of toDelete) byPort.delete(port);
    if (changed.length > 0) markDirty();

    return { changed };
  }

  return {
    load,
    persist,
    persistIfDirty,
    markDirty,
    all,
    getByPort,
    getByName,
    register,
    reregister,
    release,
    applyScan,
  };
}
