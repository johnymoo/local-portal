# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`local-portal` is a zero-runtime-dependency Node.js service that guards common dev ports
(3000, 8080, etc.) on a shared dev machine so AI agents stop stealing them from each other. It
pre-binds the guard ports, returns a 409 with registration guidance to anything that hits them,
and runs a registry API (`/api/register`, `/api/release`, `/api/ports`) so agents get their own
port instead. See `README.md` for the full API reference, config table, and deployment notes —
this file focuses on things you need to know across multiple files to work on the code.

## Commands

```bash
npm test                    # runs the whole suite: node --test test/*.test.js
node --test test/api.test.js       # run a single test file
node --check src/foo.js            # syntax-check a module without running it
node src/main.js                   # run the service directly (uses real ~/.config, ~/.local/state)
node src/main.js --config /tmp/x.json   # run against an isolated config for manual testing
```

**`node --test test/` (bare directory arg) is broken in this Node version** — it throws
`Cannot find module '.../test'` instead of discovering files. Always use the glob form
(`test/*.test.js`), which is what `npm test` and CI must use.

There is no build step, no linter, and no transpilation — plain ESM (`"type": "module"`), Node
built-ins only (`node:http`, `node:net`, `node:fs`, `node:child_process`, ...). Never add an npm
dependency without discussing it first; the zero-dependency constraint is a deliberate design
choice (agents on this machine run `node src/main.js` with no `npm install` step).

## Test conventions (read before adding tests)

- Never bind a fixed port in a test. Get one by binding port `0`, reading `server.address().port`,
  then closing the throwaway listener (see the `getEphemeralPort` helper duplicated at the top of
  `guard.test.js`, `scan.test.js`, `api.test.js`).
- Never `sleep`/`setTimeout` to test time-based logic. `registry.js`'s clock is injected
  (`now: () => ...`), and `applyScan(listenSet, processInfo, config, nowMs)` takes the current time
  as a plain argument — tests advance a fake clock and call `applyScan` again instead of waiting
  out `pendingGraceSec`/`staleGraceSec`/`staleEvictSec`.
- `allocator.test.js` and `api.test.js` stub the scanner (`{isPortFree, isListening}`) rather than
  using the real `src/scan.js` — this decouples tests from the actual ports free on the machine
  running CI. Only `scan.test.js` exercises the real `net`/`ss` code paths (against fixtures for
  parsing, and real ephemeral-port binds for `isPortFree`/`isListening`).

## Architecture

Everything runs as one Node process. `src/main.js` is the only place that owns a `setInterval` or
signal handlers — every other module is pure logic wired together by main. The pieces:

- **`scan.js`** — ground truth about the OS. `scanOnce()` shells out to `ss -H -tlnp`, falling back
  to parsing `/proc/net/tcp{,6}` if `ss` is missing, and degrading to an empty map if neither works.
  `isPortFree()` bind-tests both `0.0.0.0` and `[::]` (ipv6Only) before anything is granted;
  `isListening()` does a cheap connect-probe instead — **never bind-test a port that's already a
  live registration**, since a bind attempt can race a service that's mid-restart.
- **`registry.js`** — the state machine for registered ports: `pending → active ⇄ stale → deleted`.
  It has no timers of its own; `applyScan(listenSet, processInfo, config, nowMs)` is the only thing
  that advances state, called once per reconcile tick from `main.js`. Register/release persistence
  is copy-on-write and fail-closed: a same-directory rollback record, file fsync, atomic rename,
  and parent-directory fsync complete before memory is published or the API returns 2xx. Startup
  resolves an interrupted transaction from the rollback record. A corrupt/unversioned registry
  file gets quarantined to `registry.json.corrupt-<epoch>` rather than crashing startup.
- **`guard.js`** — owns the actual guard listeners. Each guarded port is a *pair* of
  `http.createServer()` instances (`0.0.0.0` + `[::]` with `ipv6Only: true`) — binding only IPv4
  is not enough to guard the port on a host with `net.ipv6.bindv6only=0`, since a v6-only bind can
  slip past a v4-only guard. A port that's already held by someone else at startup is tracked as
  `wanted` and retried every reconcile tick (`retryWanted(listenSet)`) rather than fought for.
- **`allocator.js`** — decides *which* port to grant (preferredPort validation/conflict/stale-
  replacement eligibility, or first-fit auto-allocation), but does **not** mutate registry records.
  It exposes `withLock(fn)` — an async mutex — so `api.js` can run same-name re-registration,
  stale replacement, release, and "decide a port" + "write the registration record" as serialized
  ownership transactions. Two concurrent requests therefore cannot overwrite the same owner.
- **`guide.js`** — the single source of truth for every string an agent reads: the guard's 409
  body (JSON and HTML), and the `/api/agent-guide` markdown. `guard.js`, `api.js`, and
  `dashboard.js` all render from here so the wording can't drift out of sync between them.
- **`api.js`** — hand-rolled routing (no framework) over the registry/allocator/scanner/guards.
  `buildPortsView()` is the one function that merges all four sources — guard state, registry
  records, and the latest OS scan — into the `/api/ports` shape; `GET /api/ports/:port` instead
  does a **live** lookup (registry/guard state first, then connect-probe, then bind-test only if
  the port looks free) so a single-port check is never stale.
- **`dashboard.js`** — server-renders `GET /` once, then a client-side `<script>` re-fetches
  `/api/ports` every 5s and re-renders the same tables. The client JS is a second, independent
  implementation of the row-rendering logic (written as a plain string, not a template literal, to
  avoid escaping the outer Node template literal) — there's no build step to share code between
  server and client, so if you change how a row renders, change it in both places.
- **`main.js`** — wires all of the above and holds the only shared mutable state: `lastScan`, a
  closure variable updated each reconcile tick and exposed to `allocator`/`api` via a `getLastScan`
  callback (not a shared object reference — always call it, don't cache the result across ticks).
  Startup order matters: the API server binds *before* guard ports are acquired, so
  `/api/agent-guide` and `/api/register` are reachable even in the moment guards are still being
  claimed. A duplicate `local-portal` instance on the same `apiPort` is detected by `fetch`-ing
  `/api/health` and checking `service: "local-portal"` before giving up (exit code `2`, which
  `local-portal.service`'s `RestartPreventExitStatus=2` tells systemd not to retry); any other
  process squatting the apiPort is exit code `1` (systemd does retry, in case that process leaves).

### Config and state locations

Config auto-creates at `~/.config/local-portal/config.json` on first run (override with
`--config <path>`, `$LOCAL_PORTAL_CONFIG`, or `defaultConfigPath()`/`resolveConfigPath()` in
`config.js`). The registry persists to `~/.local/state/local-portal/registry.json` (override via
the `registryPath` config key). Neither path is inside the repo — don't expect to find state files
here during development; point `--config` at a tmp file when testing manually so you don't clobber
your real dev-machine config.

`guardPorts`, `allocRange`, and `apiPort` must never overlap — `config.js`'s `validateConfig()`
silently drops a guard port that collides with `apiPort` (with a warning), so if a port seems to
be missing from `guardPorts` after a config edit, check there first before assuming a bug
elsewhere.
