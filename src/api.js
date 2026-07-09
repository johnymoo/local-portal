import http from "node:http";

import { agentGuideMarkdown } from "./guide.js";
import { isValidName, MAX_DESCRIPTION_LEN, MAX_META_BYTES } from "./registry.js";

const VERSION = "1.0.0";
const BODY_LIMIT = 16 * 1024;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Local-Portal", "api");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { ok: false, error: { code, message, ...extra } });
}

function methodNotAllowed(res, allowed) {
  res.setHeader("Allow", allowed.join(", "));
  sendError(res, 405, "method_not_allowed", `method not allowed, use ${allowed.join(", ")}`);
}

function readJsonBody(req, { limit = BODY_LIMIT } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Don't destroy the socket here - that would abort the connection
        // before our error response can be written. Just stop accumulating
        // and let the stream drain normally; the client still gets a 413.
        if (!rejected) {
          rejected = true;
          const err = new Error("request body too large");
          err.status = 413;
          err.code = "payload_too_large";
          reject(err);
        }
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (rejected) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        const e = new Error(`invalid JSON body: ${err.message}`);
        e.status = 400;
        e.code = "bad_json";
        reject(e);
      }
    });

    req.on("error", (err) => {
      err.status = err.status ?? 400;
      err.code = err.code ?? "bad_json";
      reject(err);
    });
  });
}

function publicRecord(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.status,
    registeredAt: record.registeredAt,
    lastSeenListeningAt: record.lastSeenListeningAt,
    staleSince: record.staleSince,
    observedProcess: record.observedProcess,
  };
}

function isValidMeta(meta) {
  if (meta === undefined) return true;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
  try {
    return Buffer.byteLength(JSON.stringify(meta), "utf8") <= MAX_META_BYTES;
  } catch {
    return false;
  }
}

function grantedView(record, pendingGraceSec) {
  const registeredAtMs = Date.parse(record.registeredAt);
  const bindBy = new Date(registeredAtMs + pendingGraceSec * 1000).toISOString();
  return {
    id: record.id,
    name: record.name,
    port: record.port,
    status: record.status,
    registeredAt: record.registeredAt,
    bindBy,
  };
}

function nextSteps(record, apiBase, pendingGraceSec) {
  const bindBy = new Date(Date.parse(record.registeredAt) + pendingGraceSec * 1000).toISOString();
  return [
    `Start your server on port ${record.port} now (bind 127.0.0.1, 0.0.0.0 or ::).`,
    `Bind before ${bindBy} or this registration is marked stale and may be reclaimed.`,
    `Check status: curl ${apiBase}/api/ports/${record.port}`,
    `When your service stops permanently: curl -X POST ${apiBase}/api/release -H 'content-type: application/json' -d '{"name":"${record.name}","port":${record.port}}'`,
  ];
}

/** Merges guards + registrations + the latest OS scan into the /api/ports view (§3). */
function buildPortsView({ registry, guards, getLastScan }) {
  const lastScan = getLastScan();
  const view = new Map();

  if (lastScan?.ports) {
    for (const [port, info] of lastScan.ports) {
      view.set(port, {
        port,
        state: "occupied-unmanaged",
        guardWanted: false,
        addresses: info.addresses,
        process: info.processes[0] ?? null,
      });
    }
  }

  for (const { port, status } of guards.snapshot()) {
    if (status === "held") {
      view.set(port, { port, state: "guarded" });
    } else {
      const info = lastScan?.ports?.get(port);
      view.set(port, {
        port,
        state: "occupied-unmanaged",
        guardWanted: true,
        addresses: info?.addresses ?? [],
        process: info?.processes?.[0] ?? null,
      });
    }
  }

  for (const record of registry.all()) {
    view.set(record.port, {
      port: record.port,
      state: `registered-${record.status}`,
      registration: publicRecord(record),
    });
  }

  return {
    ports: [...view.values()].sort((a, b) => a.port - b.port),
    lastScan,
  };
}

