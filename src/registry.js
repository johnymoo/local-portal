import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_META_BYTES = 2048;
const RECOVERY_VERSION = 1;

export class RegistryPersistenceError extends Error {
  constructor(message, { cause, recoveryError } = {}) {
    super(message, { cause });
    this.name = "RegistryPersistenceError";
    this.code = "registry_persist_failed";
    this.status = 503;
    this.recoveryPending = Boolean(recoveryError);
    if (recoveryError) this.recoveryError = recoveryError;
  }
}

export function isValidName(name) {
  return typeof name === "string" && NAME_RE.test(name);
}

function genId() {
  return "reg_" + crypto.randomBytes(4).toString("hex");
}

function isValidTimestamp(value, { nullable = false } = {}) {
  if (value === null && nullable) return true;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isValidRecord(rec) {
  if (!rec || typeof rec !== "object") return false;
  if (typeof rec.id !== "string") return false;
  if (!isValidName(rec.name)) return false;
  if (!Number.isInteger(rec.port) || rec.port < 1 || rec.port > 65535) return false;
  if (!["pending", "active", "stale"].includes(rec.status)) return false;
  if (!isValidTimestamp(rec.registeredAt)) return false;
  if (!isValidTimestamp(rec.lastSeenListeningAt, { nullable: true })) return false;
  if (!isValidTimestamp(rec.staleSince, { nullable: true })) return false;
  return true;
}

/**
 * Registration records: CRUD + the port state machine (§5 of the plan) +
 * atomic JSON persistence. No timers, no network — clock is injected so
 * tests never sleep.
 */
export function createRegistry({ filePath, log, now = () => Date.now(), fsImpl = fs }) {
  /** @type {Map<number, object>} */
  let byPort = new Map();
  let dirty = false;
  const directory = path.dirname(filePath);
  const nextPath = `${filePath}.next`;
  const restorePath = `${filePath}.restore`;
  const rollbackPath = `${filePath}.rollback`;
  const rollbackTempPath = `${filePath}.rollback.tmp`;

  function pathExists(targetPath) {
    return fsImpl.existsSync(targetPath);
  }

  function unlinkIfPresent(targetPath) {
    try {
      fsImpl.unlinkSync(targetPath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  function closeIgnoringError(fd) {
    if (fd === undefined) return;
    try {
      fsImpl.closeSync(fd);
    } catch {
      // The original write/fsync error remains authoritative.
    }
  }

  function fsyncDirectory() {
    let fd;
    try {
      fd = fsImpl.openSync(directory, "r");
      fsImpl.fsyncSync(fd);
    } finally {
      closeIgnoringError(fd);
    }
  }

  function writeSyncedExclusive(targetPath, contents) {
    let fd;
    try {
      fd = fsImpl.openSync(
        targetPath,
        fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_WRONLY,
        0o600,
      );
      fsImpl.writeFileSync(fd, contents, "utf8");
      fsImpl.fsyncSync(fd);
    } finally {
      closeIgnoringError(fd);
    }
  }

  function snapshotText(records) {
    return `${JSON.stringify(
      {
        schemaVersion: SCHEMA_VERSION,
        updatedAt: new Date(now()).toISOString(),
        registrations: [...records.values()],
      },
      null,
      2,
    )}\n`;
  }

  function encodeRollback(previous) {
    const content = previous.exists ? previous.content : "";
    return `${JSON.stringify({
      recoveryVersion: RECOVERY_VERSION,
      targetExisted: previous.exists,
      contentBase64: Buffer.from(content, "utf8").toString("base64"),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    })}\n`;
  }

  function decodeRollback(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new RegistryPersistenceError(`invalid registry rollback record: ${err.message}`, {
        cause: err,
      });
    }
    if (
      !value ||
      value.recoveryVersion !== RECOVERY_VERSION ||
      typeof value.targetExisted !== "boolean" ||
      typeof value.contentBase64 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.sha256)
    ) {
      throw new RegistryPersistenceError("invalid registry rollback record shape");
    }
    const content = Buffer.from(value.contentBase64, "base64").toString("utf8");
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    if (digest !== value.sha256 || (!value.targetExisted && content !== "")) {
      throw new RegistryPersistenceError("registry rollback record checksum mismatch");
    }
    return { exists: value.targetExisted, content };
  }

  function cleanupStagingFiles() {
    let changed = false;
    for (const targetPath of [nextPath, restorePath, rollbackTempPath]) {
      changed = unlinkIfPresent(targetPath) || changed;
    }
    if (changed) fsyncDirectory();
  }

  function restorePreviousSnapshot(previous) {
    unlinkIfPresent(restorePath);
    if (previous.exists) {
      writeSyncedExclusive(restorePath, previous.content);
      fsImpl.renameSync(restorePath, filePath);
    } else {
      unlinkIfPresent(filePath);
    }
    fsyncDirectory();
    const removedRollback = unlinkIfPresent(rollbackPath);
    if (removedRollback) fsyncDirectory();
    cleanupStagingFiles();
  }

  function recoverInterruptedTransaction() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!pathExists(rollbackPath)) {
      cleanupStagingFiles();
      return false;
    }
    const previous = decodeRollback(fsImpl.readFileSync(rollbackPath, "utf8"));
    try {
      restorePreviousSnapshot(previous);
      log?.warn?.("registry", `recovered interrupted registry transaction for ${filePath}`);
      return true;
    } catch (err) {
      throw new RegistryPersistenceError(`failed to recover interrupted registry transaction: ${err.message}`, {
        cause: err,
        recoveryError: err,
      });
    }
  }

  function persistSnapshot(records) {
    let previous;
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      recoverInterruptedTransaction();
      previous = pathExists(filePath)
        ? { exists: true, content: fsImpl.readFileSync(filePath, "utf8") }
        : { exists: false, content: "" };
    } catch (err) {
      if (err instanceof RegistryPersistenceError) throw err;
      log?.error?.("registry", `failed to prepare registry transaction: ${err.message}`);
      throw new RegistryPersistenceError(`failed to prepare registry transaction: ${err.message}`, {
        cause: err,
      });
    }

    try {
      writeSyncedExclusive(rollbackTempPath, encodeRollback(previous));
      fsImpl.renameSync(rollbackTempPath, rollbackPath);
      fsyncDirectory();

      writeSyncedExclusive(nextPath, snapshotText(records));
      fsImpl.renameSync(nextPath, filePath);
      fsyncDirectory();

      fsImpl.unlinkSync(rollbackPath);
      fsyncDirectory();
      cleanupStagingFiles();
    } catch (err) {
      log?.error?.("registry", `failed to persist registry: ${err.message}`);
      let recoveryError;
      try {
        restorePreviousSnapshot(previous);
      } catch (restoreError) {
        recoveryError = restoreError;
        log?.error?.("registry", `registry rollback remains pending: ${restoreError.message}`);
      }
      throw new RegistryPersistenceError(`failed to persist registry: ${err.message}`, {
        cause: err,
        recoveryError,
      });
    }
  }

  function commitMutation(mutate) {
    const nextByPort = new Map(byPort);
    const result = mutate(nextByPort);
    if (!result.changed) return result.value;
    persistSnapshot(nextByPort);
    byPort = nextByPort;
    dirty = false;
    return result.value;
  }

  function quarantine(text, reason) {
    const quarantinePath = `${filePath}.corrupt-${now()}`;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(quarantinePath, text);
    } catch {
      // best effort - do not let quarantine failure crash startup
    }
    log?.error?.(
      "registry",
      `registry file corrupt (${reason}); quarantined to ${quarantinePath}, starting empty`
    );
  }

  function load() {
    recoverInterruptedTransaction();
    if (!fsImpl.existsSync(filePath)) {
      byPort = new Map();
      return { loaded: 0, quarantined: false };
    }

    const text = fsImpl.readFileSync(filePath, "utf8");
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
    persistSnapshot(byPort);
    dirty = false;
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
    return commitMutation((nextByPort) => {
      nextByPort.set(port, record);
      return { changed: true, value: record };
    });
  }

  /** Idempotent re-registration by (name, port): only mutates if currently stale (rule 7). */
  function reregister(port) {
    const record = byPort.get(port);
    if (!record) return null;
    if (record.status === "stale") {
      const refreshed = {
        ...record,
        status: "pending",
        registeredAt: new Date(now()).toISOString(),
        staleSince: null,
      };
      return commitMutation((nextByPort) => {
        nextByPort.set(port, refreshed);
        return { changed: true, value: refreshed };
      });
    }
    return record;
  }

  function release(port) {
    const record = byPort.get(port);
    if (!record) return null;
    return commitMutation((nextByPort) => {
      nextByPort.delete(port);
      return { changed: true, value: record };
    });
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
