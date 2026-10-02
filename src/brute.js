// Independent small-scale enumerator (<= 6 operations) and witness verifier.
// Deliberately does NOT share search code with src/checker.js: it generates
// all n! permutations, filters by pairwise real-time precedence, assigns
// linearization points independently, and searches capture allocations
// explicitly instead of deriving them from the reported totals.

function auditOf(hold) {
  const frozen = hold.active ? hold.amount - hold.captured : 0;
  return { frozen, captured: hold.captured, available: frozen };
}

function cloneHolds(holds) {
  const next = new Map();
  for (const [key, value] of holds) next.set(key, { ...value });
  return next;
}

// Independent replay of a single operation. `allocation` is only used for
// successful captures. Returns the next holds map, the effect, or null.
function replay(holds, op, point, allocation) {
  const res = op.response;
  if (op.op === 'hold') {
    if (!res.ok || holds.has(res.holdId)) return null;
    const next = cloneHolds(holds);
    next.set(res.holdId, { amount: op.amount, captured: 0, active: true, deadline: op.deadline });
    return { holds: next, effect: {} };
  }
  if (op.op === 'capture') {
    const hold = holds.get(op.holdId);
    if (!res.ok) {
      if (res.error === 'not_found' && !hold) return { holds, effect: {} };
      if (res.error === 'cancelled' && hold && !hold.active) return { holds, effect: {} };
      if (res.error === 'expired' && hold && hold.active && point > hold.deadline) {
        return { holds, effect: {} };
      }
      if (
        res.error === 'insufficient' &&
        hold &&
        hold.active &&
        point <= hold.deadline &&
        op.amount > hold.amount - hold.captured
      ) {
        return { holds, effect: {} };
      }
      return null;
    }
    if (!hold || !hold.active || point > hold.deadline) return null;
    if (!Number.isInteger(allocation) || allocation < 0 || allocation > op.amount) return null;
    if (hold.captured + allocation !== res.totalCaptured) return null;
    if (res.totalCaptured > hold.amount) return null;
    const next = cloneHolds(holds);
    next.get(op.holdId).captured = res.totalCaptured;
    return { holds: next, effect: { allocation } };
  }
  if (op.op === 'cancel') {
    const hold = holds.get(op.holdId);
    if (!res.ok) {
      if (res.error === 'not_found' && !hold) return { holds, effect: {} };
      if (res.error === 'cancelled' && hold && !hold.active) return { holds, effect: {} };
      return null;
    }
    if (!hold || !hold.active) return null;
    if (res.released !== hold.amount - hold.captured) return null;
    const next = cloneHolds(holds);
    next.get(op.holdId).active = false;
    return { holds: next, effect: { released: res.released } };
  }
  if (op.op === 'audit') {
    const hold = holds.get(op.holdId);
    if (!res.ok) return res.error === 'not_found' && !hold ? { holds, effect: {} } : null;
    if (!hold) return null;
    const observed = auditOf(hold);
    if (
      observed.frozen !== res.frozen ||
      observed.captured !== res.captured ||
      observed.available !== res.available
    ) {
      return null;
    }
    return { holds, effect: { observed } };
  }
  return null;
}

function respectsRealTime(ops, perm) {
  for (let x = 0; x < perm.length; x += 1) {
    for (let y = x + 1; y < perm.length; y += 1) {
      // ops[b] ends before ops[a] starts, so b must have been placed first.
      if (ops[perm[y]].respond <= ops[perm[x]].invoke) return false;
    }
  }
  return true;
}

function greedyPoints(ops, perm) {
  const points = [];
  let frontier = -Infinity;
  for (const index of perm) {
    frontier = Math.max(ops[index].invoke, frontier);
    if (frontier > ops[index].respond) return null;
    points.push(frontier);
  }
  return points;
}

function assembleWitness(ops, perm, points, effects) {
  const order = [];
  const pointMap = {};
  const allocations = {};
  const audits = {};
  perm.forEach((opIndex, position) => {
    const op = ops[opIndex];
    order.push(op.id);
    pointMap[op.id] = points[position];
    if (op.op === 'capture' && op.response.ok) allocations[op.id] = effects[position].allocation;
    if (op.op === 'audit' && op.response.ok) audits[op.id] = effects[position].observed;
  });
  return { order, points: pointMap, allocations, audits };
}

// Brute-force enumeration of every witness for ops (<= 6 recommended).
export function bruteForceWitnesses(ops, { limit = Infinity } = {}) {
  const n = ops.length;
  const witnesses = [];
  const used = new Array(n).fill(false);
  const perm = [];

  function simulate(position, holds, points, effects) {
    if (witnesses.length >= limit) return;
    if (position === n) {
      witnesses.push(assembleWitness(ops, perm, points, effects));
      return;
    }
    const op = ops[perm[position]];
    const point = points[position];
    if (op.op === 'capture' && op.response.ok) {
      const hold = holds.get(op.holdId);
      const headroom = hold && hold.active ? Math.min(op.amount, hold.amount - hold.captured) : -1;
      for (let allocation = 0; allocation <= headroom; allocation += 1) {
        const result = replay(holds, op, point, allocation);
        if (!result) continue;
        effects.push(result.effect);
        simulate(position + 1, result.holds, points, effects);
        effects.pop();
      }
      return;
    }
    const result = replay(holds, op, point, undefined);
    if (!result) return;
    effects.push(result.effect);
    simulate(position + 1, result.holds, points, effects);
    effects.pop();
  }

  function generate() {
    if (witnesses.length >= limit) return;
    if (perm.length === n) {
      if (respectsRealTime(ops, perm)) {
        const points = greedyPoints(ops, perm);
        if (points) simulate(0, new Map(), points, []);
      }
      return;
    }
    for (let i = 0; i < n; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      perm.push(i);
      generate();
      perm.pop();
      used[i] = false;
    }
  }

  generate();
  return witnesses;
}

// Independent verification of a witness produced by any checker.
export function verifyWitness(ops, witness) {
  const byId = new Map(ops.map((op) => [op.id, op]));
  if (!witness || !Array.isArray(witness.order)) return false;
  if (witness.order.length !== ops.length) return false;
  if (new Set(witness.order).size !== ops.length) return false;
  for (const id of witness.order) if (!byId.has(id)) return false;

  const position = new Map(witness.order.map((id, index) => [id, index]));
  for (const a of ops) {
    for (const b of ops) {
      if (a !== b && a.respond <= b.invoke && position.get(a.id) >= position.get(b.id)) {
        return false;
      }
    }
  }

  let frontier = -Infinity;
  let holds = new Map();
  for (const id of witness.order) {
    const op = byId.get(id);
    const point = witness.points[id];
    if (!(point >= op.invoke && point <= op.respond)) return false;
    if (point < frontier) return false;
    frontier = point;
    const allocation = op.op === 'capture' && op.response.ok ? witness.allocations[id] : undefined;
    const result = replay(holds, op, point, allocation);
    if (!result) return false;
    if (op.op === 'audit' && op.response.ok) {
      const seen = witness.audits[id];
      const expected = result.effect.observed;
      if (
        !seen ||
        seen.frozen !== expected.frozen ||
        seen.captured !== expected.captured ||
        seen.available !== expected.available
      ) {
        return false;
      }
    }
    holds = result.holds;
  }
  return true;
}
