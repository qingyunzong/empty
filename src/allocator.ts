import { Fraction } from "./fraction.js";

export interface UserSpec {
  id: string;
  /** Total integer demand (units the user wants). */
  demand: number;
  /** Positive fairness weight. */
  weight: number;
  /** Per-user upper bound; defaults to demand. */
  cap?: number;
}

export interface UserRoundEvidence {
  id: string;
  /** Fractional fair share for this round: rate * weight. */
  idealShare: Fraction;
  /** Integer units actually granted in this round. */
  granted: number;
  /** Residual (min of remaining demand / cap) before this round. */
  residualBefore: number;
  saturated: boolean;
  saturatedBy?: "demand" | "cap";
}

export interface RemainderAssignment {
  id: string;
  units: number;
}

export interface RoundRecord {
  round: number;
  capacityBefore: number;
  activeWeightSum: number;
  /** Fair rate for the round: capacityBefore / activeWeightSum (exact fraction). */
  rate: Fraction;
  entries: UserRoundEvidence[];
  /** Flooring remainder handed out one unit at a time in ascending ID order. */
  remainder: RemainderAssignment[];
}

export interface AllocationResult {
  capacity: number;
  allocation: ReadonlyMap<string, number>;
  totalAllocated: number;
  rounds: RoundRecord[];
  /** User IDs in the order they saturated, with the round it happened. */
  saturationOrder: { id: string; round: number }[];
}

interface InternalUser {
  id: string;
  demand: number;
  weight: number;
  cap: number;
}

function normalize(spec: UserSpec): InternalUser {
  if (!Number.isInteger(spec.demand) || spec.demand < 0) {
    throw new Error(`user ${spec.id}: demand must be a non-negative integer`);
  }
  if (!Number.isInteger(spec.weight) || spec.weight <= 0) {
    throw new Error(`user ${spec.id}: weight must be a positive integer`);
  }
  const cap = spec.cap === undefined ? spec.demand : spec.cap;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`user ${spec.id}: cap must be a non-negative integer`);
  }
  return { id: spec.id, demand: spec.demand, weight: spec.weight, cap };
}

/**
 * Round-by-round integer weighted max-min fair allocation (water filling).
 *
 * Each round every still-unsaturated user is offered floor(rate * weight),
 * clamped by its residual demand and cap. Users clamped by demand/cap
 * saturate and leave the active set; freed capacity rolls into the next
 * round. When nobody saturates, the flooring remainder (< active count)
 * is dealt one unit per user in ascending ID order.
 */
export function allocate(specs: UserSpec[], capacity: number): AllocationResult {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error("capacity must be a non-negative integer");
  }
  const users = specs.map(normalize).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const granted = new Map<string, number>(users.map((u) => [u.id, 0]));
  const residual = (u: InternalUser): number =>
    Math.min(u.demand, u.cap) - (granted.get(u.id) ?? 0);

  let remaining = capacity;
  let active = users.filter((u) => residual(u) > 0);
  const rounds: RoundRecord[] = [];
  const saturationOrder: { id: string; round: number }[] = [];

  while (remaining > 0 && active.length > 0) {
    const roundNo = rounds.length + 1;
    const weightSum = active.reduce((s, u) => s + u.weight, 0);
    const theRate = new Fraction(remaining, weightSum);
    const entries: UserRoundEvidence[] = [];
    const stillActive: InternalUser[] = [];

    for (const u of active) {
      const ideal = theRate.mul(u.weight);
      const floorShare = Number(ideal.floor());
      const res = residual(u);
      const grant = Math.min(floorShare, res);
      granted.set(u.id, (granted.get(u.id) ?? 0) + grant);
      remaining -= grant;
      const saturated = res <= floorShare;
      if (saturated) {
        saturationOrder.push({ id: u.id, round: roundNo });
      } else {
        stillActive.push(u);
      }
      entries.push({
        id: u.id,
        idealShare: ideal,
        granted: grant,
        residualBefore: res,
        saturated,
        saturatedBy: saturated ? (u.demand <= u.cap ? "demand" : "cap") : undefined,
      });
    }

    const remainderAssignments: RemainderAssignment[] = [];
    if (stillActive.length === active.length && remaining > 0) {
      // Nobody saturated: leftover is the flooring remainder (< active count).
      for (const u of stillActive) {
        if (remaining === 0) break;
        if (residual(u) <= 0) continue;
        granted.set(u.id, (granted.get(u.id) ?? 0) + 1);
        remaining -= 1;
        remainderAssignments.push({ id: u.id, units: 1 });
        if (residual(u) === 0) {
          saturationOrder.push({ id: u.id, round: roundNo });
          const entry = entries.find((e) => e.id === u.id);
          if (entry) {
            entry.saturated = true;
            entry.saturatedBy = u.demand <= u.cap ? "demand" : "cap";
          }
        }
      }
      active = stillActive.filter((u) => residual(u) > 0);
    } else {
      active = stillActive;
    }

    rounds.push({
      round: roundNo,
      capacityBefore: remaining + entries.reduce((s, e) => s + e.granted, 0) + remainderAssignments.reduce((s, a) => s + a.units, 0),
      activeWeightSum: weightSum,
      rate: theRate,
      entries,
      remainder: remainderAssignments,
    });
  }

  const totalAllocated = capacity - remaining;
  return {
    capacity,
    allocation: granted,
    totalAllocated,
    rounds,
    saturationOrder,
  };
}

/** Allocator holding mutable user state; demand revocation triggers re-allocation. */
export class FairAllocator {
  private users = new Map<string, UserSpec>();

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 0) {
      throw new Error("capacity must be a non-negative integer");
    }
  }

  addUser(spec: UserSpec): this {
    this.users.set(spec.id, { ...spec });
    return this;
  }

  /** Revoke a user's demand (set to 0) and re-run the allocation from scratch. */
  revokeDemand(id: string): AllocationResult {
    const spec = this.users.get(id);
    if (!spec) throw new Error(`unknown user: ${id}`);
    spec.demand = 0;
    return this.allocate();
  }

  allocate(): AllocationResult {
    return allocate([...this.users.values()], this.capacity);
  }
}

/** Human-readable evidence report: saturated rounds plus fractional shares. */
export function formatReport(result: AllocationResult): string {
  const lines: string[] = [];
  lines.push(`capacity=${result.capacity} allocated=${result.totalAllocated}`);
  for (const round of result.rounds) {
    lines.push(
      `round ${round.round}: capacity=${round.capacityBefore} weightSum=${round.activeWeightSum} rate=${round.rate}`,
    );
    for (const e of round.entries) {
      const mark = e.saturated ? ` SATURATED(${e.saturatedBy})` : "";
      lines.push(
        `  user ${e.id}: ideal=${e.idealShare} granted=${e.granted} residual=${e.residualBefore}${mark}`,
      );
    }
    if (round.remainder.length > 0) {
      const detail = round.remainder.map((a) => `${a.id}+${a.units}`).join(", ");
      lines.push(`  remainder by ID: ${detail}`);
    }
  }
  const order = result.saturationOrder.map((s) => `${s.id}@r${s.round}`).join(" -> ");
  lines.push(`saturation order: ${order || "(none)"}`);
  const finalAlloc = [...result.allocation.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, v]) => `${id}=${v}`)
    .join(" ");
  lines.push(`final: ${finalAlloc}`);
  return lines.join("\n");
}
