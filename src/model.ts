/** Problem definition for the transfer CLI. */

export interface Segment {
  /** Integer capacity of this cost segment (units). */
  capacity: number;
  /** Integer fee per unit for this segment (may be negative). */
  cost: number;
}

export interface EdgeSpec {
  from: string;
  to: string;
  /** Piecewise-linear fee curve: segments must have non-decreasing `cost`. */
  segments: Segment[];
}

export interface Problem {
  source: string;
  sink: string;
  /** Integer units to send, 0..MAX_AMOUNT. */
  amount: number;
  edges: EdgeSpec[];
}

export const MAX_AMOUNT = 20;

export class InputError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

/** Parse and validate raw JSON into a Problem. Throws InputError. */
export function parseProblem(raw: unknown): Problem {
  if (!isRecord(raw)) throw new InputError("input must be a JSON object");
  const { source, sink, amount, edges } = raw;

  if (typeof source !== "string" || source.length === 0)
    throw new InputError('"source" must be a non-empty string');
  if (typeof sink !== "string" || sink.length === 0)
    throw new InputError('"sink" must be a non-empty string');
  if (source === sink) throw new InputError('"source" and "sink" must differ');

  if (!isInt(amount) || amount < 0 || amount > MAX_AMOUNT)
    throw new InputError(`"amount" must be an integer in [0, ${MAX_AMOUNT}]`);

  if (!Array.isArray(edges)) throw new InputError('"edges" must be an array');

  const parsed: EdgeSpec[] = edges.map((e, i) => {
    if (!isRecord(e)) throw new InputError(`edges[${i}] must be an object`);
    const { from, to, segments } = e;
    if (typeof from !== "string" || from.length === 0)
      throw new InputError(`edges[${i}].from must be a non-empty string`);
    if (typeof to !== "string" || to.length === 0)
      throw new InputError(`edges[${i}].to must be a non-empty string`);
    if (from === to) throw new InputError(`edges[${i}] is a self-loop (${from})`);
    if (!Array.isArray(segments) || segments.length === 0)
      throw new InputError(`edges[${i}].segments must be a non-empty array`);

    const segs: Segment[] = segments.map((s, j) => {
      if (!isRecord(s)) throw new InputError(`edges[${i}].segments[${j}] must be an object`);
      const { capacity, cost } = s;
      if (!isInt(capacity) || capacity <= 0)
        throw new InputError(`edges[${i}].segments[${j}].capacity must be a positive integer`);
      if (!isInt(cost))
        throw new InputError(`edges[${i}].segments[${j}].cost must be an integer`);
      return { capacity, cost };
    });

    for (let j = 1; j < segs.length; j++) {
      const prev = segs[j - 1]!;
      const cur = segs[j]!;
      if (cur.cost < prev.cost)
        throw new InputError(
          `edges[${i}].segments must have non-decreasing cost (convex fees); ` +
            `segment ${j - 1} has cost ${prev.cost} > ${cur.cost}`
        );
    }
    return { from, to, segments: segs };
  });

  return { source, sink, amount, edges: parsed };
}

/** Piecewise-linear cost of pushing `units` through an edge. */
export function edgeCost(edge: EdgeSpec, units: number): number {
  let remaining = units;
  let total = 0;
  for (const seg of edge.segments) {
    const take = Math.min(remaining, seg.capacity);
    total += take * seg.cost;
    remaining -= take;
    if (remaining <= 0) break;
  }
  if (remaining > 0) throw new InputError("units exceed edge capacity");
  return total;
}

export function edgeCapacity(edge: EdgeSpec): number {
  return edge.segments.reduce((acc, s) => acc + s.capacity, 0);
}
