import fs from 'node:fs';
import path from 'node:path';
import {
  ERR,
  UndoError,
  assertAcyclic,
  buildForest,
  buildPositionalIndex,
  findNearHits,
  planUndo,
  subtreeIds,
} from './core.js';

const NODES_FILE = 'nodes.json';
const BATCHES_DIR = 'batches';
const BATCH_RE = /^(\d{6})\.json$/;

function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

const seqName = (seq) => String(seq).padStart(6, '0');

export function initStore(dir, nodes) {
  buildForest(nodes);
  fs.mkdirSync(path.join(dir, BATCHES_DIR), { recursive: true });
  writeFileAtomic(path.join(dir, NODES_FILE), JSON.stringify({ nodes }, null, 2));
  return { ok: true, nodes: nodes.length };
}

// A batch counts only when its commit marker exists; a batch file left
// without a marker (crash between rename and marker) is ignored on restart.
export function listCommittedBatches(dir) {
  const batchesDir = path.join(dir, BATCHES_DIR);
  if (!fs.existsSync(batchesDir)) return [];
  const seqs = [];
  for (const name of fs.readdirSync(batchesDir)) {
    const m = BATCH_RE.exec(name);
    if (m && fs.existsSync(path.join(batchesDir, `${m[1]}.commit`))) {
      seqs.push(Number(m[1]));
    }
  }
  return seqs.sort((a, b) => a - b);
}

export function loadStore(dir) {
  const { nodes } = JSON.parse(fs.readFileSync(path.join(dir, NODES_FILE), 'utf8'));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const batches = [];
  const batchesDir = path.join(dir, BATCHES_DIR);
  for (const seq of listCommittedBatches(dir)) {
    const batch = JSON.parse(
      fs.readFileSync(path.join(batchesDir, `${seqName(seq)}.json`), 'utf8'),
    );
    batches.push(batch);
    for (const entry of batch.certificate.entries) {
      const node = byId.get(entry.nodeId);
      if (node) node.state = 'undone';
    }
  }
  return { nodes, batches };
}

export function query(dir, { rootId, phrase, slop = 0 }) {
  const { nodes } = loadStore(dir);
  const { byId, childrenOf } = buildForest(nodes);
  if (!byId.has(rootId)) {
    throw new UndoError(ERR.ROOT_NOT_FOUND, `root node not found: ${rootId}`);
  }
  assertAcyclic(byId);
  const scope = subtreeIds(childrenOf, rootId);
  const index = buildPositionalIndex(nodes);
  return findNearHits(index, scope, phrase, slop);
}

// Returns { ok: true, batchId, certificate } or { ok: false, error: { code, message } }.
// Domain failures never touch the state files.
export function undo(dir, opts) {
  let plan;
  try {
    const { nodes } = loadStore(dir);
    plan = planUndo(nodes, opts);
  } catch (err) {
    if (err instanceof UndoError) {
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    throw err;
  }
  const committed = listCommittedBatches(dir);
  const seq = committed.length > 0 ? committed[committed.length - 1] + 1 : 1;
  const batchId = `BATCH-${seqName(seq)}`;
  const certificate = {
    batchId,
    createdAt: new Date().toISOString(),
    rootId: plan.rootId,
    phrase: plan.phrase,
    slop: plan.slop,
    budget: plan.budget,
    totalAmount: plan.totalAmount,
    entries: plan.entries,
  };
  const batchesDir = path.join(dir, BATCHES_DIR);
  fs.mkdirSync(batchesDir, { recursive: true });
  const name = seqName(seq);
  writeFileAtomic(
    path.join(batchesDir, `${name}.json`),
    JSON.stringify({ batchId, certificate }, null, 2),
  );
  writeFileAtomic(path.join(batchesDir, `${name}.commit`), `${batchId}\n`);
  return { ok: true, batchId, certificate };
}
