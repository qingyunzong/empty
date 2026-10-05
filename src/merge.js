import { InvalidHistory, ConflictError, Budget } from './errors.js';
import { validateConfig, parseHistories, unwindUndos, pairSyncs } from './history.js';
import { buildGraph, transitiveClosure, findMinCycle, topoSort } from './graph.js';

// ---------------------------------------------------------------------------
// State application
// ---------------------------------------------------------------------------

export function emptyMatrix(domain) {
  const m = new Map();
  for (const p of domain.plots.keys()) {
    const row = new Map();
    for (const s of domain.species.keys()) row.set(s, 0);
    m.set(p, row);
  }
  return m;
}

export function matrixToObject(matrix) {
  const out = {};
  for (const [plot, row] of matrix) {
    out[plot] = {};
    for (const [sp, tier] of row) out[plot][sp] = tier;
  }
  return out;
}

// Resolve a species reference for op `op` through all morph renames that
// happen-before it. morphOrder must be a happens-before-respecting sequence
// of all morph ops (topological, deterministic tie-break).
function resolveSpecies(name, op, morphs, hbBefore) {
  let cur = name;
  // iterate: morph chains can compose (S1->S2 then S2->S3)
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of morphs) {
      if (m.from === cur && hbBefore(m.id, op.id)) {
        cur = m.to;
        changed = true;
      }
    }
  }
  return cur;
}

// Apply effective ops in the given order (must respect happens-before).
// hbBefore(aId, bId): strict happens-before. Throws ConflictError on
// constraint violation inside the merged model.
export function applyOrder(order, opsById, domain, morphs, hbBefore, ctx = 'merge') {
  const matrix = emptyMatrix(domain);
  const writer = new Map(); // plot -> Map(species -> opId)
  for (const p of domain.plots.keys()) writer.set(p, new Map());
  const syncs = [...opsById.values()].filter((o) => o.op === 'sync');

  const fail = (msg, detail) => {
    if (ctx === 'validate') throw new InvalidHistory(`${ctx}: ${msg}`);
    throw new ConflictError(`${ctx}: ${msg}`, detail);
  };

  const capacityCheck = (plot, opId) => {
    let sum = 0;
    for (const v of matrix.get(plot).values()) sum += v;
    if (sum > domain.plots.get(plot)) {
      fail(`plot ${plot} over capacity: load ${sum} exceeds area ${domain.plots.get(plot)} at op ${opId}`, {
        reason: 'capacity', plot, op: opId,
      });
    }
  };

  for (const id of order) {
    const op = opsById.get(id);
    switch (op.op) {
      case 'sync':
        break;
      case 'set_count': {
        const sp = resolveSpecies(op.species, op, morphs, hbBefore);
        matrix.get(op.plot).set(sp, op.tier);
        writer.get(op.plot).set(sp, op.id);
        capacityCheck(op.plot, op.id);
        break;
      }
      case 'move_plot': {
        const from = resolveSpecies(op.from, op, morphs, hbBefore);
        const to = resolveSpecies(op.to, op, morphs, hbBefore);
        const row = matrix.get(op.plot);
        const avail = row.get(from);
        if (avail < op.count) {
          fail(`move_plot ${op.id}: cannot move ${op.count} from ${from} (only ${avail}) in plot ${op.plot}`, {
            reason: 'conservation', op: op.id,
          });
        }
        row.set(from, avail - op.count);
        row.set(to, row.get(to) + op.count);
        writer.get(op.plot).set(from, op.id);
        writer.get(op.plot).set(to, op.id);
        capacityCheck(op.plot, op.id);
        break;
      }
      case 'morph_species': {
        // Global rename: propagates to every history, but facts that were
        // already synced before this morph keep the old name.
        for (const [plot, row] of matrix) {
          const tier = row.get(op.from);
          if (tier === 0 && !writer.get(plot).has(op.from)) continue;
          const w = writer.get(plot).get(op.from);
          const synced = w !== undefined && syncs.some(
            (s) => s.device === opsById.get(w).device && hbBefore(w, s.id) && hbBefore(s.id, op.id)
          );
          if (synced) continue; // do not rewrite synced facts
          const merged = Math.max(tier, row.get(op.to));
          row.set(op.to, merged);
          row.set(op.from, 0);
          writer.get(plot).delete(op.from);
          writer.get(plot).set(op.to, op.id);
        }
        break;
      }
      default:
        fail(`op ${op.id}: unexpected op type ${op.op} in effective history`, { reason: 'internal' });
    }
  }
  return matrix;
}

