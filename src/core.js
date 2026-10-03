export class UndoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UndoError';
    this.code = code;
  }
}

export const ERR = Object.freeze({
  ROOT_NOT_FOUND: 'ROOT_NOT_FOUND',
  CYCLE_DETECTED: 'CYCLE_DETECTED',
  ALREADY_UNDONE: 'ALREADY_UNDONE',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  INVALID_PHRASE: 'INVALID_PHRASE',
  INVALID_INPUT: 'INVALID_INPUT',
});

export function tokenize(reason) {
  return String(reason ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((tok) => tok.length > 0);
}

export function normalizePhrase(phrase) {
  let terms = phrase;
  if (typeof terms === 'string') {
    terms = terms.trim().split(/\s+/).filter(Boolean);
  }
  if (
    !Array.isArray(terms) ||
    terms.length !== 2 ||
    terms.some((t) => typeof t !== 'string' || t.length === 0)
  ) {
    throw new UndoError(ERR.INVALID_PHRASE, 'phrase must be a pair of two non-empty terms');
  }
  return terms.map((t) => t.toLowerCase());
}

// Ordered near match: a pair (pa, pb) matches when pb > pa and the number of
// tokens between them (pb - pa - 1) is <= slop. slop=0 means strictly adjacent.
export function matchOrderedPairs(positionsA, positionsB, slop) {
  const pairs = [];
  for (const pa of positionsA) {
    for (const pb of positionsB) {
      if (pb > pa && pb - pa - 1 <= slop) pairs.push([pa, pb]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return pairs;
}

// Reference implementation: enumerate every ordered window in a reason string.
export function enumerateOrderedWindows(reason, phrase, slop) {
  const [termA, termB] = normalizePhrase(phrase);
  const posA = [];
  const posB = [];
  tokenize(reason).forEach((tok, idx) => {
    if (tok === termA) posA.push(idx);
    if (tok === termB) posB.push(idx);
  });
  return matchOrderedPairs(posA, posB, slop);
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function buildPositionalIndex(nodes) {
  const byTerm = new Map();
  const byNode = new Map();
  for (const node of nodes) {
    let termMap = byNode.get(node.id);
    if (!termMap) {
      termMap = new Map();
      byNode.set(node.id, termMap);
    }
    tokenize(node.reason).forEach((term, pos) => {
      let arr = termMap.get(term);
      if (!arr) {
        arr = [];
        termMap.set(term, arr);
      }
      arr.push(pos);
    });
  }
  for (const [nodeId, termMap] of byNode) {
    for (const [term, positions] of termMap) {
      let list = byTerm.get(term);
      if (!list) {
        list = [];
        byTerm.set(term, list);
      }
      list.push({ nodeId, positions });
    }
  }
  for (const list of byTerm.values()) list.sort((x, y) => cmpStr(x.nodeId, y.nodeId));
  return { byTerm, byNode };
}

// Index-backed ordered near query restricted to a set of node ids.
// Hits are returned sorted by node id (lexicographic).
export function findNearHits(index, scopeIds, phrase, slop) {
  const [termA, termB] = normalizePhrase(phrase);
  const scope = scopeIds instanceof Set ? scopeIds : new Set(scopeIds);
  const candidates = new Set();
  for (const term of [termA, termB]) {
    for (const entry of index.byTerm.get(term) ?? []) {
      if (scope.has(entry.nodeId)) candidates.add(entry.nodeId);
    }
  }
  const hits = [];
  for (const nodeId of candidates) {
    const termMap = index.byNode.get(nodeId);
    const pairs = matchOrderedPairs(termMap.get(termA) ?? [], termMap.get(termB) ?? [], slop);
    if (pairs.length > 0) hits.push({ nodeId, positions: pairs });
  }
  hits.sort((a, b) => cmpStr(a.nodeId, b.nodeId));
  return hits;
}

export function buildForest(nodes) {
  const byId = new Map();
  const childrenOf = new Map();
  for (const node of nodes) {
    if (node == null || typeof node.id !== 'string' || node.id.length === 0) {
      throw new UndoError(ERR.INVALID_INPUT, 'every node needs a non-empty string id');
    }
    if (byId.has(node.id)) {
      throw new UndoError(ERR.INVALID_INPUT, `duplicate node id: ${node.id}`);
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    if (node.parentId != null && byId.has(node.parentId)) {
      let kids = childrenOf.get(node.parentId);
      if (!kids) {
        kids = [];
        childrenOf.set(node.parentId, kids);
      }
      kids.push(node.id);
    }
  }
  for (const kids of childrenOf.values()) kids.sort(cmpStr);
  return { byId, childrenOf };
}

export function assertAcyclic(byId) {
  for (const id of byId.keys()) {
    const seen = new Set();
    let cur = id;
    while (cur != null && byId.has(cur)) {
      if (seen.has(cur)) {
        throw new UndoError(ERR.CYCLE_DETECTED, `parent chain cycle detected at node ${cur}`);
      }
      seen.add(cur);
      cur = byId.get(cur).parentId;
    }
  }
}

export function subtreeIds(childrenOf, rootId) {
  const out = new Set();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const kid of childrenOf.get(id) ?? []) stack.push(kid);
  }
  return out;
}

export function computeLevels(byId) {
  const levels = new Map();
  const visiting = new Set();
  const levelOf = (id) => {
    if (levels.has(id)) return levels.get(id);
    if (visiting.has(id)) {
      throw new UndoError(ERR.CYCLE_DETECTED, `parent chain cycle detected at node ${id}`);
    }
    visiting.add(id);
    const node = byId.get(id);
    let lvl = 0;
    if (node.parentId != null && byId.has(node.parentId)) lvl = levelOf(node.parentId) + 1;
    visiting.delete(id);
    levels.set(id, lvl);
    return lvl;
  };
  for (const id of byId.keys()) levelOf(id);
  return levels;
}

// Pure undo planner. Throws UndoError on any validation failure; on success
// returns a deterministic plan (entries ordered by hit id, then descendants
// in lexicographic id order).
export function planUndo(nodes, { rootId, phrase, slop = 0, budget }) {
  if (!Array.isArray(nodes)) {
    throw new UndoError(ERR.INVALID_INPUT, 'nodes must be an array');
  }
  const normalizedPhrase = normalizePhrase(phrase);
  if (!Number.isInteger(slop) || slop < 0) {
    throw new UndoError(ERR.INVALID_INPUT, 'slop must be a non-negative integer');
  }
  if (typeof budget !== 'number' || Number.isNaN(budget) || budget < 0) {
    throw new UndoError(ERR.INVALID_INPUT, 'budget must be a non-negative number');
  }
  const { byId, childrenOf } = buildForest(nodes);
  if (!byId.has(rootId)) {
    throw new UndoError(ERR.ROOT_NOT_FOUND, `root node not found: ${rootId}`);
  }
  assertAcyclic(byId);
  const levels = computeLevels(byId);
  const scope = subtreeIds(childrenOf, rootId);
  const index = buildPositionalIndex(nodes);
  const hits = findNearHits(index, scope, normalizedPhrase, slop);
  const hitPositions = new Map(hits.map((h) => [h.nodeId, h.positions]));

  const entries = [];
  const emitted = new Set();
  const emit = (id) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const direct = hitPositions.has(id);
    entries.push({
      nodeId: id,
      level: levels.get(id),
      amount: byId.get(id).amount,
      positions: direct ? hitPositions.get(id) : [],
      direct,
    });
  };
  for (const hit of hits) {
    emit(hit.nodeId);
    const descendants = [...subtreeIds(childrenOf, hit.nodeId)].sort(cmpStr);
    for (const id of descendants) emit(id);
  }

  for (const entry of entries) {
    if (byId.get(entry.nodeId).state === 'undone') {
      throw new UndoError(ERR.ALREADY_UNDONE, `node already undone: ${entry.nodeId}`);
    }
  }
  const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);
  if (totalAmount > budget) {
    throw new UndoError(
      ERR.BUDGET_EXCEEDED,
      `undo total ${totalAmount} exceeds budget ${budget}`,
    );
  }
  return { rootId, phrase: normalizedPhrase, slop, budget, totalAmount, entries };
}
