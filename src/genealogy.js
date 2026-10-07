'use strict';
const { ALPHABET } = require('./dfa');

// Error kinds mapped to CLI exit code 4: CYCLIC_GENEALOGY, UNKNOWN_PARENT,
// LAYER_HOLE. Everything else is a generic failure (exit 1).
class GenealogyError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'GenealogyError';
    this.kind = kind;
  }
}

function bad(message) {
  return new GenealogyError('BAD_RECORD', message);
}

// Validate and normalize one batch record.
// { batch, op?, parents?, defects?, status? }
// Roots (no parents) must not carry an op; non-roots must carry one of
// merge/split/test/ship. status "pending" marks an undecided test; pending
// states are kept as first-class states, never pruned as unsatisfiable.
function normalizeRecord(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw bad(`record #${index}: expected an object`);
  }
  const { batch } = raw;
  if (typeof batch !== 'string' || batch.length === 0) {
    throw bad(`record #${index}: "batch" must be a non-empty string`);
  }
  const parents = raw.parents === undefined ? [] : raw.parents;
  if (!Array.isArray(parents) || parents.some((p) => typeof p !== 'string' || !p)) {
    throw bad(`batch "${batch}": "parents" must be an array of batch names`);
  }
  const op = raw.op === undefined ? null : raw.op;
  if (parents.length === 0) {
    if (op !== null) throw bad(`batch "${batch}": root batch must not declare an op`);
  } else if (!ALPHABET.includes(op)) {
    throw bad(`batch "${batch}": op must be one of ${ALPHABET.join('/')}`);
  }
  const defects = raw.defects === undefined ? [] : raw.defects;
  if (!Array.isArray(defects) || defects.some((d) => typeof d !== 'string')) {
    throw bad(`batch "${batch}": "defects" must be an array of strings`);
  }
  const status = raw.status === undefined ? 'ok' : raw.status;
  if (status !== 'ok' && status !== 'pending') {
    throw bad(`batch "${batch}": status must be "ok" or "pending"`);
  }
  return {
    batch,
    op,
    parents: [...new Set(parents)],
    defects: [...new Set(defects)].sort(),
    status,
  };
}

// Build (or extend) the batch graph. Records may reference parents defined
// earlier in the same file or in previously imported layers.
// Throws GenealogyError kind UNKNOWN_PARENT / CYCLIC_GENEALOGY (exit code 4).
function buildGraph(rawRecords, existing = new Map()) {
  const records = rawRecords.map((r, i) => normalizeRecord(r, i));
  const graph = new Map(existing);
  for (const rec of records) {
    if (graph.has(rec.batch)) {
      throw new GenealogyError('DUPLICATE_BATCH', `duplicate batch "${rec.batch}"`);
    }
    graph.set(rec.batch, {
      id: rec.batch,
      op: rec.op,
      parents: rec.parents,
      defects: rec.defects,
      status: rec.status,
    });
  }
  for (const rec of records) {
    for (const parent of rec.parents) {
      if (!graph.has(parent)) {
        throw new GenealogyError(
          'UNKNOWN_PARENT',
          `batch "${rec.batch}" references unknown parent batch "${parent}"`
        );
      }
    }
  }
  const color = new Map(); // 0/absent = white, 1 = gray, 2 = black
  const visit = (id) => {
    const c = color.get(id) || 0;
    if (c === 1) {
      throw new GenealogyError('CYCLIC_GENEALOGY', `cyclic genealogy detected at batch "${id}"`);
    }
    if (c === 2) return;
    color.set(id, 1);
    for (const parent of graph.get(id).parents) visit(parent);
    color.set(id, 2);
  };
  for (const id of graph.keys()) visit(id);
  return graph;
}

// Graph -> NFA: states are batches, a node produced by op S from parents P
// contributes transitions p --S--> node for each p in P. Roots (no parents)
// form the start set. A split therefore yields several successors on one
// symbol; determinization resolves this via subset construction.
function toNFA(graph) {
  const trans = new Map();
  const output = new Map();
  const startIds = [];
  for (const node of graph.values()) {
    output.set(node.id, node.defects);
    if (!trans.has(node.id)) trans.set(node.id, new Map());
    if (node.parents.length === 0) startIds.push(node.id);
    if (node.op) {
      for (const parent of node.parents) {
        const bySym = trans.get(parent);
        if (!bySym.has(node.op)) bySym.set(node.op, new Set());
        bySym.get(node.op).add(node.id);
      }
    }
  }
  startIds.sort();
  return { startIds, trans, output };
}

module.exports = { GenealogyError, normalizeRecord, buildGraph, toNFA };
