import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isListening, isPortFree, parseProcNetTcp, parseSsOutput } from "../src/scan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
}

test("parseSsOutput extracts plain v4 address and process info", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(52341);
  assert.ok(entry);
  assert.deepEqual(entry.addresses, ["0.0.0.0"]);
  assert.deepEqual(entry.processes, [{ name: "python3", pid: 3733488 }]);
});

test("parseSsOutput handles a listener with no process column", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(18888);
  assert.ok(entry);
  assert.deepEqual(entry.addresses, ["0.0.0.0"]);
  assert.deepEqual(entry.processes, []);
});

test("parseSsOutput strips %iface suffix from address", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(53);
  assert.ok(entry);
  assert.deepEqual(entry.addresses, ["127.0.0.53"]);
});

test("parseSsOutput handles bracketed IPv6 address", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(55571);
  assert.ok(entry);
  assert.deepEqual(entry.addresses, ["::"]);
});

test("parseSsOutput handles wildcard '*' address and multi-word quoted process name", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(3201);
  assert.ok(entry);
  assert.deepEqual(entry.addresses, ["*"]);
  assert.deepEqual(entry.processes, [{ name: "next-server (v1", pid: 1935026 }]);
});

test("parseSsOutput merges dual-stack listeners on the same port and dedupes by pid", () => {
  const ports = parseSsOutput(fixture("ss-output.txt"));
  const entry = ports.get(3000);
  assert.ok(entry);
  assert.deepEqual(entry.addresses.sort(), ["0.0.0.0", "::"].sort());
  assert.deepEqual(entry.processes, [{ name: "node", pid: 412345 }]);
});

test("parseSsOutput ignores non-LISTEN lines and blank lines", () => {
  const ports = parseSsOutput("\n\nLISTEN 0 5 0.0.0.0:9 0.0.0.0:*\n");
  assert.deepEqual([...ports.keys()], [9]);
});

test("parseProcNetTcp decodes hex ports and filters to LISTEN state", () => {
  const ports = parseProcNetTcp(fixture("proc-net-tcp.txt"));
  assert.deepEqual(ports.sort((a, b) => a - b), [3000, 8080]);
});

test("isPortFree returns true for a fresh ephemeral port after release", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));

  const free = await isPortFree(port);
  assert.equal(free, true);
});

test("isPortFree returns false while a v4 listener holds the port", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  const port = server.address().port;

  const free = await isPortFree(port);
  assert.equal(free, false);

  await new Promise((resolve) => server.close(resolve));
});

test("isPortFree treats failed bind probes as occupied even if close reports server not running", async () => {
  const originalCreateServer = net.createServer;
  let restored = false;

  net.createServer = () => {
    const listeners = new Map();
    return {
      once(event, handler) {
        listeners.set(event, handler);
        return this;
      },
      removeAllListeners() {},
      close() {
        throw Object.assign(new Error("Server is not running."), { code: "ERR_SERVER_NOT_RUNNING" });
      },
      listen() {
        listeners.get("error")?.(Object.assign(new Error("address in use"), { code: "EADDRINUSE" }));
      },
    };
  };

  try {
    const mod = await import(`../src/scan.js?close-failure=${Date.now()}`);
    const result = await Promise.race([
      mod.isPortFree(49152, { timeoutMs: 10 }),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
    ]);
    assert.equal(result, false);
  } finally {
    net.createServer = originalCreateServer;
    restored = true;
  }

  assert.equal(restored, true);
});

test("isPortFree returns false while a v6-only listener holds the port", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "::", ipv6Only: true }, resolve);
  });
  const port = server.address().port;

  const free = await isPortFree(port);
  assert.equal(free, false);

  await new Promise((resolve) => server.close(resolve));
});

test("isListening reflects whether a TCP server is accepting connections", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  assert.equal(await isListening(port), true);

  await new Promise((resolve) => server.close(resolve));

  assert.equal(await isListening(port), false);
});
