// Journal verification: budget hard constraint, aisle exclusion, causal
// order, compensation integrity, and resolvable pending conditions.

import { evaluateRelease } from './journal.js';

function intervals(state) {
  // Concrete occupied intervals: completed executions, in-flight executions
  // (open-ended), and compensation moves (executed by construction).
  const out = [];
  for (const exec of state.executions) {
    const move = state.moveById.get(exec.move);
    if (!move) continue;
    out.push({ move: exec.move, aisles: move.aisles, shuttle: move.shuttle, start: exec.start, end: exec.end });
  }
  for (const move of state.moves) {
    if (move.kind === 'compensation') {
      out.push({ move: move.id, aisles: move.aisles, shuttle: move.shuttle, start: move.start, end: move.end });
    }
  }
  return out;
}

function checkBudget(state) {
  const violations = [];
  for (const wave of state.waves) {
    if (!Number.isFinite(wave.budget)) {
      violations.push({ wave: wave.id, reason: 'missing budget' });
      continue;
    }
    const perShuttle = new Map();
    for (const move of state.moves) {
      if (move.wave !== wave.id) continue;
      if (move.kind !== 'task' && move.kind !== 'reposition') continue;
      perShuttle.set(move.shuttle, (perShuttle.get(move.shuttle) ?? 0) + move.energy);
    }
    for (const [shuttle, energy] of perShuttle) {
      if (energy > wave.budget) {
        violations.push({ wave: wave.id, shuttle, energy, budget: wave.budget });
      }
    }
  }
  return { name: 'budget', ok: violations.length === 0, violations };
}

function checkAisleExclusion(state) {
  const violations = [];
  const byAisle = new Map();
  for (const iv of intervals(state)) {
    for (const aisle of iv.aisles) {
      if (!byAisle.has(aisle)) byAisle.set(aisle, []);
      byAisle.get(aisle).push(iv);
    }
  }
  for (const [aisle, list] of byAisle) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        const aEnd = a.end === null ? Infinity : a.end;
        const bEnd = b.end === null ? Infinity : b.end;
        if (a.start < bEnd && b.start < aEnd) {
          violations.push({
            aisle, moves: [a.move, b.move],
            reason: a.end === null || b.end === null
              ? 'overlap with in-flight move cannot be proven safe'
              : 'overlapping occupancy',
          });
        }
      }
    }
  }
  return { name: 'aisle-exclusion', ok: violations.length === 0, violations };
}

function checkCausalOrder(state) {
  const violations = [];
  const byShuttle = new Map();
  for (const iv of intervals(state)) {
    if (!byShuttle.has(iv.shuttle)) byShuttle.set(iv.shuttle, []);
    byShuttle.get(iv.shuttle).push(iv);
  }
  for (const [shuttle, list] of byShuttle) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].end === null ? Infinity : sorted[i - 1].end;
      if (sorted[i].start < prevEnd) {
        violations.push({ shuttle, moves: [sorted[i - 1].move, sorted[i].move], reason: 'shuttle double-booked' });
      }
    }
  }
  // Executed moves must respect the planned causal sequence per shuttle.
  const plannedOrder = new Map();
  for (const move of state.moves) {
    if (move.kind === 'compensation') continue;
    if (!plannedOrder.has(move.shuttle)) plannedOrder.set(move.shuttle, []);
    plannedOrder.get(move.shuttle).push(move.id);
  }
  for (const [shuttle, planned] of plannedOrder) {
    const rank = new Map(planned.map((id, idx) => [id, idx]));
    const executed = state.executions
      .filter((e) => rank.has(e.move))
      .map((e) => rank.get(e.move));
    for (let i = 1; i < executed.length; i++) {
      if (executed[i] < executed[i - 1]) {
        violations.push({ shuttle, reason: 'execution violated planned causal order' });
        break;
      }
    }
  }
  return { name: 'causal-order', ok: violations.length === 0, violations };
}

function checkCompensation(state) {
  const violations = [];
  const compensations = state.moves.filter((m) => m.kind === 'compensation');
  const byTarget = new Map();
  for (const c of compensations) {
    byTarget.set(c.compensates, (byTarget.get(c.compensates) ?? 0) + 1);
    const original = state.moveById.get(c.compensates);
    if (!original) {
      violations.push({ compensation: c.id, reason: 'compensates unknown move' });
    } else if (!state.execByMove.has(original.id)) {
      violations.push({ compensation: c.id, reason: `compensated move ${original.id} was never executed` });
    }
  }
  for (const move of state.moves) {
    if (move.status === 'compensated' && byTarget.get(move.id) !== 1) {
      violations.push({ move: move.id, reason: 'compensated move lacks exactly one compensation' });
    }
  }
  // A rolled-back wave must be fully cascaded: every one of its moves is
  // either compensated (was executed) or reusable (never started).
  for (const wave of state.waves) {
    if (wave.status !== 'rolled-back') continue;
    for (const move of state.moves) {
      if (move.wave !== wave.id || move.kind === 'compensation') continue;
      if (move.status !== 'compensated' && move.status !== 'reusable') {
        violations.push({ wave: wave.id, move: move.id, reason: 'wave rollback did not cascade to this move' });
      }
    }
  }
  return { name: 'compensation-integrity', ok: violations.length === 0, violations };
}

function checkPending(state, releases) {
  const violations = [];
  const pending = releases.filter((r) => r.status === 'pending');
  const edges = new Map();
  for (const rel of pending) {
    if (rel.blockedBy.length === 0) {
      violations.push({ move: rel.move, reason: 'pending without an unblock condition' });
      continue;
    }
    for (const cond of rel.blockedBy) {
      const blocker = state.moveById.get(cond.move);
      if (!blocker) {
        violations.push({ move: rel.move, reason: `unblock condition references unknown move ${cond.move}` });
        continue;
      }
      if (cond.reason === 'aisle-occupied') {
        // Blocking on an aisle is only legitimate against a concrete
        // in-flight occupant; unknown aisle state must never block.
        const exec = state.execByMove.get(cond.move);
        if (!exec || exec.end !== null || !blocker.aisles.includes(cond.aisle)) {
          violations.push({ move: rel.move, aisle: cond.aisle, reason: 'blocked on an aisle without an in-flight occupant' });
        }
      }
      if (!edges.has(rel.move)) edges.set(rel.move, []);
      edges.get(rel.move).push(cond.move);
    }
  }
  // Unblock conditions must be resolvable: no dependency cycles.
  const stateOf = new Map();
  const visit = (node, stack) => {
    if (stateOf.get(node) === 'done') return;
    if (stateOf.get(node) === 'visiting') {
      violations.push({ move: node, reason: `cyclic unblock conditions: ${[...stack, node].join(' -> ')}` });
      return;
    }
    stateOf.set(node, 'visiting');
    for (const next of edges.get(node) ?? []) visit(next, [...stack, node]);
    stateOf.set(node, 'done');
  };
  for (const node of edges.keys()) visit(node, []);
  return { name: 'pending-conditions', ok: violations.length === 0, violations };
}

export function verifyJournal(state) {
  const releases = evaluateRelease(state);
  const checks = [
    { name: 'hierarchy', ok: state.errors.length === 0, violations: state.errors.slice() },
    checkBudget(state),
    checkAisleExclusion(state),
    checkCausalOrder(state),
    checkCompensation(state),
    checkPending(state, releases),
  ];
  const ok = checks.every((c) => c.ok);
  return { ok, checks, releases };
}
