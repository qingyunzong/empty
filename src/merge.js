import { parseHistory, InvalidHistory, DATA_OPS } from './parse.js';
import { Budget, buildGraph, kahn, minimalCycle, ancestorsOf } from './graph.js';
import { foldOrder } from './serialize.js';

export const EXIT_CODES = {
  CONCURRENT_OK: 0,
  LINEARIZABLE_MODEL: 0,
  CONFLICT: 6,
  PENDING: 4,
  INVALID_HISTORY: 2,
};

// undo_op may only retract an unsynced data op on the same device.
function applyUndos(ops, synced) {
  const byId = new Map(ops.map((o) => [o.id, o]));
  const removed = new Set();
  const errors = [];
  for (const u of ops) {
    if (u.op !== 'undo_op') continue;
    const t = byId.get(u.target);
    const fail = (message) => errors.push({ op: u.id, message });
    if (!t) fail(`undo target ${u.target} not found`);
    else if (t.device !== u.device) fail(`undo target ${t.id} belongs to device ${t.device}`);
    else if (!(t.time < u.time)) fail(`undo target ${t.id} does not precede the undo`);
    else if (!DATA_OPS.has(t.op)) fail(`undo target ${t.id} of type ${t.op} cannot be undone`);
    else if (synced.has(t.id)) fail(`undo target ${t.id} is already synced`);
    else if (removed.has(t.id)) fail(`undo target ${t.id} already undone`);
    else {
      removed.add(t.id);
      removed.add(u.id);
    }
  }
  if (errors.length) throw new InvalidHistory(errors);
  return removed;
}

function checkConstraints(matrix, config) {
  if (!config) return [];
  const violations = [];
  for (const [plot, cells] of Object.entries(matrix)) {
    const pl = config.plots?.[plot];
    for (const species of Object.keys(cells)) {
      const sp = config.species?.[species];
      if (sp && Array.isArray(pl?.morphs) && !pl.morphs.includes(sp.morph))
        violations.push({ type: 'INCOMPATIBLE_MORPH', plot, species, morph: sp.morph });
    }
    if (pl && config.capacityPerArea != null && config.tierWeights) {
      const load = Object.values(cells).reduce((sum, tier) => sum + (config.tierWeights[tier] ?? 0), 0);
      const capacity = pl.area * config.capacityPerArea;
      if (load > capacity) violations.push({ type: 'CAPACITY_EXCEEDED', plot, load, capacity });
    }
  }
  return violations;
}