// ---------------------------------------------------------------------------
// Merge verdict
// ---------------------------------------------------------------------------

function speciesRefs(op) {
  switch (op.op) {
    case 'set_count': return [op.species];
    case 'move_plot': return [op.from, op.to];
    case 'morph_species': return [op.from, op.to];
    default: return [];
  }
}

const WRITE_OPS = new Set(['set_count', 'move_plot', 'morph_species']);

// Do two concurrent write ops interfere (order-dependent outcome)?
function interferes(a, b) {
  if (a.op === 'set_count' && b.op === 'set_count') {
    return a.plot === b.plot && a.species === b.species && a.tier !== b.tier;
  }
  if (a.op === 'morph_species' || b.op === 'morph_species') {
    const m = a.op === 'morph_species' ? a : b;
    const other = m === a ? b : a;
    if (other.op === 'morph_species') {
      return m.from === other.from || m.from === other.to || m.to === other.from || m.to === other.to;
    }
    return speciesRefs(other).includes(m.from) || speciesRefs(other).includes(m.to);
  }
  // move_plot involved: order-dependent within the same plot
  return a.plot === b.plot;
}

export function mergeHistories(config, inputs, options = {}) {
  const domain = validateConfig(config);
  const budget = new Budget(options.budget ?? 1_000_000);

  const rawByDevice = parseHistories(inputs, domain);
  const effByDevice = unwindUndos(rawByDevice);
  const syncPairs = pairSyncs(effByDevice);

  const ops = [];
  for (const chain of effByDevice.values()) ops.push(...chain);
  const opsById = new Map(ops.map((o) => [o.id, o]));

  // Per-device sequential validation (each device alone, in device order).
  const morphsAll = ops.filter((o) => o.op === 'morph_species');
  for (const chain of effByDevice.values()) {
    const localHb = new Map();
    for (let i = 0; i < chain.length; i++) {
      const seen = new Set();
      for (let j = 0; j < i; j++) seen.add(chain[j].id);
      localHb.set(chain[i].id, seen);
    }
    const hb = (a, b) => localHb.get(b)?.has(a) ?? false;
    const localMorphs = chain.filter((o) => o.op === 'morph_species');
    applyOrder(chain.map((o) => o.id), opsById, domain, localMorphs, hb, 'validate');
  }

  // Happens-before graph over effective ops.
  const adj = buildGraph(ops, syncPairs);

  // Causal cycle detection (budgeted).
  const cycle = findMinCycle(adj, budget);
  if (cycle) {
    throw new ConflictError(`causal cycle of length ${cycle.length}: ${cycle.join(' -> ')} -> ${cycle[0]}`, {
      reason: 'causal_cycle',
      cycle,
    });
  }

  const reach = transitiveClosure(adj, budget);
  const hbBefore = (a, b) => reach.get(a)?.has(b) ?? false;

  // Deterministic topological order for the merged model.
  const order = topoSort(adj, budget);

  // Concurrent write analysis.
  const writes = ops.filter((o) => WRITE_OPS.has(o.op));
  let hasConcurrentWrites = false;
  for (let i = 0; i < writes.length; i++) {
    for (let j = i + 1; j < writes.length; j++) {
      const a = writes[i];
      const b = writes[j];
      budget.step();
      if (hbBefore(a.id, b.id) || hbBefore(b.id, a.id)) continue;
      hasConcurrentWrites = true;
      if (interferes(a, b)) {
        throw new ConflictError(
          `concurrent interfering writes: ${a.id} (${a.op}) vs ${b.id} (${b.op})`, {
            reason: 'concurrent_writes',
            pair: [a.id, b.id],
          }
        );
      }
    }
  }

  // Apply merged model; constraint violations here mean no legal merged order.
  const matrix = applyOrder(order, opsById, domain, morphsAll, hbBefore, 'merge');

  return {
    verdict: hasConcurrentWrites ? 'CONCURRENT_OK' : 'LINEARIZABLE_MODEL',
    matrix: matrixToObject(matrix),
    topoOrder: order,
    budgetSteps: budget.steps,
  };
}
