import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCHEMA_VERSION = 1;

export const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,
  apiPort: 7777,
  apiBind: "0.0.0.0",
  publicApiBase: null,
  guardPorts: [3000, 3001, 4200, 5000, 5173, 8000, 8080, 8888],
  allocRange: { start: 20000, end: 20999 },
  scanIntervalSec: 30,
  pendingGraceSec: 300,
  staleGraceSec: 90,
  staleEvictSec: 86400,
  registryPath: null,
  logLevel: "info",
};

export function defaultConfigPath() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "local-portal", "config.json");
}

export function defaultRegistryPath() {
  const xdgStateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(xdgStateHome, "local-portal", "registry.json");
}

export function resolveConfigPath({ argv = [] } = {}) {
  const flagIndex = argv.indexOf("--config");
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return argv[flagIndex + 1];
  }
  if (process.env.LOCAL_PORTAL_CONFIG) {
    return process.env.LOCAL_PORTAL_CONFIG;
  }
  return defaultConfigPath();
}

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isValidPort(n) {
  return Number.isInteger(n) && n >= 1025 && n <= 65535;
}

/**
 * Merge raw config over defaults (shallow per top-level key), then validate/clamp.
 * Never throws on recoverable issues — collects human-readable warnings instead.
 * Throws only when the input is fundamentally unusable (e.g. not an object).
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new Error("config must be a JSON object");
  }

  const warnings = [];
  const config = { ...DEFAULT_CONFIG, ...raw };

  // schemaVersion
  if (config.schemaVersion !== SCHEMA_VERSION) {
    if (raw.schemaVersion !== undefined) {
      throw new Error(
        `unsupported config schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ${SCHEMA_VERSION})`
      );
    }
    config.schemaVersion = SCHEMA_VERSION;
  }

  // apiPort
  if (!isValidPort(config.apiPort)) {
    warnings.push(`invalid apiPort ${JSON.stringify(config.apiPort)}, falling back to ${DEFAULT_CONFIG.apiPort}`);
    config.apiPort = DEFAULT_CONFIG.apiPort;
  }

  // apiBind
  if (typeof config.apiBind !== "string" || config.apiBind.length === 0) {
    warnings.push(`invalid apiBind, falling back to ${DEFAULT_CONFIG.apiBind}`);
    config.apiBind = DEFAULT_CONFIG.apiBind;
  }

  // publicApiBase
  if (config.publicApiBase !== null && typeof config.publicApiBase !== "string") {
    warnings.push("invalid publicApiBase, falling back to null");
    config.publicApiBase = null;
  }

  // guardPorts: dedupe, drop invalid, drop apiPort
  if (!Array.isArray(config.guardPorts)) {
    warnings.push("invalid guardPorts, falling back to defaults");
    config.guardPorts = [...DEFAULT_CONFIG.guardPorts];
  }
  const seen = new Set();
  const cleanedGuardPorts = [];
  for (const p of config.guardPorts) {
    if (!isValidPort(p)) {
      warnings.push(`dropping invalid guard port ${JSON.stringify(p)}`);
      continue;
    }
    if (p === config.apiPort) {
      warnings.push(`dropping guard port ${p} because it equals apiPort`);
      continue;
    }
    if (seen.has(p)) {
      warnings.push(`dropping duplicate guard port ${p}`);
      continue;
    }
    seen.add(p);
    cleanedGuardPorts.push(p);
  }
  config.guardPorts = cleanedGuardPorts;

  // allocRange
  if (
    !isPlainObject(config.allocRange) ||
    !isValidPort(config.allocRange.start) ||
    !isValidPort(config.allocRange.end) ||
    config.allocRange.start > config.allocRange.end
  ) {
    warnings.push("invalid allocRange, falling back to defaults");
    config.allocRange = { ...DEFAULT_CONFIG.allocRange };
  } else {
    config.allocRange = { start: config.allocRange.start, end: config.allocRange.end };
  }

  // interval/grace seconds: clamp to >= 5
  for (const key of ["scanIntervalSec", "pendingGraceSec", "staleGraceSec", "staleEvictSec"]) {
    if (!Number.isFinite(config[key]) || config[key] < 5) {
      warnings.push(`invalid ${key} ${JSON.stringify(config[key])}, falling back to ${DEFAULT_CONFIG[key]}`);
      config[key] = DEFAULT_CONFIG[key];
    }
  }

  // registryPath
  if (config.registryPath !== null && typeof config.registryPath !== "string") {
    warnings.push("invalid registryPath, falling back to null");
    config.registryPath = null;
  }

  // logLevel
  if (!["debug", "info", "warn", "error"].includes(config.logLevel)) {
    warnings.push(`invalid logLevel ${JSON.stringify(config.logLevel)}, falling back to info`);
    config.logLevel = "info";
  }

  return { config, warnings };
}

/**
 * Load config from disk, creating it with defaults if missing.
 * Throws if the file exists but is unparseable/invalid — we never silently
 * overwrite a hand-edited config.
 */
export function loadConfig({ configPath = defaultConfigPath() } = {}) {
  let created = false;
  let raw;

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n", "utf8");
    created = true;
    raw = { ...DEFAULT_CONFIG };
  } else {
    const text = fs.readFileSync(configPath, "utf8");
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`failed to parse config at ${configPath}: ${err.message}`);
    }
  }

  const { config, warnings } = validateConfig(raw);
  return { config, created, warnings, configPath };
}
