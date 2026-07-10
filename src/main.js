import { createAllocator } from "./allocator.js";
import { createApiServer } from "./api.js";
import { defaultRegistryPath, loadConfig, resolveConfigPath } from "./config.js";
import * as dashboard from "./dashboard.js";
import { createGuardManager } from "./guard.js";
import { createLogger } from "./log.js";
import { createRegistry } from "./registry.js";
import { isListening, isPortFree, scanOnce } from "./scan.js";

const VERSION = "1.0.0";

function defaultApiBaseForDisplay(config) {
  const host = config.apiBind === "0.0.0.0" || config.apiBind === "::" ? "127.0.0.1" : config.apiBind;
  return `http://${host}:${config.apiPort}`;
}

function printUsage() {
  console.log(
    `Usage: local-portal [--config <path>] [--version] [--help]\n\n` +
      `Starts the local-portal port guard and registry service.\n` +
      `Config is auto-created on first run at ${defaultRegistryPath().replace("state", "config").replace("registry.json", "config.json")}\n` +
      `(or $LOCAL_PORTAL_CONFIG, or --config <path>).`
  );
}

function toListenSetAndProcessInfo(scanResult) {
  const listenSet = new Set(scanResult.ports.keys());
  const processInfo = new Map();
  for (const [port, info] of scanResult.ports) {
    if (info.processes && info.processes.length > 0) processInfo.set(port, info.processes[0]);
  }
  return { listenSet, processInfo };
}

async function checkExistingInstance(apiPort) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${apiPort}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === "local-portal" ? body : null;
  } catch {
    return null;
  }
}

function listenApi(server, config) {
  return new Promise((resolve, reject) => {
    function onError(err) {
      server.removeListener("listening", onListening);
      reject(err);
    }
    function onListening() {
      server.removeListener("error", onError);
      resolve();
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.apiPort, config.apiBind);
  });
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    console.log(`local-portal ${VERSION}`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  const configPath = resolveConfigPath({ argv });
  const { config, created, warnings } = loadConfig({ configPath });

  process.title = "local-portal-guard";
  const log = createLogger(config.logLevel);

  if (created) log.info("main", `no config found, created defaults at ${configPath}`);
  for (const w of warnings) log.warn("config", w);

  const registryPath = config.registryPath || defaultRegistryPath();
  const registry = createRegistry({ filePath: registryPath, log });
  const loadResult = registry.load();
  log.info("main", `loaded ${loadResult.loaded} registration(s) from ${registryPath}`);

  let lastScan = { ports: new Map(), source: "none", at: new Date().toISOString() };
  const getLastScan = () => lastScan;

  const scanner = { isPortFree, isListening };
  const guards = createGuardManager({
    ports: config.guardPorts,
    publicApiBase: config.publicApiBase,
    apiPort: config.apiPort,
    log,
  });
  const allocator = createAllocator({
    registry,
    scanner,
    guardPorts: config.guardPorts,
    allocRange: config.allocRange,
    apiPort: config.apiPort,
    getLastScan,
    log,
  });
  const apiServer = createApiServer({ config, registry, allocator, scanner, guards, dashboard, getLastScan, log });

  try {
    await listenApi(apiServer, config);
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      const existing = await checkExistingInstance(config.apiPort);
      if (existing) {
        log.error(
          "main",
          `another local-portal instance is already running (pid ${existing.pid}) on port ${config.apiPort}`
        );
        process.exitCode = 2;
        return;
      }
      log.error(
        "main",
        `apiPort ${config.apiPort} is occupied by a foreign process — change apiPort in ${configPath}`
      );
      process.exitCode = 1;
      return;
    }
    log.error("main", `failed to start API server: ${err.message}`);
    process.exitCode = 1;
    return;
  }
  log.info("main", `API listening on ${defaultApiBaseForDisplay(config)} (bind ${config.apiBind}:${config.apiPort})`);

  lastScan = await scanOnce({ log });

  await guards.acquireAll();

  const { listenSet, processInfo } = toListenSetAndProcessInfo(lastScan);
  registry.applyScan(listenSet, processInfo, config, Date.now());
  registry.persistIfDirty();

  let reconcileRunning = false;
  async function reconcile() {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      lastScan = await scanOnce({ log });
      const { listenSet, processInfo } = toListenSetAndProcessInfo(lastScan);
      const { changed } = registry.applyScan(listenSet, processInfo, config, Date.now());
      for (const c of changed) log.info("registry", c);
      await guards.retryWanted(listenSet);
      registry.persistIfDirty();
    } catch (err) {
      log.error("main", `reconcile tick failed: ${err.stack || err.message}`);
    } finally {
      reconcileRunning = false;
    }
  }
  const reconcileTimer = setInterval(reconcile, config.scanIntervalSec * 1000);

  logSummary();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExitTimer = setTimeout(() => {
      log.warn("main", "graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 3000);
    forceExitTimer.unref();

    log.info("main", `received ${signal}, shutting down`);
    clearInterval(reconcileTimer);
    guards.releaseAll();
    try {
      apiServer.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => apiServer.close(() => resolve()));
    registry.persist();
    log.info("main", "shutdown complete");
    clearTimeout(forceExitTimer);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  function logSummary() {
    const snapshot = guards.snapshot();
    const held = snapshot.filter((g) => g.status === "held").map((g) => g.port);
    const wanted = snapshot.filter((g) => g.status === "wanted").map((g) => g.port);
    const byStatus = registry.all().reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    log.info(
      "main",
      `ready | config: ${configPath} | registry: ${registryPath} | ` +
        `api: ${defaultApiBaseForDisplay(config)} | bind: ${config.apiBind}:${config.apiPort} | guards held: [${held.join(", ")}] | ` +
        `guards wanted (occupied by others, will retry): [${wanted.join(", ") || "none"}] | ` +
        `registrations: ${JSON.stringify(byStatus)}`
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