/** Live single-port lookup for GET /api/ports/:port. Never bind-tests a port already known to registry/guards. */
async function livePortLookup(port, { registry, guards, scanner, getLastScan }) {
  const record = registry.getByPort(port);
  if (record) {
    return { ok: true, port, state: `registered-${record.status}`, registration: publicRecord(record) };
  }

  const guardStatus = guards.statusOf(port);
  const lastScan = getLastScan();
  const scanInfo = lastScan?.ports?.get(port) ?? null;

  if (guardStatus === "held") {
    return {
      ok: true,
      port,
      state: "guarded",
      hint: "This port is reserved by local-portal. POST /api/register to get a port.",
    };
  }
  if (guardStatus === "wanted") {
    return {
      ok: true,
      port,
      state: "occupied-unmanaged",
      guardWanted: true,
      process: scanInfo?.processes?.[0] ?? null,
    };
  }

  const listening = await scanner.isListening(port);
  if (listening) {
    return {
      ok: true,
      port,
      state: "occupied-unmanaged",
      guardWanted: false,
      process: scanInfo?.processes?.[0] ?? null,
    };
  }

  const free = await scanner.isPortFree(port);
  if (free) return { ok: true, port, state: "free" };
  return { ok: true, port, state: "occupied-unmanaged", guardWanted: false, process: null };
}

async function handleRegister(req, res, ctx) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, err.status ?? 400, err.code ?? "bad_json", err.message);
  }

  const { registry, allocator, apiBase, config } = ctx;
  const name = body.name;
  if (!isValidName(name)) {
    return sendError(res, 400, "invalid_name", "name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }

  const description =
    typeof body.description === "string" ? body.description.slice(0, MAX_DESCRIPTION_LEN) : "";
  const meta = isValidMeta(body.meta) ? body.meta ?? {} : {};
  const preferredPort =
    body.preferredPort === undefined || body.preferredPort === null ? null : body.preferredPort;
  const another = body.another === true;

  // idempotent shortcuts, evaluated before touching the allocator
  if (preferredPort !== null) {
    const existing = registry.getByPort(preferredPort);
    if (existing && existing.name === name) {
      const rec = registry.reregister(preferredPort);
      registry.persist();
      return sendJson(res, 200, {
        ok: true,
        existing: true,
        granted: grantedView(rec, config.pendingGraceSec),
        next_steps: nextSteps(rec, apiBase, config.pendingGraceSec),
      });
    }
  } else if (!another) {
    const existingForName = registry.getByName(name);
    if (existingForName.length > 0) {
      const rec = existingForName[existingForName.length - 1];
      return sendJson(res, 200, {
        ok: true,
        existing: true,
        granted: grantedView(rec, config.pendingGraceSec),
        next_steps: nextSteps(rec, apiBase, config.pendingGraceSec),
      });
    }
  }

  try {
    const record = await allocator.withLock(async () => {
      const { port } = await allocator.grant({ name, preferredPort: preferredPort ?? undefined });
      const rec = registry.register({
        name,
        description,
        port,
        requestedPort: preferredPort,
        meta,
      });
      registry.persist();
      return rec;
    });

    return sendJson(res, 201, {
      ok: true,
      existing: false,
      granted: grantedView(record, config.pendingGraceSec),
      next_steps: nextSteps(record, apiBase, config.pendingGraceSec),
    });
  } catch (err) {
    switch (err.code) {
      case "invalid_port":
        return sendError(res, 400, err.code, err.message, {
          hint: "ports <1024 require root; pick 1025-65535 or omit",
        });
      case "port_guarded":
        return sendError(res, 409, err.code, err.message, {
          hint: "omit preferredPort to get an allocation, or pick another port",
        });
      case "port_registered":
        return sendError(res, 409, err.code, err.message, { owner: err.owner, status: err.status });
      case "port_unmanaged":
        return sendError(res, 409, err.code, err.message, { process: err.process });
      case "range_exhausted":
        return sendError(res, 503, err.code, err.message, {
          hint: "release unused ports or widen allocRange in config",
        });
      default:
        throw err;
    }
  }
}

async function handleRelease(req, res, ctx) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return sendError(res, err.status ?? 400, err.code ?? "bad_json", err.message);
  }

  const { registry } = ctx;
  const { name, port, force } = body;

  if (!Number.isInteger(port)) {
    return sendError(res, 400, "invalid_port", "port must be an integer");
  }
  if (!isValidName(name)) {
    return sendError(res, 400, "invalid_name", "name is required");
  }

  const record = registry.getByPort(port);
  if (!record) {
    return sendError(res, 404, "not_found", `no registration found for port ${port}`);
  }
  if (record.name !== name && force !== true) {
    return sendError(res, 403, "name_mismatch", `port ${port} is registered to "${record.name}", not "${name}"`, {
      owner: record.name,
    });
  }

  registry.release(port);
  registry.persist();
  return sendJson(res, 200, { ok: true, released: { name: record.name, port } });
}

