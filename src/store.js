import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareVclock, dominates, mergeVclock } from './vclock.js';

export class StoreError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'StoreError';
    this.code = code;
  }
}

const LOG_FILE = 'events.log';
const META_FILE = 'meta.json';

const KINDS = new Set(['put', 'correct', 'delete']);

function logPath(dir) {
  return path.join(dir, LOG_FILE);
}

function metaPath(dir) {
  return path.join(dir, META_FILE);
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// Test-only crash-injection marker: touches <dir>/<point> so tests can
// synchronize a SIGKILL with an exact point in the append path.
function debugMark(point) {
  const dir = process.env.OBS_DEBUG_MARK_DIR;
  if (dir) {
    try {
      fs.writeFileSync(path.join(dir, point), '');
    } catch {
      /* ignore */
    }
  }
}

function writeFileAtomic(file, data) {
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

function defaultMeta(node, nodes) {
  return {
    node,
    nodes: [...new Set([node, ...(nodes || [])])],
    frontier: {},
    maxLamport: 0,
    knowledge: {},
    compacted: {},
  };
}

export function loadMeta(dir) {
  let raw;
  try {
    raw = fs.readFileSync(metaPath(dir), 'utf8');
  } catch {
    throw new StoreError('STORE_NOT_FOUND', `no store at ${dir} (run init first)`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoreError('STORE_CORRUPT', `meta file at ${dir} is not valid JSON`);
  }
}

export function saveMeta(dir, meta) {
  writeFileAtomic(metaPath(dir), JSON.stringify(meta, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// log: batches of "event" lines sealed by a "commit" line.
// Replay applies a batch only when its commit record is present and complete,
// so a crash before/during the append can never expose a partial batch.
// ---------------------------------------------------------------------------

export function readEvents(dir) {
  let text;
  try {
    text = fs.readFileSync(logPath(dir), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  const seenIds = new Set();
  const pending = new Map(); // batchId -> events[]
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      break; // torn tail: ignore everything from here on
    }
    if (rec && rec.type === 'event' && rec.event && typeof rec.batch === 'string') {
      if (!pending.has(rec.batch)) pending.set(rec.batch, []);
      pending.get(rec.batch).push(rec.event);
    } else if (rec && rec.type === 'commit' && typeof rec.batch === 'string') {
      const batch = pending.get(rec.batch);
      if (batch && batch.length === rec.count) {
        for (const e of batch) {
          if (!seenIds.has(e.id)) {
            seenIds.add(e.id);
            events.push(e);
          }
        }
      }
      pending.delete(rec.batch);
    }
  }
  return events;
}

function appendBatch(dir, events) {
  if (events.length === 0) return;
  const batchId = crypto.randomUUID();
  const lines = events.map((e) => JSON.stringify({ type: 'event', batch: batchId, event: e }));
  lines.push(JSON.stringify({ type: 'commit', batch: batchId, count: events.length }));
  const payload = lines.join('\n') + '\n';
  const fd = fs.openSync(logPath(dir), 'a');
  try {
    // Test-only fault-injection hooks (never set in production).
    debugMark('pre-write');
    sleepSync(Number(process.env.OBS_DEBUG_PRE_WRITE_DELAY_MS) || 0);
    const midDelay = Number(process.env.OBS_DEBUG_MID_WRITE_DELAY_MS) || 0;
    if (midDelay > 0 && lines.length > 1) {
      const cut = lines[0].length + 1; // first event line only, no commit yet
      fs.writeSync(fd, payload.slice(0, cut));
      debugMark('mid-write');
      sleepSync(midDelay);
      fs.writeSync(fd, payload.slice(cut));
    } else {
      fs.writeSync(fd, payload);
    }
    debugMark('pre-fsync');
    sleepSync(Number(process.env.OBS_DEBUG_PRE_FSYNC_DELAY_MS) || 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function rewriteLog(dir, events) {
  const batchId = crypto.randomUUID();
  const lines = events.map((e) => JSON.stringify({ type: 'event', batch: batchId, event: e }));
  lines.push(JSON.stringify({ type: 'commit', batch: batchId, count: events.length }));
  writeFileAtomic(logPath(dir), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// store lifecycle
// ---------------------------------------------------------------------------

export function initStore(dir, { node, nodes = [] } = {}) {
  if (!node || typeof node !== 'string') {
    throw new StoreError('INVALID_INPUT', 'init requires a --node name');
  }
  if (fs.existsSync(metaPath(dir))) {
    throw new StoreError('STORE_EXISTS', `store already initialized at ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const meta = defaultMeta(node, nodes);
  saveMeta(dir, meta);
  fs.writeFileSync(logPath(dir), '');
  return meta;
}

export function loadStore(dir) {
  const meta = loadMeta(dir);
  const events = readEvents(dir);
  return { meta, events };
}

function applyToMeta(meta, event) {
  meta.frontier = mergeVclock(meta.frontier, event.vclock);
  if (event.lamport > meta.maxLamport) meta.maxLamport = event.lamport;
  meta.knowledge[event.node] = mergeVclock(meta.knowledge[event.node] || {}, event.vclock);
  if (!meta.nodes.includes(event.node)) meta.nodes.push(event.node);
}

// ---------------------------------------------------------------------------
// visibility: per key, the winning event is the max under the deterministic
// total order (lamport, node, id). Physical clocks are never consulted.
// ---------------------------------------------------------------------------

export function compareRank(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function visibleState(events) {
  const byKey = new Map();
  for (const e of events) {
    const cur = byKey.get(e.key);
    if (!cur || compareRank(e, cur) > 0) byKey.set(e.key, e);
  }
  const records = {};
  const tombstones = [];
  for (const key of [...byKey.keys()].sort()) {
    const e = byKey.get(key);
    if (e.kind === 'delete') tombstones.push(e);
    else records[key] = e;
  }
  return { records, tombstones };
}

// ---------------------------------------------------------------------------
// local operations
// ---------------------------------------------------------------------------

function nextEvent(meta, { kind, key, value, node }) {
  const seq = (meta.frontier[node] || 0) + 1;
  const vclock = { ...meta.frontier, [node]: seq };
  const event = {
    id: `${node}:${seq}`,
    kind,
    key,
    node,
    seq,
    vclock,
    lamport: meta.maxLamport + 1,
  };
  if (kind === 'delete') event.ts = Date.now(); // retention bookkeeping only
  else event.value = value;
  return event;
}

function validateOp(op) {
  if (!op || typeof op !== 'object') {
    throw new StoreError('INVALID_INPUT', 'operation must be a JSON object');
  }
  if (!KINDS.has(op.kind)) {
    throw new StoreError('INVALID_INPUT', `unknown op kind: ${op.kind}`);
  }
  if (typeof op.key !== 'string' || op.key.length === 0) {
    throw new StoreError('INVALID_INPUT', 'op requires a non-empty "key" string');
  }
  if (op.kind !== 'delete' && !('value' in op)) {
    throw new StoreError('INVALID_INPUT', `op "${op.kind}" requires a "value" field`);
  }
  if (op.node !== undefined && (typeof op.node !== 'string' || !op.node)) {
    throw new StoreError('INVALID_INPUT', '"node" must be a non-empty string');
  }
}

// Apply a batch of local ops atomically: validated up front, appended as one
// log batch with a single commit record.
export function applyLocalOps(dir, ops) {
  const { meta, events } = loadStore(dir);
  const state = visibleState(events);
  const visible = new Map();
  for (const [key, e] of Object.entries(state.records)) visible.set(key, e);
  for (const t of state.tombstones) visible.set(t.key, t);

  const newEvents = [];
  for (const raw of ops) {
    const op = { ...raw };
    validateOp(op);
    const node = op.node || meta.node;
    const cur = visible.get(op.key);
    const isLive = cur && cur.kind !== 'delete';
    if (op.kind === 'put' && isLive) {
      throw new StoreError('KEY_EXISTS', `key "${op.key}" already exists; use correct`);
    }
    if ((op.kind === 'correct' || op.kind === 'delete') && !isLive) {
      throw new StoreError('KEY_NOT_FOUND', `key "${op.key}" is not present`);
    }
    const event = nextEvent(meta, { kind: op.kind, key: op.key, value: op.value, node });
    newEvents.push(event);
    applyToMeta(meta, event);
    visible.set(op.key, event);
  }
  appendBatch(dir, newEvents);
  saveMeta(dir, meta);
  return newEvents;
}

// ---------------------------------------------------------------------------
// merge: set-union of events. Commutative, associative, idempotent.
// ---------------------------------------------------------------------------

function validateEvent(e) {
  if (!e || typeof e !== 'object') {
    throw new StoreError('INVALID_INPUT', 'event must be a JSON object');
  }
  for (const field of ['id', 'kind', 'key', 'node', 'vclock']) {
    if (e[field] === undefined) {
      throw new StoreError('INVALID_INPUT', `event missing field "${field}"`);
    }
  }
  if (!KINDS.has(e.kind)) {
    throw new StoreError('INVALID_INPUT', `event has unknown kind "${e.kind}"`);
  }
  if (typeof e.seq !== 'number' || typeof e.lamport !== 'number') {
    throw new StoreError('INVALID_INPUT', 'event requires numeric "seq" and "lamport"');
  }
}

export function mergeEvents(dir, incoming, { sourceNode, sourceFrontier } = {}) {
  const { meta, events } = loadStore(dir);
  const known = new Set(events.map((e) => e.id));
  const fresh = [];
  const freshIds = new Set();
  let skipped = 0;
  for (const e of incoming) {
    validateEvent(e);
    if (known.has(e.id) || freshIds.has(e.id)) {
      skipped += 1;
      continue;
    }
    const frontier = meta.compacted[e.key];
    if (frontier && dominates(frontier, e.vclock)) {
      skipped += 1; // causally covered by a compacted tombstone: can never resurrect
      continue;
    }
    freshIds.add(e.id);
    fresh.push(e);
  }
  appendBatch(dir, fresh);
  for (const e of fresh) applyToMeta(meta, e);
  if (sourceNode && sourceFrontier) {
    meta.knowledge[sourceNode] = mergeVclock(meta.knowledge[sourceNode] || {}, sourceFrontier);
  }
  saveMeta(dir, meta);
  return { merged: fresh.length, skipped };
}

export function mergeFromStore(dir, otherDir) {
  const other = loadStore(otherDir);
  const sourceFrontier = other.events.reduce((acc, e) => mergeVclock(acc, e.vclock), {});
  return mergeEvents(dir, other.events, { sourceNode: other.meta.node, sourceFrontier });
}

// ---------------------------------------------------------------------------
// compaction: a tombstone may be dropped only once its retention period has
// elapsed AND every known node is known to have seen it. Events causally
// covered by the tombstone are dropped with it; the tombstone's vclock is
// recorded in meta.compacted so covered events can never be re-admitted.
// ---------------------------------------------------------------------------

export function compactStore(dir, { now = Date.now(), retentionMs = 0 } = {}) {
  const { meta, events } = loadStore(dir);
  const state = visibleState(events);
  const knownNodes = new Set([meta.node, ...meta.nodes, ...events.map((e) => e.node)]);

  const remove = new Set();
  const compactedKeys = [];
  for (const t of state.tombstones) {
    if (now - (t.ts || 0) < retentionMs) continue;
    let allSeen = true;
    for (const n of knownNodes) {
      const kv = meta.knowledge[n] || {};
      if ((kv[t.node] || 0) < t.seq) {
        allSeen = false;
        break;
      }
    }
    if (!allSeen) continue;
    for (const e of events) {
      if (e.key !== t.key) continue;
      if (e.id === t.id || dominates(t.vclock, e.vclock)) remove.add(e.id);
    }
    meta.compacted[t.key] = mergeVclock(meta.compacted[t.key] || {}, t.vclock);
    compactedKeys.push(t.key);
  }

  // Drop superseded versions of live keys (causally dominated by the winner).
  for (const [key, winner] of Object.entries(state.records)) {
    for (const e of events) {
      if (e.key === key && e.id !== winner.id && dominates(winner.vclock, e.vclock)) {
        remove.add(e.id);
      }
    }
  }

  if (remove.size > 0) {
    rewriteLog(dir, events.filter((e) => !remove.has(e.id)));
  }
  saveMeta(dir, meta);
  return { removed: remove.size, compactedKeys };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export function status(dir) {
  const { meta, events } = loadStore(dir);
  const { records, tombstones } = visibleState(events);
  const out = {};
  for (const [key, e] of Object.entries(records)) {
    out[key] = {
      key,
      value: e.value,
      kind: e.kind,
      node: e.node,
      lamport: e.lamport,
      vclock: e.vclock,
      id: e.id,
    };
  }
  return {
    ok: true,
    node: meta.node,
    nodes: [...meta.nodes].sort(),
    frontier: meta.frontier,
    lamport: meta.maxLamport,
    knowledge: meta.knowledge,
    compacted: meta.compacted,
    records: out,
    tombstones: tombstones.map((t) => ({
      key: t.key,
      id: t.id,
      node: t.node,
      lamport: t.lamport,
      vclock: t.vclock,
      ts: t.ts,
    })),
    eventCount: events.length,
  };
}

export { compareVclock };
