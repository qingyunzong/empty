import { EdgeSpec, NetworkSpec, Segment } from "./types";

export const MAX_AMOUNT = 20;

export class InputError extends Error {}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function validateNetwork(raw: unknown): NetworkSpec {
  if (typeof raw !== "object" || raw === null) {
    throw new InputError("network spec must be a JSON object");
  }
  const spec = raw as Record<string, unknown>;
  if (typeof spec.source !== "string" || typeof spec.sink !== "string") {
    throw new InputError('"source" and "sink" must be node name strings');
  }
  if (spec.source === spec.sink) {
    throw new InputError("source and sink must differ");
  }
  if (!isInt(spec.amount) || spec.amount < 0 || spec.amount > MAX_AMOUNT) {
    throw new InputError(`"amount" must be an integer in [0, ${MAX_AMOUNT}]`);
  }
  if (!Array.isArray(spec.edges)) {
    throw new InputError('"edges" must be an array');
  }
  const nodeSet = new Set<string>();
  if (spec.nodes !== undefined) {
    if (!Array.isArray(spec.nodes) || spec.nodes.some((n) => typeof n !== "string")) {
      throw new InputError('"nodes" must be an array of strings');
    }
    for (const n of spec.nodes as string[]) nodeSet.add(n);
  }
  const edges: EdgeSpec[] = (spec.edges as unknown[]).map((rawEdge, i) => {
    const e = rawEdge as Record<string, unknown>;
    const where = `edges[${i}]`;
    if (typeof e.from !== "string" || typeof e.to !== "string") {
      throw new InputError(`${where}: "from" and "to" must be node name strings`);
    }
    if (e.from === e.to) {
      throw new InputError(`${where}: self-loops are not allowed`);
    }
    if (!isInt(e.capacity) || e.capacity < 0) {
      throw new InputError(`${where}: "capacity" must be a non-negative integer`);
    }
    if (!Array.isArray(e.segments) || e.segments.length === 0) {
      throw new InputError(`${where}: "segments" must be a non-empty array`);
    }
    const segments: Segment[] = (e.segments as unknown[]).map((rawSeg, j) => {
      const s = rawSeg as Record<string, unknown>;
      if (!isInt(s.upTo) || !isInt(s.unitCost)) {
        throw new InputError(`${where}.segments[${j}]: "upTo" and "unitCost" must be integers`);
      }
      return { upTo: s.upTo, unitCost: s.unitCost };
    });
    let prevUpTo = 0;
    let prevCost = -Infinity;
    for (const seg of segments) {
      if (seg.upTo <= prevUpTo) {
        throw new InputError(`${where}: segment "upTo" values must be strictly increasing`);
      }
      if (seg.unitCost < prevCost) {
        throw new InputError(
          `${where}: marginal costs must be non-decreasing (convex piecewise fees required)`
        );
      }
      prevUpTo = seg.upTo;
      prevCost = seg.unitCost;
    }
    if (prevUpTo !== e.capacity) {
      throw new InputError(
        `${where}: last segment "upTo" (${prevUpTo}) must equal capacity (${e.capacity})`
      );
    }
    nodeSet.add(e.from);
    nodeSet.add(e.to);
    return { from: e.from, to: e.to, capacity: e.capacity, segments };
  });
  for (const endpoint of [spec.source, spec.sink]) {
    if (!nodeSet.has(endpoint)) {
      throw new InputError(`node "${endpoint}" is not declared and not used by any edge`);
    }
  }
  return {
    nodes: [...nodeSet],
    edges,
    source: spec.source,
    sink: spec.sink,
    amount: spec.amount,
    atMost: spec.atMost === true,
  };
}

/** Cost of sending `flow` units through one edge, given its fee segments. */
export function edgeCost(segments: Segment[], flow: number): number {
  let cost = 0;
  let prev = 0;
  for (const seg of segments) {
    if (flow <= prev) break;
    const units = Math.min(flow, seg.upTo) - prev;
    cost += units * seg.unitCost;
    prev = seg.upTo;
  }
  return cost;
}

/** Marginal cost of the k-th unit (1-based) on an edge. */
export function marginalCost(segments: Segment[], k: number): number {
  for (const seg of segments) {
    if (k <= seg.upTo) return seg.unitCost;
  }
  throw new Error(`unit ${k} exceeds capacity ${segments[segments.length - 1]?.upTo}`);
}
