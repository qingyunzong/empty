import { computeProof } from './proof.js';

const EPS = 1e-9;

export const DEFAULT_AGING = { agingLimit: 2, agingBonus: 1 };

export function agingConfig(input) {
  return {
    agingLimit: input.agingLimit ?? DEFAULT_AGING.agingLimit,
    agingBonus: input.agingBonus ?? DEFAULT_AGING.agingBonus,
  };
}

// Fair aging: batches waiting longer than agingLimit gain weight, but weight
// only reorders candidates; window capacity and quotas stay hard limits.
export function effectiveWeight(priority, waited, cfg) {
  const over = Math.max(0, waited - cfg.agingLimit);
  return priority * (1 + over * cfg.agingBonus);
}

export function validateInput(input) {
  if (!Number.isFinite(input.capacity) || input.capacity <= 0) {
    return { code: 'INVALID_INPUT', message: 'capacity must be a positive number' };
  }
  if (!Array.isArray(input.batches)) {
    return { code: 'INVALID_INPUT', message: 'batches must be an array' };
  }
  const institutions = input.institutions ?? {};
  const groups = new Map();
  for (const b of input.batches) {
    if (typeof b.id !== 'string' || b.id.length === 0) {
      return { code: 'INVALID_INPUT', message: 'every batch needs a string id' };
    }
    if (!Number.isFinite(b.amount) || b.amount <= 0) {
      return { code: 'INVALID_INPUT', message: `batch ${b.id}: amount must be positive` };
    }
    if (b.priority !== undefined && !(b.priority > 0)) {
      return { code: 'INVALID_INPUT', message: `batch ${b.id}: priority must be positive` };
    }
    if (b.arrival !== undefined && !(Number.isInteger(b.arrival) && b.arrival >= 1)) {
      return { code: 'INVALID_INPUT', message: `batch ${b.id}: arrival must be an integer >= 1` };
    }
    const inst = institutions[b.institution];
    if (!inst || !(inst.quota > 0)) {
      return { code: 'QUOTA', message: `batch ${b.id}: institution ${b.institution} has no positive quota` };
    }
    if (b.group) {
      const g = groups.get(b.group) ?? { total: 0, perInst: {} };
      g.total += b.amount;
      g.perInst[b.institution] = (g.perInst[b.institution] ?? 0) + b.amount;
      groups.set(b.group, g);
    } else if (!b.splittable) {
      if (b.amount > input.capacity) {
        return { code: 'WINDOW_FULL', message: `batch ${b.id} (${b.amount}) can never fit window capacity ${input.capacity}` };
      }
      if (b.amount > inst.quota) {
        return { code: 'QUOTA', message: `batch ${b.id} (${b.amount}) exceeds quota of ${b.institution} (${inst.quota})` };
      }
    }
  }
  for (const [id, g] of groups) {
    if (g.total > input.capacity) {
      return { code: 'ATOMIC_SPLIT', message: `atomic group ${id} (${g.total}) exceeds window capacity ${input.capacity}; refusing to split` };
    }
    for (const [inst, amt] of Object.entries(g.perInst)) {
      if (amt > institutions[inst].quota) {
        return { code: 'QUOTA', message: `atomic group ${id} needs ${amt} of ${inst} quota ${institutions[inst].quota}` };
      }
    }
  }
  return null;
}

// Build scheduling items from the waiting queue. Atomic groups collapse into
// a single indivisible item; splittable batches become capacity fillers.
// Batches arriving after roundIndex are not eligible yet.
export function buildItems(input, remaining, waits, roundIndex = 1) {
  const cfg = agingConfig(input);
  const groupItems = new Map();
  const discrete = [];
  const splittable = [];
  for (const b of input.batches) {
    const rem = remaining[b.id] ?? 0;
    if (rem <= EPS) continue;
    if ((b.arrival ?? 1) > roundIndex) continue;
    const weight = effectiveWeight(b.priority ?? 1, waits[b.id] ?? 0, cfg);
    if (b.group) {
      if (!groupItems.has(b.group)) {
        groupItems.set(b.group, {
          id: `group:${b.group}`,
          group: b.group,
          atomic: true,
          amount: 0,
          weight: 0,
          instAmounts: {},
          members: [],
        });
      }
      const g = groupItems.get(b.group);
      g.amount += rem;
      g.weight += weight;
      g.instAmounts[b.institution] = (g.instAmounts[b.institution] ?? 0) + rem;
      g.members.push({ id: b.id, institution: b.institution, amount: rem });
    } else if (b.splittable) {
      splittable.push({ id: b.id, institution: b.institution, amount: rem, weight });
    } else {
      discrete.push({
        id: b.id,
        group: null,
        atomic: false,
        amount: rem,
        weight,
        instAmounts: { [b.institution]: rem },
        members: [{ id: b.id, institution: b.institution, amount: rem }],
      });
    }
  }
  for (const g of groupItems.values()) discrete.push(g);
  splittable.sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { discrete, splittable };
}

