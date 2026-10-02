import { ClearingError } from './errors.js';
import { normalizeScenario } from './scenario.js';

function agingBonus(waited, agingLimit) {
  if (agingLimit === Infinity) return 0;
  return Math.max(0, waited - agingLimit);
}

export function planSchedule(input, { maxRounds = 1000 } = {}) {
  const sc = normalizeScenario(input);
  const byId = new Map(sc.batches.map((b) => [b.id, b]));
  const remaining = new Map(sc.batches.map((b) => [b.id, b.amount]));
  const waited = new Map(sc.batches.map((b) => [b.id, 0]));
  const groupWaited = new Map([...sc.groups.keys()].map((id) => [id, 0]));
  let totalRemaining = sc.batches.reduce((s, b) => s + b.amount, 0);
  const rounds = [];
  let roundNo = 0;

  while (totalRemaining > 0) {
    roundNo += 1;
    if (roundNo > maxRounds) {
      throw new ClearingError('QUOTA', `batches do not drain within ${maxRounds} rounds; check institution quotas`);
    }

    const candidates = [];
    for (const b of sc.batches) {
      if (b.group !== null || remaining.get(b.id) <= 0 || b.arrivalRound > roundNo) continue;
      candidates.push({
        kind: 'fluid',
        batch: b,
        arrival: b.arrivalRound,
        index: b.index,
        weight: b.priority + agingBonus(waited.get(b.id), sc.agingLimit),
      });
    }
    for (const g of sc.groups.values()) {
      const gRemaining = g.members.reduce((s, id) => s + remaining.get(id), 0);
      if (gRemaining <= 0 || g.arrivalRound > roundNo) continue;
      candidates.push({
        kind: 'group',
        group: g,
        arrival: g.arrivalRound,
        index: g.index,
        weight: g.priority + agingBonus(groupWaited.get(g.id), sc.agingLimit),
      });
    }
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => a.arrival - b.arrival || a.index - b.index);

    const allocs = [];
    let used = 0;
    const usedQuota = new Map();
    const quotaLeft = (inst) => sc.institutions.get(inst).quota - (usedQuota.get(inst) ?? 0);

    const victimsOf = (weight) => allocs
      .filter((a) => a.kind === 'fluid' && a.weight < weight)
      .sort((a, b) => a.weight - b.weight || b.amount - a.amount || (a.batch < b.batch ? -1 : 1));

    const snapshot = () => ({
      allocs: allocs.map((a) => ({ ...a })),
      used,
      usedQuota: new Map(usedQuota),
    });
    const restore = (snap) => {
      allocs.length = 0;
      allocs.push(...snap.allocs);
      used = snap.used;
      usedQuota.clear();
      for (const [k, v] of snap.usedQuota) usedQuota.set(k, v);
    };

    // Preempt lower-weight tentative fluid allocations until `need` fits for
    // institution `inst`. Atomic allocations are never victims. Returns true
    // when enough room was freed. Evicted amounts return to the waiting pool.
    const preemptFor = (weight, need, inst) => {
      const capDeficit = () => used + need - sc.capacity;
      const quotaDeficit = () => (usedQuota.get(inst) ?? 0) + need - sc.institutions.get(inst).quota;
      const fits = () => capDeficit() <= 0 && quotaDeficit() <= 0;
      if (fits()) return true;
      for (const v of victimsOf(weight)) {
        const useful = Math.max(capDeficit(), v.institution === inst ? quotaDeficit() : 0, 0);
        if (useful > 0) {
          const take = Math.min(v.amount, useful);
          v.amount -= take;
          used -= take;
          usedQuota.set(v.institution, usedQuota.get(v.institution) - take);
          if (v.amount === 0) allocs.splice(allocs.indexOf(v), 1);
        }
        if (fits()) return true;
      }
      return fits();
    };

    const placeGroup = (g, weight) => {
      for (const id of g.members) {
        const amount = remaining.get(id);
        allocs.push({ kind: 'atomic', batch: id, institution: g.institution, amount, group: g.id, weight });
        used += amount;
        usedQuota.set(g.institution, (usedQuota.get(g.institution) ?? 0) + amount);
      }
    };

    for (const c of candidates) {
      if (c.kind === 'group') {
        const g = c.group;
        const need = g.members.reduce((s, id) => s + remaining.get(id), 0);
        if (need === 0) continue;
        if (used + need <= sc.capacity && quotaLeft(g.institution) >= need) {
          placeGroup(g, c.weight);
          continue;
        }
        const snap = snapshot();
        if (preemptFor(c.weight, need, g.institution)) {
          placeGroup(g, c.weight);
        } else {
          restore(snap);
        }
      } else {
        const b = c.batch;
        const instQuota = sc.institutions.get(b.institution).quota;
        const desired = Math.min(remaining.get(b.id), sc.capacity, instQuota);
        let room = Math.min(sc.capacity - used, quotaLeft(b.institution));
        if (room < desired) {
          preemptFor(c.weight, desired, b.institution);
          room = Math.min(sc.capacity - used, quotaLeft(b.institution));
        }
        const amount = Math.min(remaining.get(b.id), room);
        if (amount > 0) {
          allocs.push({ kind: 'fluid', batch: b.id, institution: b.institution, amount, weight: c.weight });
          used += amount;
          usedQuota.set(b.institution, (usedQuota.get(b.institution) ?? 0) + amount);
        }
      }
    }

    if (allocs.length === 0) {
      throw new ClearingError('WINDOW_FULL', `no schedulable allocation in round ${roundNo}`);
    }

    const allocatedNow = new Set(allocs.map((a) => a.batch));
    for (const a of allocs) {
      remaining.set(a.batch, remaining.get(a.batch) - a.amount);
      totalRemaining -= a.amount;
    }
    for (const c of candidates) {
      if (c.kind === 'fluid') {
        if (!allocatedNow.has(c.batch.id) && remaining.get(c.batch.id) > 0) {
          waited.set(c.batch.id, waited.get(c.batch.id) + 1);
        }
      } else if (!c.group.members.every((id) => allocatedNow.has(id))) {
        groupWaited.set(c.group.id, groupWaited.get(c.group.id) + 1);
      }
    }

    rounds.push({
      round: roundNo,
      used,
      allocations: allocs
        .map((a) => ({
          batch: a.batch,
          institution: a.institution,
          amount: a.amount,
          ...(a.group ? { group: a.group } : {}),
        }))
        .sort((a, b) => (a.batch < b.batch ? -1 : 1)),
    });
  }

  const waits = computeWaits(sc, rounds);
  return { scenario: sc, rounds, waits };
}