/**
 * Builds the (not-yet-listening) HTTP server for the API + dashboard.
 * deps: {config, registry, allocator, scanner, guards, dashboard, getLastScan, log}
 */
export function createApiServer(deps) {
  const { config, registry, allocator, scanner, guards, dashboard, getLastScan, log } = deps;
  const apiBase = config.publicApiBase || `http://127.0.0.1:${config.apiPort}`;
  const startedAt = new Date().toISOString();

  async function route(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;
    const method = req.method;

    if (pathname === "/" && method === "GET") {
      const view = buildPortsView({ registry, guards, getLastScan });
      const html = dashboard.renderDashboard(view, config, { apiBase, startedAt, version: VERSION });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === "/api/health") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      return sendJson(res, 200, { ok: true, service: "local-portal", version: VERSION, pid: process.pid });
    }

    if (pathname === "/api/ports") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      const view = buildPortsView({ registry, guards, getLastScan });
      const used = registry
        .all()
        .filter((r) => r.port >= config.allocRange.start && r.port <= config.allocRange.end).length;
      return sendJson(res, 200, {
        ok: true,
        portal: {
          service: "local-portal",
          version: VERSION,
          apiBase,
          startedAt,
          lastScanAt: view.lastScan?.at ?? null,
          scanSource: view.lastScan?.source ?? "none",
        },
        allocRange: { start: config.allocRange.start, end: config.allocRange.end, used },
        ports: view.ports,
      });
    }

    const portMatch = pathname.match(/^\/api\/ports\/(\d+)$/);
    if (portMatch) {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      const port = Number(portMatch[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendError(res, 400, "invalid_port", "port must be an integer between 1 and 65535");
      }
      const result = await livePortLookup(port, { registry, guards, scanner, getLastScan });
      return sendJson(res, 200, result);
    }

    if (pathname === "/api/register") {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]);
      return handleRegister(req, res, { registry, allocator, apiBase, config });
    }

    if (pathname === "/api/release") {
      if (method !== "POST") return methodNotAllowed(res, ["POST"]);
      return handleRelease(req, res, { registry });
    }

    if (pathname === "/api/agent-guide") {
      if (method !== "GET") return methodNotAllowed(res, ["GET"]);
      const markdown = agentGuideMarkdown(apiBase);
      if (url.searchParams.get("format") === "json") {
        return sendJson(res, 200, { ok: true, markdown });
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("X-Local-Portal", "api");
      res.end(markdown);
      return;
    }

    if (pathname.startsWith("/api/")) {
      return sendError(res, 404, "not_found", `unknown endpoint ${pathname}`, {
        hint: "available: GET /api/health, GET /api/ports, GET /api/ports/:port, POST /api/register, POST /api/release, GET /api/agent-guide",
      });
    }

    return sendError(res, 404, "not_found", `unknown path ${pathname}`);
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log?.error?.("api", `unhandled error: ${err.stack || err.message}`);
      if (!res.headersSent) {
        sendError(res, 500, "internal_error", "internal server error");
      } else {
        res.end();
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return server;
}