function cmpItems(a, b) {
  return b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function feasible(items, capacity, quotas) {
  let used = 0;
  const perInst = {};
  for (const it of items) {
    used += it.amount;
    for (const [inst, amt] of Object.entries(it.instAmounts)) {
      perInst[inst] = (perInst[inst] ?? 0) + amt;
    }
  }
  if (used > capacity + EPS) return false;
  for (const [inst, amt] of Object.entries(perInst)) {
    if (amt > (quotas[inst] ?? 0) + EPS) return false;
  }
  return true;
}

function fillSplittable(placed, splittable, capacity, quotas) {
  let used = placed.reduce((s, p) => s + p.amount, 0);
  const perInst = {};
  for (const p of placed) {
    for (const [inst, amt] of Object.entries(p.instAmounts)) {
      perInst[inst] = (perInst[inst] ?? 0) + amt;
    }
  }
  const fills = [];
  let fillScore = 0;
  for (const s of splittable) {
    const room = Math.min(s.amount, capacity - used, (quotas[s.institution] ?? 0) - (perInst[s.institution] ?? 0));
    if (room > EPS) {
      fills.push({ id: s.id, amount: room });
      fillScore += s.weight * (room / s.amount);
      used += room;
      perInst[s.institution] = (perInst[s.institution] ?? 0) + room;
    }
  }
  return { fills, fillScore };
}

// Exact packing for small queues (n <= 9 discrete items): enumerate every
// subset, keep feasible ones (capacity + per-institution quota), fill the
// remainder with splittable batches, maximize settled weight.
export function exactPack(discrete, splittable, capacity, quotas) {
  let best = null;
  const n = discrete.length;
  for (let mask = 0; mask < 2 ** n; mask++) {
    const placed = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) placed.push(discrete[i]);
    if (!feasible(placed, capacity, quotas)) continue;
    const weight = placed.reduce((s, p) => s + p.weight, 0);
    const { fills, fillScore } = fillSplittable(placed, splittable, capacity, quotas);
    const score = weight + fillScore;
    const used = placed.reduce((s, p) => s + p.amount, 0) + fills.reduce((s, f) => s + f.amount, 0);
    if (!best || score > best.score + EPS || (Math.abs(score - best.score) <= EPS && used > best.used + EPS)) {
      best = { placed, fills, score, used };
    }
  }
  return best;
}

// Greedy packing for large queues: place by weight, and let a high-priority
// item preempt (roll back) strictly lower-weight non-atomic placements.
// Confirmed atomic groups are never evicted.
export function greedyPack(discrete, splittable, capacity, quotas) {
  const sorted = [...discrete].sort(cmpItems);
  let placed = [];
  for (const it of sorted) {
    if (feasible([...placed, it], capacity, quotas)) {
      placed.push(it);
      continue;
    }
    const evictable = placed
      .filter((p) => !p.atomic && p.weight < it.weight - EPS)
      .sort((a, b) => a.weight - b.weight);
    const candidate = [...placed];
    for (const e of evictable) {
      candidate.splice(candidate.indexOf(e), 1);
      if (feasible([...candidate, it], capacity, quotas)) break;
    }
    if (feasible([...candidate, it], capacity, quotas)) {
      placed = [...candidate, it];
    }
  }
  const { fills, fillScore } = fillSplittable(placed, splittable, capacity, quotas);
  const weight = placed.reduce((s, p) => s + p.weight, 0);
  const used = placed.reduce((s, p) => s + p.amount, 0) + fills.reduce((s, f) => s + f.amount, 0);
  return { placed, fills, score: weight + fillScore, used };
}

export function planRound(input, remaining, waits, roundIndex = 1) {
  const quotas = Object.fromEntries(
    Object.entries(input.institutions ?? {}).map(([k, v]) => [k, v.quota]),
  );
  const { discrete, splittable } = buildItems(input, remaining, waits, roundIndex);
  const pack =
    discrete.length <= 9
      ? exactPack(discrete, splittable, input.capacity, quotas)
      : greedyPack(discrete, splittable, input.capacity, quotas);
  const allocations = [];
  for (const item of pack.placed) {
    for (const m of item.members) {
      allocations.push({ batch: m.id, group: item.group ?? null, institution: m.institution, amount: m.amount });
    }
  }
  for (const f of pack.fills) {
    const s = splittable.find((x) => x.id === f.id);
    allocations.push({ batch: f.id, group: null, institution: s.institution, amount: f.amount });
  }
  allocations.sort((a, b) => (a.batch < b.batch ? -1 : a.batch > b.batch ? 1 : 0));
  const used = allocations.reduce((s, a) => s + a.amount, 0);
  return { allocations, used, score: pack.score };
}

export function applyAllocation(input, remaining, waits, allocations, roundIndex) {
  for (const a of allocations) {
    const left = (remaining[a.batch] ?? 0) - a.amount;
    remaining[a.batch] = Math.abs(left) < EPS ? 0 : left;
  }
  for (const b of input.batches ?? []) {
    const left = remaining[b.id] ?? 0;
    if (left <= 0) {
      delete remaining[b.id];
      delete waits[b.id];
    } else if ((b.arrival ?? 1) <= roundIndex) {
      waits[b.id] = (waits[b.id] ?? 0) + 1;
    }
  }
}

// Dry-run forward from a state until the queue drains; used by `plan`.
export function simulate(input, state, maxRounds = 10000) {
  const remaining = { ...state.remaining };
  const waits = { ...state.waits };
  const rounds = [];
  let proof = state.proof;
  let index = state.nextRound;
  while (Object.keys(remaining).length > 0 && rounds.length < maxRounds) {
    const r = planRound(input, remaining, waits, index);
    const core = { index, allocations: r.allocations, used: r.used };
    proof = computeProof(proof, core);
    rounds.push({ ...core, proof });
    applyAllocation(input, remaining, waits, r.allocations, index);
    index += 1;
  }
  return { rounds, remaining, waits, proof, nextRound: index };
}