export function mergeHistories(inputs, config = null, { budget = 1_000_000 } = {}) {
  const histories = inputs.map((input, i) =>
    parseHistory(input.text, { source: input.name ?? `history${i + 1}`, config }),
  );
  let ops = histories.flatMap((h) => h.ops);

  // Preliminary graph (possibly cyclic): used only to decide which ops were
  // already committed by a matched sync, which constrains undo_op.
  let graph = buildGraph(ops);
  const matchedSyncs = graph.syncPairs.flat();
  const ancAll = ancestorsOf(graph.nodes, graph.adj);
  const synced = new Set();
  for (const s of matchedSyncs) {
    synced.add(s.id);
    for (const a of ancAll.get(s.id)) synced.add(a);
  }
  const removed = applyUndos(ops, synced);
  if (removed.size) {
    ops = ops.filter((o) => !removed.has(o.id));
    graph = buildGraph(ops);
  }

  const budgetObj = new Budget(budget);
  const k = kahn(graph.nodes, graph.adj, budgetObj);
  if (k.pending) return { verdict: 'PENDING', reason: 'BUDGET_EXHAUSTED' };
  if (k.remaining) {
    const cyc = minimalCycle(graph.adj, k.remaining, budgetObj);
    if (cyc.pending) return { verdict: 'PENDING', reason: 'BUDGET_EXHAUSTED' };
    return { verdict: 'CONFLICT', reason: 'CAUSAL_CYCLE', cycle: cyc.cycle, graph };
  }

  const order = k.order;
  const byId = graph.byId;
  const anc = ancestorsOf(graph.nodes, graph.adj);
  const concurrent = (a, b) => a !== b && !anc.get(a).has(b) && !anc.get(b).has(a);

  // A fact is frozen for a rename m when it was committed by a matched sync
  // that happens-before m; morph/move must not rewrite such synced facts.
  const syncIds = matchedSyncs.map((s) => s.id);
  const frozenCache = new Map();
  const frozenOf = (m) => {
    if (!frozenCache.has(m.id)) {
      const frozen = new Set();
      for (const sid of syncIds) {
        if (sid !== m.id && anc.get(m.id).has(sid)) {
          frozen.add(sid);
          for (const a of anc.get(sid)) frozen.add(a);
        }
      }
      frozenCache.set(m.id, frozen);
    }
    return frozenCache.get(m.id);
  };

  const inOrder = order.map((id) => byId.get(id));
  const morphs = inOrder.filter((o) => o.op === 'morph_species');
  const moves = inOrder.filter((o) => o.op === 'move_plot');

  // Global renames propagate to every history (any HB order, any device),
  // skipping only facts frozen by an earlier sync.
  const effective = new Map();
  for (const o of ops) {
    if (o.op !== 'set_count') continue;
    let species = o.species;
    let plot = o.plot;
    for (const m of morphs) if (m.from === species && !frozenOf(m).has(o.id)) species = m.to;
    for (const mv of moves) if (mv.from === plot && !frozenOf(mv).has(o.id)) plot = mv.to;
    effective.set(o.id, {
      plot,
      species,
      rawKey: `${o.plot}::${o.species}`,
      effKey: `${plot}::${species}`,
    });
  }

  const conflicts = [];
  const checkRenames = (renames, kind) => {
    for (let i = 0; i < renames.length; i++) {
      for (let j = i + 1; j < renames.length; j++) {
        const a = renames[i];
        const b = renames[j];
        if (!concurrent(a.id, b.id)) continue;
        if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to)
          conflicts.push({ type: 'RENAME_CONFLICT', kind, ops: [a.id, b.id] });
      }
    }
  };
  checkRenames(morphs, 'species');
  checkRenames(moves, 'plot');

  // Per effective cell, only the maximal writers matter (last-writer-wins).
  // Concurrent maxima must agree and must come from one raw cell, otherwise
  // the merge is ambiguous or breaks total-count conservation.
  const groups = new Map();
  for (const o of ops) {
    if (o.op !== 'set_count') continue;
    const eff = effective.get(o.id);
    if (!groups.has(eff.effKey)) groups.set(eff.effKey, []);
    groups.get(eff.effKey).push(o);
  }
  for (const [cell, group] of groups) {
    const maximal = group.filter((o) => !group.some((p) => p.id !== o.id && anc.get(p.id).has(o.id)));
    for (let i = 0; i < maximal.length; i++) {
      for (let j = i + 1; j < maximal.length; j++) {
        const x = maximal[i];
        const y = maximal[j];
        const ex = effective.get(x.id);
        const ey = effective.get(y.id);
        if (ex.rawKey !== ey.rawKey) {
          conflicts.push({ type: 'CONSERVATION_VIOLATION', cell, ops: [x.id, y.id] });
        } else if (x.tier !== y.tier) {
          conflicts.push({ type: 'WRITE_CONFLICT', cell, ops: [x.id, y.id], tiers: [x.tier, y.tier] });
        }
      }
    }
  }
  if (conflicts.length)
    return { verdict: 'CONFLICT', reason: conflicts[0].type, conflicts, graph, order, effective };

  const matrix = foldOrder(inOrder, effective);
  const violations = checkConstraints(matrix, config);
  if (violations.length)
    return { verdict: 'CONFLICT', reason: violations[0].type, violations, matrix, graph, order, effective };

  return {
    verdict: k.unique ? 'LINEARIZABLE_MODEL' : 'CONCURRENT_OK',
    matrix,
    linearization: order,
    graph,
    order,
    effective,
  };
}
