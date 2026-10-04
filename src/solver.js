// Backtracking solver over the finite ordinal domain (positions 0..n-1).
//
// Hard precedence (vector clocks + time windows) is propagated by the engine;
// concurrent branches that the clocks cannot decide are explored by
// backtracking. The per-device state machine (safety rules) prunes branches.
//
// Result:
//   { status: 'sat', order, positions, unique, nodes }
//   { status: 'infeasible', conflict: { events, rules, description }, nodes }
//   { status: 'unknown', pending, nodes }          (budget exhausted)

import { PrecedenceEngine } from './engine.js';
import { MACHINE, checkTransition } from './rules.js';

function cycleConflict(engine, cycle) {
  const events = cycle.slice(0, -1);
  const rules = new Set();
  for (let i = 0; i < cycle.length - 1; i++) {
    const edge = engine.edgeBetween(cycle[i], cycle[i + 1]);
    if (edge) for (const rule of edge.rules) rules.add(rule);
  }
  return {
    events,
    rules: [...rules].sort(),
    description: `cyclic precedence: ${cycle.join(' -> ')}`,
  };
}

function search(events, engine, budget) {
  const placed = [];
  const placedSet = new Set();
  const deviceState = new Map();
  const lastOnDevice = new Map();
  const solutions = [];
  const failures = [];
  const pending = new Set();
  let nodes = 0;
  let exhausted = false;

  function candidates() {
    const out = [];
    for (const e of events) {
      if (placedSet.has(e.id)) continue;
      let blocked = false;
      for (const f of events) {
        if (f.id === e.id || placedSet.has(f.id)) continue;
        if (engine.reaches(f.id, e.id)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) out.push(e);
    }
    return out;
  }

  function rec() {
    if (exhausted || solutions.length >= 2) return;
    if (placed.length === events.length) {
      solutions.push(placed.map((e) => e.id));
      return;
    }
    if (nodes >= budget) {
      exhausted = true;
      for (const e of events) {
        if (!placedSet.has(e.id)) pending.add(e.id);
      }
      return;
    }
    nodes++;
    for (const e of candidates()) {
      const state = deviceState.get(e.device) ?? MACHINE.initial;
      const chk = checkTransition(state, e.type);
      if (!chk.ok) {
        failures.push({
          depth: placed.length,
          event: e.id,
          type: e.type,
          device: e.device,
          state,
          need: chk.need,
          rule: chk.rule,
          after: lastOnDevice.get(e.device) ?? null,
        });
        continue;
      }
      const prevState = deviceState.get(e.device);
      const prevLast = lastOnDevice.get(e.device);
      placed.push(e);
      placedSet.add(e.id);
      deviceState.set(e.device, chk.to);
      lastOnDevice.set(e.device, e.id);
      rec();
      if (prevState === undefined) deviceState.delete(e.device);
      else deviceState.set(e.device, prevState);
      if (prevLast === undefined) lastOnDevice.delete(e.device);
      else lastOnDevice.set(e.device, prevLast);
      placedSet.delete(e.id);
      placed.pop();
      if (exhausted || solutions.length >= 2) return;
    }
  }

  rec();
  return { solutions, failures, pending, exhausted, nodes };
}

export function solve(store, { budget = 100000, maxSkewMs = 30000 } = {}) {
  const engine = new PrecedenceEngine({ maxSkewMs });
  for (const event of store.list()) engine.addEvent(event);

  // Propagation-phase conflict: never masked by the search budget.
  const cycle = engine.findCycle();
  if (cycle) {
    return { status: 'infeasible', conflict: cycleConflict(engine, cycle), nodes: 0 };
  }

  const events = store.list();
  const result = search(events, engine, budget);

  if (result.exhausted) {
    return {
      status: 'unknown',
      pending: [...result.pending].sort(),
      nodes: result.nodes,
    };
  }
  if (result.solutions.length === 0) {
    const failure = result.failures.reduce(
      (best, f) => (best === null || f.depth > best.depth ? f : best),
      null,
    );
    const conflict = failure
      ? {
          events: [failure.after, failure.event].filter(Boolean),
          rules: [failure.rule],
          description:
            `device ${failure.device}: event ${failure.event} (${failure.type}) ` +
            `requires state ${failure.need.join('|')} but device is ${failure.state}` +
            (failure.after ? ` after ${failure.after}` : ''),
        }
      : { events: [], rules: [], description: 'no valid linearization' };
    return { status: 'infeasible', conflict, nodes: result.nodes };
  }
  const order = result.solutions[0];
  return {
    status: 'sat',
    order,
    positions: Object.fromEntries(order.map((id, i) => [id, i])),
    unique: result.solutions.length === 1,
    nodes: result.nodes,
  };
}
