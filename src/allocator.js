export class AllocError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

function isValidPreferredPort(n) {
  return Number.isInteger(n) && n >= 1025 && n <= 65535;
}

/**
 * Port grant logic: preferredPort validation/conflict/eviction, or
 * first-fit auto-allocation over allocRange. Always bind-tests before
 * granting. Does NOT touch the registry's own records other than evicting a
 * stale one that blocks a requested preferredPort — creating the new
 * registration record is the caller's job (see withLock below), so
 * grant+register can be done atomically under one lock hold.
 */
export function createAllocator({ registry, scanner, guardPorts, allocRange, apiPort, getLastScan, log }) {
  let queue = Promise.resolve();

  /** Serializes concurrent register calls so two agents never race onto the same port. */
  function withLock(fn) {
    const result = queue.then(fn);
    queue = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  async function grant({ name, preferredPort }) {
    if (preferredPort !== undefined && preferredPort !== null) {
      let expectedStaleOwner = null;
      if (!isValidPreferredPort(preferredPort)) {
        throw new AllocError(
          "invalid_port",
          "preferredPort must be an integer between 1025 and 65535",
        );
      }
      if (guardPorts.includes(preferredPort) || preferredPort === apiPort) {
        throw new AllocError(
          "port_guarded",
          `port ${preferredPort} is guarded by design — omit preferredPort to get an allocation, or pick another port`,
        );
      }

      const existing = registry.getByPort(preferredPort);
      if (existing && existing.name !== name) {
        if (existing.status === "stale") {
          expectedStaleOwner = {
            id: existing.id,
            name: existing.name,
            status: existing.status,
          };
          log?.info?.(
            "allocator",
            `stale registration ${existing.name}:${preferredPort} will be durably replaced by ${name}`,
          );
        } else {
          throw new AllocError(
            "port_registered",
            `port ${preferredPort} is already registered to "${existing.name}" (${existing.status})`,
            { owner: existing.name, status: existing.status },
          );
        }
      }

      const free = await scanner.isPortFree(preferredPort);
      if (!free) {
        const lastScan = getLastScan?.();
        const process = lastScan?.ports?.get(preferredPort)?.processes?.[0] ?? null;
        throw new AllocError(
          "port_unmanaged",
          `port ${preferredPort} is occupied by an unmanaged process`,
          { process },
        );
      }

      const current = registry.getByPort(preferredPort);
      if (expectedStaleOwner) {
        if (
          !current ||
          current.id !== expectedStaleOwner.id ||
          current.name !== expectedStaleOwner.name ||
          current.status !== expectedStaleOwner.status
        ) {
          throw new AllocError(
            "allocation_changed",
            `port ${preferredPort} registration changed while availability was checked`,
            { owner: current?.name ?? null, status: current?.status ?? null },
          );
        }
      } else if (current && current.name !== name) {
        throw new AllocError(
          "allocation_changed",
          `port ${preferredPort} was registered while availability was checked`,
          { owner: current.name, status: current.status },
        );
      }

      return { port: preferredPort };
    }

    const lastScan = getLastScan?.();
    const occupiedFromScan = lastScan?.ports ? new Set(lastScan.ports.keys()) : new Set();

    for (let candidate = allocRange.start; candidate <= allocRange.end; candidate++) {
      if (guardPorts.includes(candidate) || candidate === apiPort) continue;
      if (registry.getByPort(candidate)) continue; // pending/active/stale all reserved
      if (occupiedFromScan.has(candidate)) continue;
      if (await scanner.isPortFree(candidate)) return { port: candidate };
    }

    throw new AllocError(
      "range_exhausted",
      `no free port available in range ${allocRange.start}-${allocRange.end}`,
    );
  }

  return { withLock, grant };
}
