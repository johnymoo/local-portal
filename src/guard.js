import http from "node:http";

import { guardHtmlBody, guardJsonBody } from "./guide.js";

function apiBaseForGuardRequest(req, { apiBase, publicApiBase, apiPort }) {
  if (apiBase) return apiBase;
  if (publicApiBase) return publicApiBase;

  const hostHeader = typeof req.headers.host === "string" ? req.headers.host.trim() : "";
  const hostWithoutPort = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  const host = hostWithoutPort && !/[\r\n]/.test(hostWithoutPort) ? hostWithoutPort : "127.0.0.1";
  return `http://${host}:${apiPort}`;
}

function bindOne(handler, port, host, listenOptions) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.on("clientError", (err, socket) => {
      if (!socket.destroyed) socket.destroy();
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    server.once("error", (err) => finish({ ok: false, code: err.code, server }));
    server.once("listening", () => finish({ ok: true, server }));

    try {
      server.listen({ port, host, ...listenOptions });
    } catch (err) {
      finish({ ok: false, code: err.code, server });
    }
  });
}

/**
 * Pre-occupies a set of ports so agents can't silently bind them. Each held
 * port is a pair of listeners (0.0.0.0 + [::] with ipv6Only) so a v6-only
 * bind can't slip past the guard on hosts where bindv6only=0. Any request to
 * a held port gets a 409 with registration guidance (guide.js).
 */
export function createGuardManager({ ports, apiBase, publicApiBase, apiPort = 7777, log }) {
  const state = new Map(); // port -> { status: "held"|"wanted", servers: http.Server[] }
  for (const port of ports) {
    state.set(port, { status: "wanted", servers: [] });
  }

  function guardRequestHandler(req, res) {
    const port = req.socket.localPort;
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    const effectiveApiBase = apiBaseForGuardRequest(req, { apiBase, publicApiBase, apiPort });

    res.statusCode = 409;
    res.setHeader("X-Local-Portal", "guard");
    res.setHeader("X-Local-Portal-Api", effectiveApiBase);
    res.setHeader("Cache-Control", "no-store");

    const skipBody = req.method === "HEAD";
    if (wantsHtml) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(skipBody ? undefined : guardHtmlBody(port, effectiveApiBase));
    } else {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(skipBody ? undefined : JSON.stringify(guardJsonBody(port, effectiveApiBase)));
    }
  }

  async function acquirePort(port) {
    const entry = state.get(port);
    const servers = [];

    const v4 = await bindOne(guardRequestHandler, port, "0.0.0.0", {});
    if (!v4.ok) {
      if (v4.server) {
        try {
          v4.server.close();
        } catch {
          /* ignore */
        }
      }
      entry.status = "wanted";
      entry.servers = [];
      return false;
    }
    servers.push(v4.server);

    const v6 = await bindOne(guardRequestHandler, port, "::", { ipv6Only: true });
    if (v6.ok) {
      servers.push(v6.server);
    } else if (v6.code === "EAFNOSUPPORT" || v6.code === "EADDRNOTAVAIL") {
      log?.warn?.("guard", `port ${port}: IPv6 unavailable (${v6.code}), guarding v4-only`);
    } else {
      // something else holds the v6 half - release v4 to avoid a half-guarded port
      for (const s of servers) {
        try {
          s.close();
        } catch {
          /* ignore */
        }
      }
      entry.status = "wanted";
      entry.servers = [];
      return false;
    }

    entry.status = "held";
    entry.servers = servers;
    return true;
  }

  async function acquireAll() {
    for (const port of ports) {
      const acquired = await acquirePort(port);
      if (acquired) {
        log?.info?.("guard", `acquired port ${port}`);
      } else {
        log?.warn?.("guard", `port ${port} already occupied by another process, will retry`);
      }
    }
  }

  /** Called each reconcile tick: attempt to acquire any "wanted" port the latest scan no longer shows occupied. */
  async function retryWanted(listenSet) {
    for (const [port, entry] of state) {
      if (entry.status !== "wanted") continue;
      if (listenSet && listenSet.has(port)) continue;
      const acquired = await acquirePort(port);
      if (acquired) log?.info?.("guard", `reacquired port ${port} (was occupied, now free)`);
    }
  }

  function releaseAll() {
    for (const entry of state.values()) {
      for (const server of entry.servers) {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }
      entry.servers = [];
      entry.status = "wanted";
    }
  }

  function statusOf(port) {
    return state.get(port)?.status;
  }

  function snapshot() {
    return [...state.entries()].map(([port, entry]) => ({ port, status: entry.status }));
  }

  return { acquireAll, retryWanted, releaseAll, statusOf, snapshot, guardRequestHandler };
}
