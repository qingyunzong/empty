export class CycleError extends Error {
  constructor(cycle) {
    super(`graph contains a cycle: ${cycle.join(' -> ')}`);
    this.name = 'CycleError';
    this.cycle = cycle;
  }
}

export class FreezeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FreezeError';
  }
}

export const HOLD_TYPES = new Set(['supplier', 'customer']);

export function createState() {
  return {
    loaded: false,
    lots: new Set(),
    edges: [],
    parentsOf: new Map(),
    childrenOf: new Map(),
    holds: new Map(),
    history: [],
  };
}

function assertLoaded(state) {
  if (!state || !state.loaded) {
    throw new FreezeError('no graph loaded');
  }
}

function normalizeGraph(graph) {
  if (!graph || typeof graph !== 'object') {
    throw new FreezeError('graph must be an object with lots and edges');
  }
  const lots = new Set();
  for (const lot of graph.lots ?? []) {
    if (typeof lot !== 'string' || lot === '') {
      throw new FreezeError('every lot must be a non-empty string');
    }
    lots.add(lot);
  }
  const edges = [];
  for (const edge of graph.edges ?? []) {
    if (!edge || typeof edge.child !== 'string' || typeof edge.parent !== 'string') {
      throw new FreezeError('every edge must have string child and parent');
    }
    lots.add(edge.child);
    lots.add(edge.parent);
    edges.push({ child: edge.child, parent: edge.parent });
  }
  return { lots: [...lots], edges };
}

function buildAdjacency(lots, edges) {
  const parentsOf = new Map();
  const childrenOf = new Map();
  for (const lot of lots) {
    parentsOf.set(lot, new Set());
    childrenOf.set(lot, new Set());
  }
  for (const { child, parent } of edges) {
    parentsOf.get(child).add(parent);
    childrenOf.get(parent).add(child);
  }
  return { parentsOf, childrenOf };
}

function findCycle(lots, parentsOf) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const lot of lots) color.set(lot, WHITE);
  const parentInPath = new Map();
  for (const root of lots) {
    if (color.get(root) !== WHITE) continue;
    const stack = [root];
    color.set(root, GRAY);
    parentInPath.set(root, null);
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      let advanced = false;
      for (const next of parentsOf.get(node) ?? []) {
        const nextColor = color.get(next);
        if (nextColor === WHITE) {
          color.set(next, GRAY);
          parentInPath.set(next, node);
          stack.push(next);
          advanced = true;
          break;
        }
        if (nextColor === GRAY) {
          const cycle = [next];
          let current = node;
          while (current !== next) {
            cycle.push(current);
            current = parentInPath.get(current);
          }
          cycle.push(next);
          cycle.reverse();
          return cycle;
        }
      }
      if (!advanced) {
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

export function loadGraph(state, graph) {
  const { lots, edges } = normalizeGraph(graph);
  const { parentsOf, childrenOf } = buildAdjacency(lots, edges);
  const cycle = findCycle(lots, parentsOf);
  if (cycle) {
    throw new CycleError(cycle);
  }
  state.loaded = true;
  state.lots = new Set(lots);
  state.edges = edges;
  state.parentsOf = parentsOf;
  state.childrenOf = childrenOf;
  return state;
}

function normalizeHold(hold) {
  if (!hold || typeof hold !== 'object') {
    throw new FreezeError('hold must be an object');
  }
  const { id, lot, type, severity } = hold;
  if (typeof id !== 'string' || id === '') {
    throw new FreezeError('hold id must be a non-empty string');
  }
  if (typeof lot !== 'string' || lot === '') {
    throw new FreezeError('hold lot must be a non-empty string');
  }
  if (!HOLD_TYPES.has(type)) {
    throw new FreezeError(`hold type must be supplier or customer, got: ${type}`);
  }
  if (severity !== null && (typeof severity !== 'number' || !Number.isFinite(severity))) {
    throw new FreezeError('hold severity must be a finite number or null');
  }
  return { id, lot, type, severity };
}

export function addHold(state, hold) {
  assertLoaded(state);
  const normalized = normalizeHold(hold);
  if (!state.lots.has(normalized.lot)) {
    throw new FreezeError(`unknown lot: ${normalized.lot}`);
  }
  if (state.holds.has(normalized.id)) {
    throw new FreezeError(`duplicate hold id: ${normalized.id}`);
  }
  state.holds.set(normalized.id, normalized);
  state.history.push({ op: 'hold', hold: normalized });
  return normalized;
}

export function releaseHold(state, id) {
  assertLoaded(state);
  const hold = state.holds.get(id);
  if (!hold) {
    throw new FreezeError(`unknown hold id: ${id}`);
  }
  state.holds.delete(id);
  state.history.push({ op: 'release', hold });
  return hold;
}

export function undo(state) {
  assertLoaded(state);
  const entry = state.history.pop();
  if (!entry) return null;
  if (entry.op === 'hold') {
    state.holds.delete(entry.hold.id);
  } else if (entry.op === 'release') {
    state.holds.set(entry.hold.id, entry.hold);
  }
  return entry;
}

export function reachableFrom(start, adjacency) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

export function computeClosure(state) {
  assertLoaded(state);
  const closure = new Map();
  for (const hold of state.holds.values()) {
    const adjacency = hold.type === 'supplier' ? state.childrenOf : state.parentsOf;
    for (const lot of reachableFrom(hold.lot, adjacency)) {
      let entry = closure.get(lot);
      if (!entry) {
        entry = { maxSeverity: null, hasUnknown: false, reasons: [] };
        closure.set(lot, entry);
      }
      entry.reasons.push(hold.id);
      if (hold.severity === null) {
        entry.hasUnknown = true;
      } else {
        entry.maxSeverity =
          entry.maxSeverity === null ? hold.severity : Math.max(entry.maxSeverity, hold.severity);
      }
    }
  }
  const result = new Map();
  for (const [lot, entry] of closure) {
    entry.reasons.sort();
    result.set(lot, {
      severity: entry.hasUnknown ? null : entry.maxSeverity,
      reasons: entry.reasons,
    });
  }
  return result;
}

export function queryLot(state, lot) {
  assertLoaded(state);
  if (!state.lots.has(lot)) {
    throw new FreezeError(`unknown lot: ${lot}`);
  }
  const entry = computeClosure(state).get(lot);
  if (!entry) {
    return { lot, frozen: false, severity: null, reasons: [] };
  }
  return { lot, frozen: true, severity: entry.severity, reasons: entry.reasons };
}

export function serializeState(state) {
  assertLoaded(state);
  return JSON.stringify(
    {
      lots: [...state.lots],
      edges: state.edges,
      holds: [...state.holds.values()],
      history: state.history,
    },
    null,
    2,
  );
}

export function deserializeState(json) {
  const data = JSON.parse(json);
  const state = createState();
  loadGraph(state, { lots: data.lots, edges: data.edges });
  for (const hold of data.holds ?? []) {
    state.holds.set(hold.id, normalizeHold(hold));
  }
  state.history = (data.history ?? []).map((entry) => ({
    op: entry.op,
    hold: normalizeHold(entry.hold),
  }));
  return state;
}
