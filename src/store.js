import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { tarjanScc, kosarajuScc, componentsEqual } from './graph.js';

export const GENESIS_HASH = '0'.repeat(64);
export const LOG_FILE = 'append-audit.log';
export const CHECKPOINT_FILE = 'checkpoint.json';
export const SCC_CROSSCHECK_MAX_NODES = 7;

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function logPath(dir) {
  return path.join(dir, LOG_FILE);
}

export function checkpointPath(dir) {
  return path.join(dir, CHECKPOINT_FILE);
}

// ---------- state ----------

export function emptyState() {
  return { nodes: new Set(), edges: new Set(), appliedCount: 0 };
}

export function applyEvent(state, event) {
  if (event.op === 'add-edge') {
    state.nodes.add(event.from);
    state.nodes.add(event.to);
    state.edges.add(`${event.from}->${event.to}`);
  } else if (event.op === 'delete-edge') {
    state.edges.delete(`${event.from}->${event.to}`);
  } else {
    throw new Error(`unknown op: ${event.op}`);
  }
  state.appliedCount += 1;
  return state;
}

export function serializeState(state) {
  return {
    nodes: [...state.nodes].sort(),
    edges: [...state.edges].sort(),
    appliedCount: state.appliedCount,
  };
}

export function deserializeState(data) {
  return {
    nodes: new Set(data.nodes),
    edges: new Set(data.edges),
    appliedCount: data.appliedCount,
  };
}

export function stateRoot(state) {
  return sha256(JSON.stringify(serializeState(state)));
}

export function stateEdges(state) {
  return [...state.edges].map((e) => e.split('->'));
}

// ---------- event log (hash chain) ----------

export function canonicalEvent(event) {
  const obj = { seq: event.seq, op: event.op };
  if (event.from !== undefined) obj.from = event.from;
  if (event.to !== undefined) obj.to = event.to;
  return JSON.stringify(obj);
}

export function eventHash(prevHash, event) {
  return sha256(`${prevHash}\n${canonicalEvent(event)}`);
}

export function readLog(dir) {
  const file = logPath(dir);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const records = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new Error(`corrupt log: line ${records.length + 1} is not valid JSON`);
    }
    records.push(rec);
  }
  return records;
}

export function verifyChain(records) {
  let prevHash = GENESIS_HASH;
  records.forEach((rec, i) => {
    const seq = i + 1;
    if (rec.seq !== seq) {
      throw new Error(`hash chain broken: record ${seq} has seq=${rec.seq}`);
    }
    if (rec.prevHash !== prevHash) {
      throw new Error(`hash chain broken: record ${seq} has wrong prevHash`);
    }
    const expected = eventHash(prevHash, rec);
    if (rec.hash !== expected) {
      throw new Error(`hash chain broken: record ${seq} hash mismatch (log tampered?)`);
    }
    prevHash = rec.hash;
  });
  return prevHash;
}