export function computeWaits(sc, rounds) {
  const remaining = new Map(sc.batches.map((b) => [b.id, b.amount]));
  const waits = new Map(sc.batches.map((b) => [b.id, 0]));
  for (const r of rounds) {
    const allocMap = new Map(r.allocations.map((a) => [a.batch, a.amount]));
    for (const b of sc.batches) {
      if (b.arrivalRound <= r.round && remaining.get(b.id) > 0 && !allocMap.has(b.id)) {
        waits.set(b.id, waits.get(b.id) + 1);
      }
    }
    for (const [id, amount] of allocMap) remaining.set(id, remaining.get(id) - amount);
  }
  return Object.fromEntries([...waits.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function validateRounds(sc, rounds) {
  const byId = new Map(sc.batches.map((b) => [b.id, b]));
  const allocatedTotal = new Map(sc.batches.map((b) => [b.id, 0]));
  const groupRounds = new Map([...sc.groups.keys()].map((id) => [id, new Set()]));
  for (const r of rounds) {
    let used = 0;
    const perInst = new Map();
    for (const a of r.allocations) {
      const b = byId.get(a.batch);
      if (!b) throw new ClearingError('CORRUPT', `round ${r.round} references unknown batch "${a.batch}"`);
      if (!Number.isInteger(a.amount) || a.amount <= 0) {
        throw new ClearingError('CORRUPT', `round ${r.round} batch "${a.batch}" has invalid amount`);
      }
      used += a.amount;
      perInst.set(b.institution, (perInst.get(b.institution) ?? 0) + a.amount);
      allocatedTotal.set(a.batch, allocatedTotal.get(a.batch) + a.amount);
      if (b.group !== null) groupRounds.get(b.group).add(r.round);
    }
    if (used > sc.capacity) {
      throw new ClearingError('WINDOW_FULL', `round ${r.round} uses ${used} > capacity ${sc.capacity}`);
    }
    for (const [inst, amount] of perInst) {
      const quota = sc.institutions.get(inst).quota;
      if (amount > quota) {
        throw new ClearingError('QUOTA', `round ${r.round} institution "${inst}" uses ${amount} > quota ${quota}`);
      }
    }
  }
  for (const b of sc.batches) {
    if (allocatedTotal.get(b.id) > b.amount) {
      throw new ClearingError('CORRUPT', `batch "${b.id}" is over-allocated`);
    }
  }
  for (const g of sc.groups.values()) {
    const touched = groupRounds.get(g.id);
    if (touched.size > 1) {
      throw new ClearingError('ATOMIC_SPLIT', `atomic group "${g.id}" is split across rounds ${[...touched].sort((x, y) => x - y).join(', ')}`);
    }
    if (touched.size === 1) {
      const total = g.members.reduce((s, id) => s + allocatedTotal.get(id), 0);
      if (total !== g.total) {
        throw new ClearingError('ATOMIC_SPLIT', `atomic group "${g.id}" partially committed (${total}/${g.total})`);
      }
    }
  }
}
