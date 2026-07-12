import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SCHEMA_VERSION = 1;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION_LEN = 500;
export const MAX_META_BYTES = 2048;
const RECOVERY_VERSION = 1;
const COMMIT_VERSION = 1;
export const MAX_RECOVERY_RECORD_BYTES = 64 * 1024 * 1024;
const ROLLBACK_ENVELOPE_BYTES = Buffer.byteLength(
  `${JSON.stringify({
    recoveryVersion: RECOVERY_VERSION,
    targetExisted: true,
    contentBase64: "",
    sha256: "0".repeat(64),
  })}\n`,
  "utf8",
);
export const MAX_REGISTRY_BYTES =
  Math.floor((MAX_RECOVERY_RECORD_BYTES - ROLLBACK_ENVELOPE_BYTES) / 4) * 3;

export class RegistryPersistenceError extends Error {
  constructor(message, { cause, recoveryError, recoveryPending = false } = {}) {
    super(message, { cause });
    this.name = "RegistryPersistenceError";
    this.code = "registry_persist_failed";
    this.status = 503;
    this.recoveryPending = recoveryPending || Boolean(recoveryError);
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
  const commitPath = `${filePath}.commit`;
  const commitTempPath = `${filePath}.commit.tmp`;

  function unlinkIfPresent(targetPath) {
    try {
      fsImpl.unlinkSync(targetPath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw err;
    }
  }

  function closeOwnedFd(fd, primaryError) {
    if (fd === undefined) return;
    try {
      fsImpl.closeSync(fd);
    } catch (closeError) {
      if (!primaryError) throw closeError;
      primaryError.closeErrors = [...(primaryError.closeErrors ?? []), closeError];
    }
  }

  function recoveryError(message, cause) {
    return new RegistryPersistenceError(message, { cause });
  }

  function validateRecoveryStat(
    stat,
    label,
    maxBytes = MAX_RECOVERY_RECORD_BYTES,
    { requireMode = true } = {},
  ) {
    if (!stat.isFile()) throw recoveryError(`${label} must be a regular file`);
    if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
      throw recoveryError(`${label} must be owned by the current user`);
    }
    if (requireMode && (stat.mode & 0o777) !== 0o600) {
      throw recoveryError(`${label} mode must be 0600`);
    }
    if (stat.size > maxBytes) throw recoveryError(`${label} exceeds the size limit`);
  }

  function lstatIfPresent(targetPath) {
    try {
      return fsImpl.lstatSync(targetPath);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw recoveryError(`unable to inspect recovery path ${targetPath}: ${err.message}`, err);
    }
  }

  function readRecoveryFile(
    targetPath,
    label,
    { maxBytes = MAX_RECOVERY_RECORD_BYTES, migrateMode = false } = {},
  ) {
    const pathStat = lstatIfPresent(targetPath);
    if (!pathStat) return null;
    validateRecoveryStat(pathStat, label, maxBytes, { requireMode: !migrateMode });

    let fd;
    let primaryError;
    try {
      const flags =
        fsImpl.constants.O_RDONLY |
        (fsImpl.constants.O_NOFOLLOW ?? 0) |
        (fsImpl.constants.O_NONBLOCK ?? 0);
      fd = fsImpl.openSync(targetPath, flags);
      const descriptorStat = fsImpl.fstatSync(fd);
      validateRecoveryStat(descriptorStat, label, maxBytes, { requireMode: !migrateMode });
      const currentPathStat = fsImpl.lstatSync(targetPath);
      validateRecoveryStat(currentPathStat, label, maxBytes, { requireMode: !migrateMode });
      if (
        descriptorStat.dev !== pathStat.dev ||
        descriptorStat.ino !== pathStat.ino ||
        descriptorStat.size !== pathStat.size ||
        currentPathStat.dev !== descriptorStat.dev ||
        currentPathStat.ino !== descriptorStat.ino ||
        currentPathStat.size !== descriptorStat.size
      ) {
        throw recoveryError(`${label} changed while it was being opened`);
      }

      if (
        migrateMode &&
        ((pathStat.mode & 0o777) !== 0o600 ||
          (descriptorStat.mode & 0o777) !== 0o600 ||
          (currentPathStat.mode & 0o777) !== 0o600)
      ) {
        fsImpl.fchmodSync(fd, 0o600);
        fsImpl.fsyncSync(fd);
        fsyncDirectory();

        const migratedDescriptorStat = fsImpl.fstatSync(fd);
        const migratedPathStat = fsImpl.lstatSync(targetPath);
        validateRecoveryStat(migratedDescriptorStat, label, maxBytes);
        validateRecoveryStat(migratedPathStat, label, maxBytes);
        if (
          migratedDescriptorStat.dev !== descriptorStat.dev ||
          migratedDescriptorStat.ino !== descriptorStat.ino ||
          migratedDescriptorStat.size !== descriptorStat.size ||
          migratedPathStat.dev !== descriptorStat.dev ||
          migratedPathStat.ino !== descriptorStat.ino ||
          migratedPathStat.size !== descriptorStat.size
        ) {
          throw recoveryError(`${label} changed while its mode was being secured`);
        }
      }

      const contents = Buffer.alloc(descriptorStat.size);
      let offset = 0;
      while (offset < contents.length) {
        const bytesRead = fsImpl.readSync(
          fd,
          contents,
          offset,
          contents.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const extraByte = Buffer.alloc(1);
      const grewWhileReading = fsImpl.readSync(fd, extraByte, 0, 1, descriptorStat.size) !== 0;
      const afterReadStat = fsImpl.fstatSync(fd);
      validateRecoveryStat(afterReadStat, label, maxBytes);
      const afterReadPathStat = fsImpl.lstatSync(targetPath);
      validateRecoveryStat(afterReadPathStat, label, maxBytes);
      if (
        offset !== descriptorStat.size ||
        grewWhileReading ||
        afterReadStat.dev !== descriptorStat.dev ||
        afterReadStat.ino !== descriptorStat.ino ||
        afterReadStat.size !== descriptorStat.size ||
        afterReadPathStat.dev !== descriptorStat.dev ||
        afterReadPathStat.ino !== descriptorStat.ino ||
        afterReadPathStat.size !== descriptorStat.size
      ) {
        throw recoveryError(`${label} changed while it was being read`);
      }
      return {
        text: contents.toString("utf8"),
        identity: {
          dev: descriptorStat.dev,
          ino: descriptorStat.ino,
          size: descriptorStat.size,
        },
      };
    } catch (err) {
      primaryError =
        err instanceof RegistryPersistenceError
          ? err
          : recoveryError(`unable to read ${label}: ${err.message}`, err);
      throw primaryError;
    } finally {
      try {
        closeOwnedFd(fd, primaryError);
      } catch (closeError) {
        throw recoveryError(`unable to close ${label}: ${closeError.message}`, closeError);
      }
    }
  }

  function assertRecoveryPathIdentity(targetPath, expected, label) {
    const current = lstatIfPresent(targetPath);
    if (!current) throw recoveryError(`${label} disappeared after it was read`);
    validateRecoveryStat(current, label);
    if (
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      current.size !== expected.size
    ) {
      throw recoveryError(`${label} changed after it was read`);
    }
  }

  function fsyncDirectory() {
    let fd;
    let primaryError;
    try {
      fd = fsImpl.openSync(directory, "r");
      fsImpl.fsyncSync(fd);
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      closeOwnedFd(fd, primaryError);
    }
  }

  function writeSyncedExclusive(targetPath, contents) {
    let fd;
    let primaryError;
    try {
      fd = fsImpl.openSync(
        targetPath,
        fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | fsImpl.constants.O_WRONLY,
        0o600,
      );
      fsImpl.writeFileSync(fd, contents, "utf8");
      fsImpl.fsyncSync(fd);
    } catch (err) {
      primaryError = err;
      throw err;
    } finally {
      closeOwnedFd(fd, primaryError);
    }
  }

  function assertTextWithinLimit(contents, maxBytes, label) {
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      throw recoveryError(`${label} exceeds the size limit`);
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
    const encoded = `${JSON.stringify({
      recoveryVersion: RECOVERY_VERSION,
      targetExisted: previous.exists,
      contentBase64: Buffer.from(content, "utf8").toString("base64"),
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    })}\n`;
    assertTextWithinLimit(encoded, MAX_RECOVERY_RECORD_BYTES, "registry rollback record");
    return encoded;
  }

  function encodeCommit(snapshot) {
    return `${JSON.stringify({
      commitVersion: COMMIT_VERSION,
      snapshotSha256: crypto.createHash("sha256").update(snapshot).digest("hex"),
    })}\n`;
  }

  function decodeCommit(text) {
    let value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw recoveryError(`invalid registry commit marker: ${err.message}`, err);
    }
    if (
      !value ||
      value.commitVersion !== COMMIT_VERSION ||
      typeof value.snapshotSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.snapshotSha256)
    ) {
      throw recoveryError("invalid registry commit marker shape");
    }
    return value;
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
    for (const targetPath of [nextPath, restorePath, rollbackTempPath, commitTempPath]) {
      changed = unlinkIfPresent(targetPath) || changed;
    }
    if (changed) fsyncDirectory();
  }

  function installRollbackRecord(previous) {
    unlinkIfPresent(rollbackTempPath);
    writeSyncedExclusive(rollbackTempPath, encodeRollback(previous));
    fsImpl.renameSync(rollbackTempPath, rollbackPath);
    fsyncDirectory();
  }

  function ensureRollbackRecord(previous) {
    if (lstatIfPresent(rollbackPath)) return;
    installRollbackRecord(previous);
  }

  function restorePreviousSnapshot(previous, { retainRollback = false } = {}) {
    unlinkIfPresent(restorePath);
    if (previous.exists) {
      writeSyncedExclusive(restorePath, previous.content);
      fsImpl.renameSync(restorePath, filePath);
    } else {
      unlinkIfPresent(filePath);
    }
    fsyncDirectory();
    if (!retainRollback) {
      const removedCommit = unlinkIfPresent(commitPath);
      if (removedCommit) fsyncDirectory();
      const removedRollback = unlinkIfPresent(rollbackPath);
      if (removedRollback) fsyncDirectory();
    }
    cleanupStagingFiles();
  }

  function recoverInterruptedTransaction() {
    fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const rollbackFile = readRecoveryFile(rollbackPath, "registry rollback record");
    const commitFile = readRecoveryFile(commitPath, "registry commit marker");
    if (rollbackFile === null && commitFile === null) {
      cleanupStagingFiles();
      return false;
    }
    if (rollbackFile === null) {
      const commit = decodeCommit(commitFile.text);
      const snapshotFile = readRecoveryFile(filePath, "committed registry snapshot", {
        maxBytes: MAX_REGISTRY_BYTES,
        migrateMode: true,
      });
      if (!snapshotFile) throw recoveryError("committed registry snapshot is missing");
      const digest = crypto.createHash("sha256").update(snapshotFile.text).digest("hex");
      if (digest !== commit.snapshotSha256) {
        throw recoveryError("committed registry snapshot checksum mismatch");
      }
      assertRecoveryPathIdentity(
        filePath,
        snapshotFile.identity,
        "committed registry snapshot",
      );
      fsImpl.unlinkSync(commitPath);
      fsyncDirectory();
      cleanupStagingFiles();
      return true;
    }

    const previous = decodeRollback(rollbackFile.text);
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
    const snapshot = snapshotText(records);
    assertTextWithinLimit(snapshot, MAX_REGISTRY_BYTES, "registry snapshot");

    let previous;
    try {
      fsImpl.mkdirSync(directory, { recursive: true, mode: 0o700 });
      recoverInterruptedTransaction();
      const previousFile = readRecoveryFile(filePath, "existing registry snapshot", {
        migrateMode: true,
      });
      previous = previousFile
        ? { exists: true, content: previousFile.text }
        : { exists: false, content: "" };
      assertTextWithinLimit(previous.content, MAX_REGISTRY_BYTES, "existing registry snapshot");
    } catch (err) {
      if (err instanceof RegistryPersistenceError) throw err;
      log?.error?.("registry", `failed to prepare registry transaction: ${err.message}`);
      throw new RegistryPersistenceError(`failed to prepare registry transaction: ${err.message}`, {
        cause: err,
      });
    }

    try {
      installRollbackRecord(previous);

      writeSyncedExclusive(nextPath, snapshot);
      fsImpl.renameSync(nextPath, filePath);
      fsyncDirectory();

      writeSyncedExclusive(commitTempPath, encodeCommit(snapshot));
      fsImpl.renameSync(commitTempPath, commitPath);
      fsyncDirectory();

      fsImpl.unlinkSync(rollbackPath);
      fsyncDirectory();
      cleanupStagingFiles();
    } catch (err) {
      log?.error?.("registry", `failed to persist registry: ${err.message}`);
      let recoveryError;
      try {
        ensureRollbackRecord(previous);
        restorePreviousSnapshot(previous, { retainRollback: true });
      } catch (restoreError) {
        recoveryError = restoreError;
        log?.error?.("registry", `registry rollback remains pending: ${restoreError.message}`);
      }
      throw new RegistryPersistenceError(`failed to persist registry: ${err.message}`, {
        cause: err,
        recoveryError,
        recoveryPending: true,
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
    const snapshotFile = readRecoveryFile(filePath, "registry snapshot", { migrateMode: true });
    if (!snapshotFile) {
      byPort = new Map();
      return { loaded: 0, quarantined: false };
    }

    const text = snapshotFile.text;
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
