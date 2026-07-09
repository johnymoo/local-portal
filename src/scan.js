import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseAddressPort(field) {
  const lastColon = field.lastIndexOf(":");
  if (lastColon === -1) return null;
  const portStr = field.slice(lastColon + 1);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  let address = field.slice(0, lastColon);
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  const pctIdx = address.indexOf("%");
  if (pctIdx !== -1) address = address.slice(0, pctIdx);

  return { address, port };
}

function addPortEntry(ports, port, address, processes) {
  let entry = ports.get(port);
  if (!entry) {
    entry = { addresses: [], processes: [] };
    ports.set(port, entry);
  }
  if (address && !entry.addresses.includes(address)) entry.addresses.push(address);
  for (const p of processes) {
    if (!entry.processes.some((e) => e.pid === p.pid)) entry.processes.push(p);
  }
}

/**
 * Parse `ss -H -tlnp` output into a Map<port, {addresses, processes}>.
 * Pure function — no I/O — kept separate for unit testing against fixtures.
 */
export function parseSsOutput(text) {
  const ports = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    if (tokens[0] !== "LISTEN") continue;

    const localField = tokens[3];
    if (!localField) continue;
    const parsed = parseAddressPort(localField);
    if (!parsed) continue;

    const rest = tokens.slice(5).join(" ");
    const processes = [];
    const procRegex = /"([^"]+)",pid=(\d+)/g;
    let m;
    while ((m = procRegex.exec(rest))) {
      processes.push({ name: m[1], pid: Number(m[2]) });
    }

    addPortEntry(ports, parsed.port, parsed.address, processes);
  }
  return ports;
}

/**
 * Parse `/proc/net/tcp` or `/proc/net/tcp6` into a list of ports in LISTEN
 * state (hex state 0A). Pure function for unit testing. No process info
 * available from this source.
 */
export function parseProcNetTcp(text) {
  const ports = [];
  const lines = text.split("\n").slice(1); // skip header row
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tokens = trimmed.split(/\s+/);
    const local = tokens[1];
    const state = tokens[3];
    if (state !== "0A") continue;
    if (!local) continue;
    const colonIdx = local.lastIndexOf(":");
    if (colonIdx === -1) continue;
    const port = parseInt(local.slice(colonIdx + 1), 16);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
  }
  return ports;
}

/**
 * Scan the machine's listening TCP ports. Tries `ss` first, falls back to
 * /proc/net/tcp{,6} (ports only, no process names), and finally degrades to
 * an empty map with source "none" if neither is available.
 */
export async function scanOnce({ log } = {}) {
  const at = new Date().toISOString();

  try {
    const { stdout } = await execFileAsync("ss", ["-H", "-tlnp"], { timeout: 5000 });
    return { ports: parseSsOutput(stdout), source: "ss", at };
  } catch (err) {
    log?.warn?.("scan", `ss unavailable (${err.message}), falling back to /proc/net/tcp`);
  }

  try {
    const [tcp4, tcp6] = await Promise.all([
      fs.readFile("/proc/net/tcp", "utf8").catch(() => ""),
      fs.readFile("/proc/net/tcp6", "utf8").catch(() => ""),
    ]);
    const portNums = new Set([...parseProcNetTcp(tcp4), ...parseProcNetTcp(tcp6)]);
    const ports = new Map();
    for (const port of portNums) {
      ports.set(port, { addresses: [], processes: [] });
    }
    return { ports, source: "proc", at };
  } catch (err) {
    log?.error?.("scan", `/proc/net/tcp unavailable (${err.message}); running in degraded mode`);
    return { ports: new Map(), source: "none", at };
  }
}

function bindTest(port, host, listenOptions, timeoutMs) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    let listening = false;
    const timer = setTimeout(() => finish(false), timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.removeAllListeners();
      if (!listening) {
        resolve(result);
        return;
      }
      server.close(() => resolve(result));
    }

    server.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        finish(false);
      } else if (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL") {
        // address family not supported on this host: no bind hole possible here
        finish(true);
      } else {
        finish(false);
      }
    });
    server.once("listening", () => {
      listening = true;
      finish(true);
    });

    try {
      server.listen({ port, host, ...listenOptions });
    } catch {
      finish(false);
    }
  });
}

/**
 * Bind-test whether a port is free on BOTH stacks (0.0.0.0 and [::] with
 * ipv6Only). Never call this on a port that might belong to a live
 * registration — a bind attempt can race a restarting service.
 */
export async function isPortFree(port, { timeoutMs = 1000 } = {}) {
  const v4Free = await bindTest(port, "0.0.0.0", {}, timeoutMs);
  if (!v4Free) return false;
  const v6Free = await bindTest(port, "::", { ipv6Only: true }, timeoutMs);
  return v6Free;
}

/**
 * Connect-probe a port on 127.0.0.1 to check if something is listening.
 * Safe to use on registered ports (no bind race).
 */
export function isListening(port, { host = "127.0.0.1", timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    function finish(result) {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}
