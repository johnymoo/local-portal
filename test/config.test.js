import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../src/config.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "local-portal-test-"));
}

test("loadConfig creates defaults when file missing", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.json");
  const { config, created, warnings } = loadConfig({ configPath });

  assert.equal(created, true);
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(warnings, []);
  assert.equal(fs.existsSync(configPath), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("default API bind exposes the portal on all interfaces", () => {
  assert.equal(DEFAULT_CONFIG.apiBind, "0.0.0.0");
});

test("loadConfig merges partial config over defaults", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ apiPort: 9999 }));

  const { config, created } = loadConfig({ configPath });
  assert.equal(created, false);
  assert.equal(config.apiPort, 9999);
  assert.deepEqual(config.guardPorts, DEFAULT_CONFIG.guardPorts);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("validateConfig removes apiPort from guardPorts with warning", () => {
  const { config, warnings } = validateConfig({ apiPort: 3000, guardPorts: [3000, 3001] });
  assert.deepEqual(config.guardPorts, [3001]);
  assert.ok(warnings.some((w) => w.includes("apiPort")));
});

test("validateConfig dedupes guard ports", () => {
  const { config, warnings } = validateConfig({ guardPorts: [3000, 3000, 4200] });
  assert.deepEqual(config.guardPorts, [3000, 4200]);
  assert.ok(warnings.some((w) => w.includes("duplicate")));
});

test("validateConfig clamps invalid interval values to defaults", () => {
  const { config, warnings } = validateConfig({ scanIntervalSec: 1 });
  assert.equal(config.scanIntervalSec, DEFAULT_CONFIG.scanIntervalSec);
  assert.ok(warnings.some((w) => w.includes("scanIntervalSec")));
});

test("validateConfig falls back to default allocRange when invalid", () => {
  const { config, warnings } = validateConfig({ allocRange: { start: 500, end: 100 } });
  assert.deepEqual(config, { ...DEFAULT_CONFIG, ...config, allocRange: DEFAULT_CONFIG.allocRange });
  assert.ok(warnings.some((w) => w.includes("allocRange")));
});

test("loadConfig throws on invalid JSON without overwriting the file", () => {
  const dir = tmpDir();
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "{ not valid json");

  assert.throws(() => loadConfig({ configPath }), /failed to parse config/);
  assert.equal(fs.readFileSync(configPath, "utf8"), "{ not valid json");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("validateConfig throws on unsupported schemaVersion", () => {
  assert.throws(() => validateConfig({ schemaVersion: 99 }), /unsupported config schemaVersion/);
});

test("validateConfig throws when input is not an object", () => {
  assert.throws(() => validateConfig(null), /must be a JSON object/);
  assert.throws(() => validateConfig([1, 2]), /must be a JSON object/);
});
