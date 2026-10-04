import { createHash } from "node:crypto";

export class DeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryError";
  }
}

export interface EventSpec {
  id: string;
  priority: number;
  deps?: readonly string[];
  meta?: Record<string, unknown>;
}

export interface CertificateCore {
  seq: number;
  eventId: string;
  priority: number;
  satisfiedDeps: string[];
  meta: Record<string, unknown>;
}

export interface DeliveryCertificate extends CertificateCore {
  digest: string;
}

export interface BlockingChain {
  eventId: string;
  chain: string[];
  rootCancelledId: string;
}

export interface CancelledRecord {
  eventId: string;
  priority: number;
  deps: string[];
  meta: Record<string, unknown>;
}

export interface DeliveryPlan {
  order: string[];
  certificates: DeliveryCertificate[];
  blocked: string[];
  blockingChains: BlockingChain[];
  cancelled: CancelledRecord[];
}

interface Normalized {
  id: string;
  priority: number;
  deps: string[];
  meta: Record<string, unknown>;
}

const INT_RE = /^-?\d+$/;

export function compareIds(a: string, b: string): number {
  const aInt = INT_RE.test(a);
  const bInt = INT_RE.test(b);
  if (aInt && bInt) {
    const ba = BigInt(a);
    const bb = BigInt(b);
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function certificateDigest(core: CertificateCore): string {
  return createHash("sha256").update(stableStringify(core)).digest("hex");
}

function normalize(events: readonly EventSpec[]): Map<string, Normalized> {
  const byId = new Map<string, Normalized>();
  for (const e of events) {
    if (typeof e.id !== "string" || e.id.length === 0) {
      throw new DeliveryError("event id must be a non-empty string");
    }
    if (byId.has(e.id)) {
      throw new DeliveryError(`duplicate event id: ${e.id}`);
    }
    if (typeof e.priority !== "number" || !Number.isFinite(e.priority)) {
      throw new DeliveryError(`event ${e.id} has invalid priority`);
    }
    byId.set(e.id, {
      id: e.id,
      priority: e.priority,
      deps: [...new Set(e.deps ?? [])],
      meta: { ...(e.meta ?? {}) },
    });
  }
  for (const e of byId.values()) {
    for (const d of e.deps) {
      if (d === e.id) {
        throw new DeliveryError(`event ${e.id} depends on itself`);
      }
      if (!byId.has(d)) {
        throw new DeliveryError(`event ${e.id} depends on unknown event ${d}`);
      }
    }
  }
  return byId;
}

function buildDependents(byId: Map<string, Normalized>): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const e of byId.values()) {
    for (const d of e.deps) {
      const list = dependents.get(d);
      if (list) list.push(e.id);
      else dependents.set(d, [e.id]);
    }
  }
  return dependents;
}

function assertAcyclic(byId: Map<string, Normalized>, dependents: Map<string, string[]>): void {
  const indeg = new Map<string, number>();
  for (const e of byId.values()) indeg.set(e.id, e.deps.length);
  const stack = [...byId.keys()].filter((id) => indeg.get(id) === 0);
  let seen = 0;
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    seen++;
    for (const m of dependents.get(cur) ?? []) {
      const d = (indeg.get(m) as number) - 1;
      indeg.set(m, d);
      if (d === 0) stack.push(m);
    }
  }
  if (seen !== byId.size) {
    throw new DeliveryError("dependency cycle detected");
  }
}

function computeBlocked(
  cancelled: ReadonlySet<string>,
  dependents: Map<string, string[]>,
): Set<string> {
  const blocked = new Set<string>();
  const queue = [...cancelled];
  while (queue.length > 0) {
    const cur = queue.pop() as string;
    for (const next of dependents.get(cur) ?? []) {
      if (!cancelled.has(next) && !blocked.has(next)) {
        blocked.add(next);
        queue.push(next);
      }
    }
  }
  return blocked;
}

function findBlockingChain(
  start: string,
  byId: Map<string, Normalized>,
  blocked: ReadonlySet<string>,
  cancelled: ReadonlySet<string>,
): string[] {
  const prev = new Map<string, string | null>();
  prev.set(start, null);
  let frontier = [start];
  let found: string | null = null;
  while (frontier.length > 0 && found === null) {
    const next: string[] = [];
    for (const node of frontier) {
      const deps = [...(byId.get(node) as Normalized).deps].sort(compareIds);
      for (const d of deps) {
        if (cancelled.has(d)) {
          if (!prev.has(d)) {
            prev.set(d, node);
            found = d;
          }
        } else if (blocked.has(d) && !prev.has(d)) {
          prev.set(d, node);
          next.push(d);
        }
      }
      if (found !== null) break;
    }
    frontier = next;
  }
  if (found === null) {
    throw new DeliveryError(`internal: no blocking chain for ${start}`);
  }
  const chain: string[] = [];
  let cur: string | null = found;
  while (cur !== null) {
    chain.push(cur);
    cur = prev.get(cur) ?? null;
  }
  return chain.reverse();
}

export function buildDeliveryPlan(
  events: readonly EventSpec[],
  cancelledIds: readonly string[] = [],
): DeliveryPlan {
  const byId = normalize(events);
  const cancelled = new Set(cancelledIds);
  for (const c of cancelled) {
    if (!byId.has(c)) {
      throw new DeliveryError(`cancelled id not found: ${c}`);
    }
  }
  const dependents = buildDependents(byId);
  assertAcyclic(byId, dependents);
  const blocked = computeBlocked(cancelled, dependents);

  const delivered = new Set<string>();
  const remaining = new Set<string>();
  for (const id of byId.keys()) {
    if (!cancelled.has(id) && !blocked.has(id)) remaining.add(id);
  }

  const order: string[] = [];
  const certificates: DeliveryCertificate[] = [];
  while (remaining.size > 0) {
    let best: Normalized | null = null;
    for (const id of remaining) {
      const e = byId.get(id) as Normalized;
      if (!e.deps.every((d) => delivered.has(d))) continue;
      if (
        best === null ||
        e.priority > best.priority ||
        (e.priority === best.priority && compareIds(e.id, best.id) < 0)
      ) {
        best = e;
      }
    }
    if (best === null) {
      throw new DeliveryError("no deliverable candidate remains");
    }
    remaining.delete(best.id);
    delivered.add(best.id);
    order.push(best.id);
    const core: CertificateCore = {
      seq: order.length,
      eventId: best.id,
      priority: best.priority,
      satisfiedDeps: [...best.deps],
      meta: best.meta,
    };
    certificates.push({ ...core, digest: certificateDigest(core) });
  }

  const blockedSorted = [...blocked].sort(compareIds);
  const blockingChains: BlockingChain[] = blockedSorted.map((id) => {
    const chain = findBlockingChain(id, byId, blocked, cancelled);
    return {
      eventId: id,
      chain,
      rootCancelledId: chain[chain.length - 1] as string,
    };
  });

  const cancelledRecords: CancelledRecord[] = [...cancelled].sort(compareIds).map((id) => {
    const e = byId.get(id) as Normalized;
    return { eventId: id, priority: e.priority, deps: [...e.deps], meta: { ...e.meta } };
  });

  return {
    order,
    certificates,
    blocked: blockedSorted,
    blockingChains,
    cancelled: cancelledRecords,
  };
}