// Append one event to the log and fsync. Returns the stored record.
export function appendEvent(dir, event) {
  fs.mkdirSync(dir, { recursive: true });
  const records = readLog(dir);
  const prevHash = records.length === 0 ? GENESIS_HASH : records[records.length - 1].hash;
  const rec = { ...event, seq: records.length + 1, prevHash };
  rec.hash = eventHash(prevHash, rec);
  const fd = fs.openSync(logPath(dir), 'a');
  try {
    fs.writeSync(fd, `${JSON.stringify(rec)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return rec;
}

// ---------- checkpoint ----------

export function loadCheckpoint(dir) {
  const file = checkpointPath(dir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Atomic checkpoint: write temp file, fsync, rename over the official file,
// then fsync the directory so the rename is durable.
export function writeCheckpoint(dir, state, lastSeq, lastHash) {
  fs.mkdirSync(dir, { recursive: true });
  const checkpoint = {
    version: 1,
    lastSeq,
    lastHash,
    state: serializeState(state),
    stateRoot: stateRoot(state),
  };
  const tmp = `${checkpointPath(dir)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(checkpoint, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, checkpointPath(dir));
  const dfd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
  return checkpoint;
}

// ---------- recovery ----------

// Load checkpoint, verify the full hash chain, then replay exactly the log
// records not covered by the checkpoint (seq > checkpoint.lastSeq).
// Events already inside the checkpoint are never re-executed.
export function recover(dir) {
  const records = readLog(dir);
  const tipHash = verifyChain(records);
  const checkpoint = loadCheckpoint(dir);

  let state;
  let baseSeq = 0;
  if (checkpoint) {
    if (records.length < checkpoint.lastSeq) {
      throw new Error(
        `checkpoint lastSeq=${checkpoint.lastSeq} but log has only ${records.length} records`,
      );
    }
    const covered = records[checkpoint.lastSeq - 1];
    if (checkpoint.lastSeq > 0 && covered.hash !== checkpoint.lastHash) {
      throw new Error('checkpoint lastHash does not match log record hash');
    }
    state = deserializeState(checkpoint.state);
    baseSeq = checkpoint.lastSeq;
  } else {
    state = emptyState();
  }

  for (const rec of records.slice(baseSeq)) {
    applyEvent(state, rec);
  }
  return { state, records, checkpoint, tipHash };
}

// ---------- commit ----------

// Commit protocol: append event (+prevHash) to the log and fsync FIRST,
// then write the checkpoint. crashMode simulates a crash at each stage:
//   'before-checkpoint' -> exit after the log append, before checkpoint write
//   'after-checkpoint'  -> exit after the temp checkpoint replaced the official file
export function commit(dir, event, crashMode = null) {
  const { state } = recover(dir);
  const rec = appendEvent(dir, event);
  if (crashMode === 'before-checkpoint') {
    return { crashed: true, stage: crashMode, record: rec };
  }
  applyEvent(state, event);
  const checkpoint = writeCheckpoint(dir, state, rec.seq, rec.hash);
  if (crashMode === 'after-checkpoint') {
    return { crashed: true, stage: crashMode, record: rec };
  }
  return { crashed: false, record: rec, checkpoint };
}

// ---------- verification ----------

export function verify(dir) {
  const records = readLog(dir);
  const tipHash = verifyChain(records);
  const checkpoint = loadCheckpoint(dir);

  if (checkpoint) {
    if (records.length < checkpoint.lastSeq) {
      throw new Error(
        `checkpoint lastSeq=${checkpoint.lastSeq} but log has only ${records.length} records`,
      );
    }
    if (checkpoint.lastSeq > 0) {
      const covered = records[checkpoint.lastSeq - 1];
      if (covered.hash !== checkpoint.lastHash) {
        throw new Error('checkpoint lastHash does not match log record hash');
      }
    }
    // Replay exactly the covered prefix from genesis and compare state roots.
    const prefixState = emptyState();
    for (const rec of records.slice(0, checkpoint.lastSeq)) {
      applyEvent(prefixState, rec);
    }
    if (stateRoot(prefixState) !== checkpoint.stateRoot) {
      throw new Error('checkpoint stateRoot does not match replayed log prefix');
    }
    if (checkpoint.state.appliedCount !== checkpoint.lastSeq) {
      throw new Error('checkpoint appliedCount does not match lastSeq (event executed twice?)');
    }
  }

  // Current state root: replay the whole log from genesis.
  const fullState = emptyState();
  for (const rec of records) applyEvent(fullState, rec);
  if (fullState.appliedCount !== records.length) {
    throw new Error('appliedCount does not match log length (event executed twice?)');
  }
  const currentStateRoot = stateRoot(fullState);

  // SCC cross-check with an independent algorithm on small graphs.
  const nodes = [...fullState.nodes];
  const edges = stateEdges(fullState);
  const components = tarjanScc(nodes, edges);
  if (nodes.length <= SCC_CROSSCHECK_MAX_NODES) {
    const independent = kosarajuScc(nodes, edges);
    if (!componentsEqual(components, independent)) {
      throw new Error('SCC cross-check failed: Tarjan and Kosaraju disagree');
    }
  }

  return {
    ok: true,
    events: records.length,
    tipHash,
    checkpointedSeq: checkpoint ? checkpoint.lastSeq : 0,
    stateRoot: currentStateRoot,
    components,
  };
}
