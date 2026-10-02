import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compareClocks, mergeClock, dominates, isConcurrent } from './clock.js';

export class StoreError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = 'StoreError';
    this.code = code;
  }
}

export const CONFIG_FILE = 'config.json';
export const LOG_FILE = 'log.jsonl';

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// Total order over versions, consistent with causality and free of physical
// clocks: (lamport, origin, value, deleted). Lamport timestamps respect
// happens-before, so a causally-later version always sorts higher; concurrent
// versions are ordered deterministically by origin node id, never by wall time.
export function compareVersions(a, b) {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  const sa = stableStringify(a.value);
  const sb = stableStringify(b.value);
  if (sa !== sb) return sa < sb ? -1 : 1;
  return (a.deleted ? 1 : 0) - (b.deleted ? 1 : 0);
}

export function eventId(v) {
  return `${v.origin}:${v.clock[v.origin] || 0}`;
}

export function currentVersion(rec) {
  let best = null;
  for (const v of rec.versions.values()) {
    if (!best || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

export function initStore(dir, { node, nodes = [], retention = 0 } = {}) {
  if (typeof node !== 'string' || node.length === 0) {
    throw new StoreError('USAGE', 'init requires --node <id>');
  }
  if (!Number.isInteger(retention) || retention < 0) {
    throw new StoreError('USAGE', 'retention must be a non-negative integer (lamport ticks)');
  }
  if (fs.existsSync(path.join(dir, CONFIG_FILE))) {
    throw new StoreError('STORE_EXISTS', `store already initialized at ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const config = { node, nodes: [...new Set([node, ...nodes])].sort(), retention };
  fs.writeFileSync(path.join(dir, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, LOG_FILE), '');
  return config;
}

export function loadStore(dir) {
  const configPath = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    throw new StoreError('NO_STORE', `no store at ${dir} (run init first)`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const state = {
    dir,
    config,
    records: new Map(), // key -> { key, versions: Map(eventId -> version) }
    frontier: {}, // element-wise max of every version clock ever applied
    seenBy: {}, // node -> latest clock we can prove that node has observed
    lamport: 0,
  };
  const logPath = path.join(dir, LOG_FILE);
  if (fs.existsSync(logPath)) {
    const raw = fs.readFileSync(logPath, 'utf8');
    const lines = raw.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const pending = new Map();
    for (const line of lines) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // truncated tail left by a crash between write and fsync
      }
      if (rec.type === 'prepare') {
        pending.set(rec.id, rec.events);
      } else if (rec.type === 'commit') {
        const events = pending.get(rec.id);
        if (events) {
          for (const ev of events) applyEvent(state, ev);
          pending.delete(rec.id);
        }
      }
    }
    // A prepare without a commit is never applied: a batch is atomic.
  }
  return state;
}

function applyVersion(state, key, v) {
  let rec = state.records.get(key);
  if (!rec) {
    rec = { key, versions: new Map() };
    state.records.set(key, rec);
  }
  rec.versions.set(eventId(v), v);
  state.frontier = mergeClock(state.frontier, v.clock);
  state.lamport = Math.max(state.lamport, v.lamport);
}

export function applyEvent(state, ev) {
  switch (ev.op) {
    case 'put':
    case 'correct':
    case 'delete':
      applyVersion(state, ev.key, ev.version);
      break;
    case 'merge':
      for (const v of ev.record.history) applyVersion(state, ev.record.key, v);
      break;
    case 'seen':
      state.seenBy[ev.node] = mergeClock(state.seenBy[ev.node] || {}, ev.clock);
      state.lamport = Math.max(state.lamport, ev.lamport || 0);
      break;
    case 'nodes':
      state.config.nodes = [...new Set([...state.config.nodes, ...ev.nodes])].sort();
      break;
    case 'gc':
      state.records.delete(ev.key);
      break;
    default:
      throw new StoreError('BAD_INPUT', `unknown op "${ev.op}"`);
  }
  state.seenBy[state.config.node] = { ...state.frontier };
}

export function createEvent(state, op, key, value) {
  const node = state.config.node;
  state.frontier[node] = (state.frontier[node] || 0) + 1;
  state.lamport += 1;
  const version = {
    value: op === 'delete' ? null : value,
    deleted: op === 'delete',
    clock: { ...state.frontier },
    lamport: state.lamport,
    origin: node,
  };
  return { op, key, version };
}

// Validate inputs against current state and build (tentatively applied) events.
// Validation is all-or-nothing: any bad line aborts the whole batch.
export function buildEvents(state, op, inputs) {
  const events = [];
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || typeof input.key !== 'string' || input.key.length === 0) {
      throw new StoreError('BAD_INPUT', 'each line must be a JSON object with a non-empty string "key"');
    }
    const { key, value } = input;
    if ((op === 'put' || op === 'correct') && !('value' in input)) {
      throw new StoreError('BAD_INPUT', `"${op}" requires a "value" field`);
    }
    const rec = state.records.get(key);
    const cur = rec ? currentVersion(rec) : null;
    if (op === 'put' && cur && !cur.deleted) {
      throw new StoreError('EXISTS', `key "${key}" already exists; use correct`);
    }
    if (op === 'correct' && !cur) throw new StoreError('NOT_FOUND', `key "${key}" not found`);
    if (op === 'correct' && cur.deleted) throw new StoreError('DELETED', `key "${key}" is deleted`);
    if (op === 'delete' && !cur) throw new StoreError('NOT_FOUND', `key "${key}" not found`);
    if (op === 'delete' && cur.deleted) throw new StoreError('ALREADY_DELETED', `key "${key}" is already deleted`);
    const ev = createEvent(state, op, key, value);
    events.push(ev);
    applyEvent(state, ev); // tentative; made durable by appendBatch
  }
  return events;
}

// Fault-injection hook for crash testing. All log writes above are
// synchronous, so exiting the process here is equivalent to a SIGKILL at
// this exact point: no further writes or fsyncs can happen.
function fault(point) {
  if (process.env.OBS_FAULT === point) process.exit(137);
}

// Write-ahead batch commit: prepare line + fsync, commit line + fsync.
// A crash anywhere leaves either a committed batch (fully visible) or an
// uncommitted prepare (ignored on replay): never a partial batch.
export function appendBatch(dir, events) {
  if (!events || events.length === 0) return null;
  const id = randomUUID();
  const fd = fs.openSync(path.join(dir, LOG_FILE), 'a');
  try {
    fs.writeSync(fd, JSON.stringify({ type: 'prepare', id, events }) + '\n');
    fault('before-prepare-fsync');
    fs.fsyncSync(fd);
    fault('before-commit-write');
    fs.writeSync(fd, JSON.stringify({ type: 'commit', id }) + '\n');
    fault('before-commit-fsync');
    fs.fsyncSync(fd);
    fault('after-commit-fsync');
  } finally {
    fs.closeSync(fd);
  }
  return id;
}

function persistConfig(state) {
  const tmp = path.join(state.dir, CONFIG_FILE + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify(state.config, null, 2) + '\n');
  fs.renameSync(tmp, path.join(state.dir, CONFIG_FILE));
}

// A tombstone may be compacted only when (a) every known node is proven to
// have seen the delete (its seenBy clock dominates the tombstone clock) and
// (b) the configured retention (in lamport ticks) has elapsed.
export function gcReady(state) {
  const retention = state.config.retention || 0;
  const ready = [];
  for (const rec of state.records.values()) {
    const cur = currentVersion(rec);
    if (!cur.deleted) continue;
    if (state.lamport - cur.lamport < retention) continue;
    const seenByAll = state.config.nodes.every((n) => dominates(state.seenBy[n] || {}, cur.clock));
    if (seenByAll) ready.push(rec.key);
  }
  return ready;
}

// Merge a dump (lines as produced by status --dump) into the local store.
// Merge is a join on a semilattice (max under compareVersions per key, set
// union of versions), hence commutative, associative and idempotent.
export function mergeLines(state, lines) {
  const events = [];
  const results = [];
  let nodesChanged = false;
  const apply = (ev) => {
    events.push(ev);
    applyEvent(state, ev);
  };
  for (const line of lines) {
    if (line && line.type === 'meta') {
      if (typeof line.node === 'string') {
        apply({ op: 'seen', node: line.node, clock: line.frontier || {}, lamport: line.lamport || 0 });
        const extra = (line.nodes || []).filter((n) => !state.config.nodes.includes(n));
        if (extra.length) {
          apply({ op: 'nodes', nodes: extra });
          nodesChanged = true;
        }
      }
    } else if (line && line.type === 'record' && line.record) {
      const rec = line.record;
      if (typeof rec.key !== 'string' || !Array.isArray(rec.history)) {
        throw new StoreError('BAD_INPUT', 'record lines must look like {type:"record", record:{key, history:[...]}}');
      }
      const existing = state.records.get(rec.key);
      const localBest = existing ? currentVersion(existing) : null;
      const incomingBest = rec.history.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
      let outcome;
      let concurrent = false;
      if (!localBest) {
        outcome = 'added';
      } else {
        const cmp = compareVersions(incomingBest, localBest);
        if (cmp > 0) {
          outcome = 'updated';
        } else if (cmp === 0) {
          outcome = 'kept';
        } else {
          outcome = 'superseded';
        }
        if (cmp !== 0) concurrent = isConcurrent(incomingBest.clock, localBest.clock);
      }
      apply({ op: 'merge', record: { key: rec.key, history: rec.history } });
      results.push({ ok: true, key: rec.key, outcome, concurrent });
    } else {
      throw new StoreError('BAD_INPUT', 'merge expects {type:"meta",...} or {type:"record",...} lines (see status --dump)');
    }
  }
  for (const key of gcReady(state)) apply({ op: 'gc', key });
  if (events.length) {
    appendBatch(state.dir, events);
    if (nodesChanged) persistConfig(state);
  }
  return results;
}

export function dumpLines(state) {
  const lines = [{
    type: 'meta',
    node: state.config.node,
    nodes: state.config.nodes,
    frontier: state.frontier,
    lamport: state.lamport,
  }];
  for (const rec of state.records.values()) {
    const history = [...rec.versions.values()].sort(compareVersions);
    const cur = history[history.length - 1];
    lines.push({
      type: 'record',
      record: {
        key: rec.key,
        value: cur.value,
        deleted: cur.deleted,
        clock: cur.clock,
        lamport: cur.lamport,
        origin: cur.origin,
        history,
      },
    });
  }
  return lines;
}

export function statusSummary(state) {
  let live = 0;
  let tombstones = 0;
  for (const rec of state.records.values()) {
    if (currentVersion(rec).deleted) tombstones += 1;
    else live += 1;
  }
  return {
    node: state.config.node,
    nodes: state.config.nodes,
    retention: state.config.retention,
    records: live,
    tombstones,
    lamport: state.lamport,
    frontier: state.frontier,
    seenBy: state.seenBy,
  };
}

export function recordDetail(state, key) {
  const rec = state.records.get(key);
  if (!rec) return null;
  const history = [...rec.versions.values()].sort(compareVersions);
  const cur = history[history.length - 1];
  const concurrentPairs = [];
  for (let i = 0; i < history.length; i++) {
    for (let j = i + 1; j < history.length; j++) {
      if (isConcurrent(history[i].clock, history[j].clock)) concurrentPairs.push([i, j]);
    }
  }
  return {
    key,
    value: cur.value,
    deleted: cur.deleted,
    clock: cur.clock,
    lamport: cur.lamport,
    origin: cur.origin,
    history,
    concurrentPairs,
  };
}

// Visible state: non-deleted current values only. Used by tests to prove that
// compaction never changes what is visible.
export function visibleState(state) {
  const out = {};
  for (const rec of state.records.values()) {
    const cur = currentVersion(rec);
    if (!cur.deleted) out[rec.key] = cur.value;
  }
  return out;
}
