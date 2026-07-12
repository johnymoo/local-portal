import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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

function failPersistenceOnce(failure, filePath) {
  const fdPaths = new Map();
  let failed = false;
  let mainRenamed = false;
  const fail = () => {
    failed = true;
    const error = new Error(`injected ${failure}`);
    error.code = "EIO";
    throw error;
  };

  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          if (!failed && failure === "temp-create" && targetPath === `${filePath}.next`) fail();
          const fd = target.openSync(targetPath, flags, mode);
          fdPaths.set(fd, targetPath);
          return fd;
        };
      }
      if (property === "closeSync") {
        return (fd) => {
          fdPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === "writeFileSync") {
        return (targetPath, ...args) => {
          const resolvedPath = typeof targetPath === "number" ? fdPaths.get(targetPath) : targetPath;
          if (!failed && failure === "write" && resolvedPath === `${filePath}.next`) fail();
          return target.writeFileSync(targetPath, ...args);
        };
      }
      if (property === "fsyncSync") {
        return (fd) => {
          const targetPath = fdPaths.get(fd);
          if (!failed && failure === "file-fsync" && targetPath === `${filePath}.next`) fail();
          if (!failed && failure === "parent-fsync" && mainRenamed && targetPath === path.dirname(filePath)) fail();
          return target.fsyncSync(fd);
        };
      }
      if (property === "renameSync") {
        return (source, destination) => {
          if (!failed && failure === "rename" && source === `${filePath}.next` && destination === filePath) fail();
          const result = target.renameSync(source, destination);
          if (source === `${filePath}.next` && destination === filePath) mainRenamed = true;
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failCommitFsyncAndImmediateRollback(filePath) {
  const fdPaths = new Map();
  let mainRenamed = false;
  let commitFsyncFailed = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          const fd = target.openSync(targetPath, flags, mode);
          fdPaths.set(fd, targetPath);
          return fd;
        };
      }
      if (property === "closeSync") {
        return (fd) => {
          fdPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === "fsyncSync") {
        return (fd) => {
          if (!commitFsyncFailed && mainRenamed && fdPaths.get(fd) === path.dirname(filePath)) {
            commitFsyncFailed = true;
            const error = new Error("injected commit parent fsync failure");
            error.code = "EIO";
            throw error;
          }
          return target.fsyncSync(fd);
        };
      }
      if (property === "renameSync") {
        return (source, destination) => {
          if (source === `${filePath}.restore` && destination === filePath) {
            const error = new Error("injected immediate rollback failure");
            error.code = "EIO";
            throw error;
          }
          const result = target.renameSync(source, destination);
          if (source === `${filePath}.next` && destination === filePath) mainRenamed = true;
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failAfterRollbackRemoval(filePath, restoreFailure) {
  const fdPaths = new Map();
  let rollbackRemoved = false;
  let primaryFailed = false;
  let restoreRenamed = false;
  const injected = (message) => {
    const error = new Error(message);
    error.code = "EIO";
    return error;
  };
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          const fd = target.openSync(targetPath, flags, mode);
          fdPaths.set(fd, targetPath);
          return fd;
        };
      }
      if (property === "closeSync") {
        return (fd) => {
          fdPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === "unlinkSync") {
        return (targetPath) => {
          const result = target.unlinkSync(targetPath);
          if (targetPath === `${filePath}.rollback`) rollbackRemoved = true;
          return result;
        };
      }
      if (property === "renameSync") {
        return (source, destination) => {
          if (primaryFailed && restoreFailure === "rename" && source === `${filePath}.restore`) {
            throw injected("injected restore rename failure");
          }
          const result = target.renameSync(source, destination);
          if (source === `${filePath}.restore` && destination === filePath) restoreRenamed = true;
          return result;
        };
      }
      if (property === "fsyncSync") {
        return (fd) => {
          const targetPath = fdPaths.get(fd);
          if (!primaryFailed && rollbackRemoved && targetPath === path.dirname(filePath)) {
            primaryFailed = true;
            throw injected("injected post-unlink parent fsync failure");
          }
          if (primaryFailed && restoreFailure === "fsync" && restoreRenamed && targetPath === path.dirname(filePath)) {
            throw injected("injected restore parent fsync failure");
          }
          return target.fsyncSync(fd);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failRollbackRemovalOnce(filePath) {
  let failed = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "unlinkSync") {
        return (targetPath) => {
          if (!failed && targetPath === `${filePath}.rollback`) {
            failed = true;
            const error = new Error("injected rollback removal failure");
            error.code = "EIO";
            throw error;
          }
          return target.unlinkSync(targetPath);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function failNextClose(filePath, { failFsync = false } = {}) {
  const fdPaths = new Map();
  let fsyncFailed = false;
  let closeFailed = false;
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          const fd = target.openSync(targetPath, flags, mode);
          fdPaths.set(fd, targetPath);
          return fd;
        };
      }
      if (property === "fsyncSync") {
        return (fd) => {
          if (failFsync && !fsyncFailed && fdPaths.get(fd) === `${filePath}.next`) {
            fsyncFailed = true;
            const error = new Error("injected next snapshot fsync failure");
            error.code = "EIO";
            throw error;
          }
          return target.fsyncSync(fd);
        };
      }
      if (property === "closeSync") {
        return (fd) => {
          const targetPath = fdPaths.get(fd);
          fdPaths.delete(fd);
          const result = target.closeSync(fd);
          if (!closeFailed && targetPath === `${filePath}.next`) {
            closeFailed = true;
            const error = new Error("injected next snapshot close failure");
            error.code = "EIO";
            throw error;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function largeRegistrySnapshot(payloadBytes = 49 * 1024 * 1024) {
  return `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(1_000_000).toISOString(),
    registrations: [
      {
        id: "reg_large",
        name: "large-owner",
        description: "",
        port: 20000,
        requestedPort: null,
        status: "active",
        registeredAt: new Date(1_000_000).toISOString(),
        lastSeenListeningAt: new Date(1_000_000).toISOString(),
        staleSince: null,
        observedProcess: null,
        meta: {},
        padding: "x".repeat(payloadBytes),
      },
    ],
  })}\n`;
}

function registrySnapshot(name = "legacy-owner") {
  return `${JSON.stringify({
    schemaVersion: 1,
    updatedAt: new Date(1_000_000).toISOString(),
    registrations: [
      {
        id: `reg_${name}`,
        name,
        description: "",
        port: 20000,
        requestedPort: null,
        status: "active",
        registeredAt: new Date(1_000_000).toISOString(),
        lastSeenListeningAt: new Date(1_000_000).toISOString(),
        staleSince: null,
        observedProcess: null,
        meta: {},
      },
    ],
  })}\n`;
}

function failSecondModeMigration(filePath, stage) {
  const fdPaths = new Map();
  let attempts = 0;
  let failRevalidation = false;
  const injected = () => {
    const error = new Error(`injected registry migration ${stage} failure`);
    error.code = "EIO";
    throw error;
  };
  return new Proxy(fs, {
    get(target, property) {
      if (property === "openSync") {
        return (targetPath, flags, mode) => {
          const fd = target.openSync(targetPath, flags, mode);
          fdPaths.set(fd, targetPath);
          return fd;
        };
      }
      if (property === "closeSync") {
        return (fd) => {
          fdPaths.delete(fd);
          return target.closeSync(fd);
        };
      }
      if (property === "fchmodSync") {
        return (fd, mode) => {
          if (fdPaths.get(fd) === filePath) {
            attempts += 1;
            if (attempts === 2 && stage === "fchmod") injected();
          }
          return target.fchmodSync(fd, mode);
        };
      }
      if (property === "fsyncSync") {
        return (fd) => {
          if (attempts === 2 && fdPaths.get(fd) === filePath) {
            if (stage === "fsync") injected();
            if (stage === "revalidation") failRevalidation = true;
          }
          if (
            attempts === 2 &&
            stage === "parent-fsync" &&
            fdPaths.get(fd) === path.dirname(filePath)
          ) {
            injected();
          }
          return target.fsyncSync(fd);
        };
      }
      if (property === "lstatSync") {
        return (targetPath) => {
          if (targetPath === filePath && failRevalidation) {
            failRevalidation = false;
            injected();
          }
          return target.lstatSync(targetPath);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function rollbackRecord(content, targetExisted = true) {
  return `${JSON.stringify({
    recoveryVersion: 1,
    targetExisted,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  })}\n`;
}

function seedRollbackFixture() {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });
  const content = fs.readFileSync(filePath, "utf8");
  return { filePath, content, rollbackPath: `${filePath}.rollback` };
}

function assertOnlyRegistryFileRemains(filePath) {
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)).sort(), [path.basename(filePath)]);
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

test("current-owner 0664 registry is secured before register and release", () => {
  const filePath = tmpFile();
  fs.writeFileSync(filePath, registrySnapshot(), { mode: 0o600 });
  fs.chmodSync(filePath, 0o664);

  const registry = createRegistry({ filePath, now: () => 2_000_000 });
  registry.load();
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  registry.register({ name: "new-owner", port: 20001 });

  const afterRegister = createRegistry({ filePath, now: () => 3_000_000 });
  afterRegister.load();
  assert.equal(afterRegister.getByPort(20000)?.name, "legacy-owner");
  assert.equal(afterRegister.getByPort(20001)?.name, "new-owner");
  afterRegister.release(20000);

  const afterRelease = createRegistry({ filePath, now: () => 4_000_000 });
  afterRelease.load();
  assert.equal(afterRelease.getByPort(20000), null);
  assert.equal(afterRelease.getByPort(20001)?.name, "new-owner");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

for (const stage of ["fchmod", "fsync", "parent-fsync", "revalidation"]) {
  test(`registry mode migration ${stage} failure cannot acknowledge a mutation`, () => {
    const filePath = tmpFile();
    fs.writeFileSync(filePath, registrySnapshot(), { mode: 0o600 });
    fs.chmodSync(filePath, 0o664);
    const registry = createRegistry({ filePath, fsImpl: failSecondModeMigration(filePath, stage) });
    registry.load();
    fs.chmodSync(filePath, 0o664);

    assert.throws(
      () => registry.release(20000),
      (error) =>
        error.code === "registry_persist_failed" &&
        error.message.includes(`injected registry migration ${stage} failure`),
    );
    assert.equal(registry.getByPort(20000)?.name, "legacy-owner");
    assertOnlyRegistryFileRemains(filePath);

    const restarted = createRegistry({ filePath });
    restarted.load();
    assert.equal(restarted.getByPort(20000)?.name, "legacy-owner");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  });
}

for (const scenario of ["symlink", "directory", "wrong-owner"]) {
  test(`unsafe main registry ${scenario} is rejected without being followed or changed`, () => {
    const filePath = tmpFile();
    let fsImpl = fs;
    let target;
    if (scenario === "symlink") {
      target = `${filePath}.target`;
      fs.writeFileSync(target, registrySnapshot(), { mode: 0o600 });
      fs.chmodSync(target, 0o664);
      fs.symlinkSync(target, filePath);
    } else if (scenario === "directory") {
      fs.mkdirSync(filePath, { mode: 0o700 });
    } else {
      fs.writeFileSync(filePath, registrySnapshot(), { mode: 0o600 });
      fsImpl = new Proxy(fs, {
        get(targetFs, property) {
          if (property === "lstatSync" || property === "fstatSync") {
            return (...args) => {
              const stat = targetFs[property](...args);
              return new Proxy(stat, {
                get(statTarget, statProperty) {
                  if (statProperty === "uid") return statTarget.uid + 1;
                  const value = Reflect.get(statTarget, statProperty);
                  return typeof value === "function" ? value.bind(statTarget) : value;
                },
              });
            };
          }
          const value = Reflect.get(targetFs, property);
          return typeof value === "function" ? value.bind(targetFs) : value;
        },
      });
    }

    const registry = createRegistry({ filePath, fsImpl });
    assert.throws(() => registry.load(), (error) => error.code === "registry_persist_failed");
    assert.equal(registry.all().length, 0);
    if (target) assert.equal(fs.statSync(target).mode & 0o777, 0o664);
  });
}

test("FIFO main registry is rejected without blocking", () => {
  const filePath = tmpFile();
  execFileSync("mkfifo", [filePath]);
  const registryUrl = new URL("../src/registry.js", import.meta.url).href;
  const script = `
    import { createRegistry } from ${JSON.stringify(registryUrl)};
    try {
      createRegistry({ filePath: ${JSON.stringify(filePath)} }).load();
      process.exit(2);
    } catch (error) {
      process.exit(error.code === "registry_persist_failed" ? 0 : 3);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 1_000,
  });
  assert.equal(child.signal, null, child.stderr?.toString());
  assert.equal(child.status, 0, child.stderr?.toString());
});

test("oversized legacy snapshot is rejected before creating unreadable rollback evidence", () => {
  const filePath = tmpFile();
  fs.writeFileSync(filePath, largeRegistrySnapshot(), { mode: 0o600 });
  const registry = createRegistry({
    filePath,
    now: () => 2_000_000,
    fsImpl: failPersistenceOnce("parent-fsync", filePath),
  });
  registry.load();

  assert.throws(
    () => registry.release(20000),
    (error) => error.code === "registry_persist_failed" && error.recoveryPending === false,
  );
  assert.equal(registry.getByPort(20000)?.name, "large-owner");
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)).sort(), [path.basename(filePath)]);

  const restarted = createRegistry({ filePath, now: () => 3_000_000 });
  restarted.load();
  assert.equal(restarted.getByPort(20000)?.name, "large-owner");
});

test("oversized next snapshot is rejected before creating transaction artifacts", () => {
  const filePath = tmpFile();
  const registry = createRegistry({ filePath, now: () => 1_000_000 });

  assert.throws(
    () =>
      registry.register({
        name: "oversized-next",
        description: "x".repeat(49 * 1024 * 1024),
        port: 20000,
      }),
    (error) => error.code === "registry_persist_failed" && error.recoveryPending === false,
  );
  assert.equal(registry.getByPort(20000), null);
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)), []);

  const restarted = createRegistry({ filePath });
  restarted.load();
  assert.equal(restarted.all().length, 0);
});

test("close failure after a synced next snapshot prevents mutation acknowledgement", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });

  const registry = createRegistry({ filePath, fsImpl: failNextClose(filePath) });
  registry.load();
  assert.throws(
    () => registry.register({ name: "new-owner", port: 20001 }),
    (error) =>
      error.code === "registry_persist_failed" &&
      error.cause?.message === "injected next snapshot close failure",
  );
  assert.equal(registry.getByPort(20001), null);

  const restarted = createRegistry({ filePath });
  restarted.load();
  assert.equal(restarted.getByPort(20000)?.name, "old-owner");
  assert.equal(restarted.getByPort(20001), null);
});

test("close failure is recorded without replacing the primary fsync failure", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });

  const registry = createRegistry({
    filePath,
    fsImpl: failNextClose(filePath, { failFsync: true }),
  });
  registry.load();
  assert.throws(
    () => registry.register({ name: "new-owner", port: 20001 }),
    (error) =>
      error.code === "registry_persist_failed" &&
      error.cause?.message === "injected next snapshot fsync failure" &&
      error.cause?.closeErrors?.[0]?.message === "injected next snapshot close failure",
  );
  assert.equal(registry.getByPort(20001), null);
});

for (const operation of ["register", "release"]) {
  for (const failure of ["temp-create", "write", "file-fsync", "rename", "parent-fsync"]) {
    test(`${operation} ${failure} failure preserves memory and restart state`, () => {
      const filePath = tmpFile();
      const seed = createRegistry({ filePath, now: () => 1_000_000 });
      seed.register({ name: "old-owner", port: 20000 });
      seed.persist();

      const registry = createRegistry({
        filePath,
        now: () => 2_000_000,
        fsImpl: failPersistenceOnce(failure, filePath),
      });
      registry.load();

      assert.throws(
        () =>
          operation === "register"
            ? registry.register({ name: "new-owner", port: 20001 })
            : registry.release(20000),
        (error) => error.code === "registry_persist_failed" && error.status === 503,
      );

      assert.equal(registry.getByPort(20000)?.name, "old-owner");
      assert.equal(registry.getByPort(20001), null);

      const restarted = createRegistry({ filePath, now: () => 3_000_000 });
      restarted.load();
      assert.equal(restarted.getByPort(20000)?.name, "old-owner");
      assert.equal(restarted.getByPort(20001), null);
      assertOnlyRegistryFileRemains(filePath);
    });
  }
}

test("successful register and release acknowledgements match fresh restart state", () => {
  const filePath = tmpFile();
  const registry = createRegistry({ filePath, now: () => 1_000_000 });

  const registered = registry.register({ name: "durable-app", port: 20000 });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${filePath}.commit`).mode & 0o777, 0o600);
  const afterRegister = createRegistry({ filePath, now: () => 2_000_000 });
  afterRegister.load();
  assert.equal(afterRegister.getByPort(20000)?.id, registered.id);
  assert.equal(fs.existsSync(`${filePath}.commit`), false);

  registry.release(20000);
  assert.equal(fs.existsSync(`${filePath}.commit`), true);
  const afterRelease = createRegistry({ filePath, now: () => 3_000_000 });
  afterRelease.load();
  assert.equal(afterRelease.getByPort(20000), null);
  assertOnlyRegistryFileRemains(filePath);
});

test("commit-only recovery rejects a main snapshot replaced before marker cleanup", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "committed-owner", port: 20000 });
  assert.equal(fs.existsSync(`${filePath}.commit`), true);

  const replacementPath = `${filePath}.replacement`;
  fs.writeFileSync(
    replacementPath,
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: new Date(2_000_000).toISOString(),
      registrations: [],
    })}\n`,
    { mode: 0o600 },
  );

  let mainPathChecks = 0;
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === "lstatSync") {
        return (targetPath) => {
          if (targetPath === filePath) {
            mainPathChecks += 1;
            if (mainPathChecks === 4) target.renameSync(replacementPath, filePath);
          }
          return target.lstatSync(targetPath);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const registry = createRegistry({ filePath, fsImpl });
  assert.throws(
    () => registry.load(),
    (error) => error.code === "registry_persist_failed" && /changed after it was read/.test(error.message),
  );
  assert.equal(registry.all().length, 0);
  assert.equal(fs.existsSync(`${filePath}.commit`), true);
});

test("load completes a pending rollback after commit and immediate recovery both fail", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });

  const registry = createRegistry({
    filePath,
    now: () => 2_000_000,
    fsImpl: failCommitFsyncAndImmediateRollback(filePath),
  });
  registry.load();
  assert.throws(
    () => registry.register({ name: "new-owner", port: 20001 }),
    (error) => error.code === "registry_persist_failed" && error.recoveryPending === true,
  );
  assert.equal(registry.getByPort(20000)?.name, "old-owner");
  assert.equal(fs.existsSync(`${filePath}.rollback`), true);
  assert.equal(fs.statSync(`${filePath}.rollback`).mode & 0o777, 0o600);

  const restarted = createRegistry({ filePath, now: () => 3_000_000 });
  restarted.load();
  assert.equal(restarted.getByPort(20000)?.name, "old-owner");
  assert.equal(restarted.getByPort(20001), null);
  assertOnlyRegistryFileRemains(filePath);
});

test("rollback removal failure keeps the old snapshot recoverable", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "old-owner", port: 20000 });

  const registry = createRegistry({
    filePath,
    now: () => 2_000_000,
    fsImpl: failRollbackRemovalOnce(filePath),
  });
  registry.load();
  assert.throws(
    () => registry.register({ name: "new-owner", port: 20001 }),
    (error) => error.code === "registry_persist_failed" && error.recoveryPending === true,
  );
  assert.equal(registry.getByPort(20000)?.name, "old-owner");
  assert.equal(registry.getByPort(20001), null);
  assert.equal(fs.existsSync(`${filePath}.rollback`), true);

  const restarted = createRegistry({ filePath, now: () => 3_000_000 });
  restarted.load();
  assert.equal(restarted.getByPort(20000)?.name, "old-owner");
  assert.equal(restarted.getByPort(20001), null);
  assertOnlyRegistryFileRemains(filePath);
});

for (const restoreFailure of ["rename", "fsync"]) {
  test(`post-unlink failure with immediate restore ${restoreFailure} failure keeps old-state evidence`, () => {
    const filePath = tmpFile();
    const seed = createRegistry({ filePath, now: () => 1_000_000 });
    seed.register({ name: "old-owner", port: 20000 });

    const registry = createRegistry({
      filePath,
      now: () => 2_000_000,
      fsImpl: failAfterRollbackRemoval(filePath, restoreFailure),
    });
    registry.load();
    assert.throws(
      () => registry.register({ name: "new-owner", port: 20001 }),
      (error) => error.code === "registry_persist_failed" && error.recoveryPending === true,
    );
    assert.equal(registry.getByPort(20000)?.name, "old-owner");
    assert.equal(fs.existsSync(`${filePath}.rollback`), true);
    assert.equal(fs.statSync(`${filePath}.rollback`).mode & 0o777, 0o600);

    const restarted = createRegistry({ filePath, now: () => 3_000_000 });
    restarted.load();
    assert.equal(restarted.getByPort(20000)?.name, "old-owner");
    assert.equal(restarted.getByPort(20001), null);
    assertOnlyRegistryFileRemains(filePath);
  });
}

for (const scenario of ["symlink", "directory", "wrong-mode", "wrong-owner", "oversize", "corrupt"]) {
  test(`recovery record ${scenario} is rejected without changing registry state`, () => {
    const { filePath, content, rollbackPath } = seedRollbackFixture();
    let fsImpl = fs;
    if (scenario === "symlink") {
      const target = `${rollbackPath}.target`;
      fs.writeFileSync(target, rollbackRecord(content), { mode: 0o600 });
      fs.symlinkSync(target, rollbackPath);
    } else if (scenario === "directory") {
      fs.mkdirSync(rollbackPath, { mode: 0o700 });
    } else if (scenario === "wrong-mode") {
      fs.writeFileSync(rollbackPath, rollbackRecord(content), { mode: 0o644 });
    } else if (scenario === "wrong-owner") {
      fs.writeFileSync(rollbackPath, rollbackRecord(content), { mode: 0o600 });
      fsImpl = new Proxy(fs, {
        get(target, property) {
          if (property === "lstatSync" || property === "fstatSync") {
            return (...args) => {
              const stat = target[property](...args);
              return new Proxy(stat, {
                get(statTarget, statProperty) {
                  if (statProperty === "uid") return statTarget.uid + 1;
                  const value = Reflect.get(statTarget, statProperty);
                  return typeof value === "function" ? value.bind(statTarget) : value;
                },
              });
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } else if (scenario === "oversize") {
      fs.writeFileSync(rollbackPath, rollbackRecord(content), { mode: 0o600 });
      fsImpl = new Proxy(fs, {
        get(target, property) {
          if (property === "lstatSync") {
            return (targetPath) => {
              const stat = target.lstatSync(targetPath);
              if (targetPath !== rollbackPath) return stat;
              return new Proxy(stat, {
                get(statTarget, statProperty) {
                  if (statProperty === "size") return 64 * 1024 * 1024 + 1;
                  const value = Reflect.get(statTarget, statProperty);
                  return typeof value === "function" ? value.bind(statTarget) : value;
                },
              });
            };
          }
          if (property === "readFileSync") {
            return (targetPath, ...args) => {
              if (targetPath === rollbackPath) throw new Error("oversize recovery record was read");
              return target.readFileSync(targetPath, ...args);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } else {
      fs.writeFileSync(rollbackPath, "not-json\n", { mode: 0o600 });
    }

    const registry = createRegistry({ filePath, fsImpl });
    assert.throws(
      () => registry.load(),
      (error) => error.code === "registry_persist_failed",
    );
    assert.equal(registry.all().length, 0);
  });
}

test("FIFO recovery record is rejected without blocking", () => {
  const { filePath, rollbackPath } = seedRollbackFixture();
  execFileSync("mkfifo", [rollbackPath]);
  const registryUrl = new URL("../src/registry.js", import.meta.url).href;
  const script = `
    import { createRegistry } from ${JSON.stringify(registryUrl)};
    try {
      createRegistry({ filePath: ${JSON.stringify(filePath)} }).load();
      process.exit(2);
    } catch (error) {
      process.exit(error.code === "registry_persist_failed" ? 0 : 3);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    timeout: 1_000,
  });
  assert.equal(child.signal, null, child.stderr?.toString());
  assert.equal(child.status, 0, child.stderr?.toString());
});

test("failed durable replacement preserves a stale foreign owner", () => {
  const filePath = tmpFile();
  const seed = createRegistry({ filePath, now: () => 1_000_000 });
  seed.register({ name: "foreign-owner", port: 20000 });
  seed.persist();

  const registry = createRegistry({
    filePath,
    now: () => 2_000_000,
    fsImpl: failPersistenceOnce("rename", filePath),
  });
  registry.load();

  assert.throws(
    () => registry.register({ name: "replacement", port: 20000 }),
    (error) => error.code === "registry_persist_failed",
  );
  assert.equal(registry.getByPort(20000)?.name, "foreign-owner");
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

test("load drops records with non-parseable timestamps", () => {
  const filePath = tmpFile();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      registrations: [
        {
          id: "reg_badtime",
          name: "bad-time",
          description: "",
          port: 20001,
          requestedPort: null,
          status: "pending",
          registeredAt: "not-a-date",
          lastSeenListeningAt: null,
          staleSince: null,
          observedProcess: null,
          meta: {},
        },
      ],
    })
  );

  const warnings = [];
  const registry = createRegistry({ filePath, log: { warn: (c, m) => warnings.push(m), error() {} } });
  const result = registry.load();

  assert.equal(result.loaded, 0);
  assert.equal(registry.getByPort(20001), null);
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
