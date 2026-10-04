import fs from 'node:fs';
import path from 'node:path';
import { SyncError } from './errors.js';
import { tick, merge as mergeVector } from './version.js';

// Fault injection points (env PARAM_SYNC_FAULT_AT or Store option faultAt):
//   before-delta-append   crash before the delta batch hits the log
//   after-delta-append    crash after append, before active.json is rewritten
//   before-active-rename  crash after tmp write, before atomic rename
//   after-safe-commit     crash after safe-set manifest commit, before enforcement
export const FAULT_POINTS = [
  'before-delta-append',
  'after-delta-append',
  'before-active-rename',
  'after-safe-commit',
];

const ROLLBACK_ORDER = ['unlocked', 'params-reverted', 'certs-cleared'];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export class Store {
  constructor(dir, registry, opts = {}) {
    this.dir = dir;
    this.registry = registry;
    this.node = opts.node ?? 'node';
    this.faultAt = opts.faultAt ?? process.env.PARAM_SYNC_FAULT_AT ?? null;
    fs.mkdirSync(dir, { recursive: true });
    this.state = {
      values: {},
      locks: {},
      certs: {},
      vector: {},
      safeSet: null,
      rollbackPhase: 'none',
    };
    this.seq = 0;
  }

  _fault(point) {
    if (this.faultAt === point) {
      throw new SyncError('CRASH', `simulated crash at ${point}`, { point });
    }
  }

  get activeFile() { return path.join(this.dir, 'active.json'); }
  get deltaFile() { return path.join(this.dir, 'delta.log'); }
  get safeFile() { return path.join(this.dir, 'safe-set.json'); }

  // ---------- change capture ----------

  set(key, value) {
    const def = this.registry.get(key);
    if (!def) throw new SyncError('VALIDATION', `unknown param: ${key}`);
    if (this.state.locks[key]) {
      throw new SyncError('VALIDATION', `param locked: ${key}`);
    }
    this.registry.validateValue(key, value);
    const values = { ...this.state.values, [key]: value };
    this.registry.validateState(values);
    return this._commit([{ op: 'set', key, value }]);
  }

  lock(key) {
    if (!this.registry.get(key)) throw new SyncError('VALIDATION', `unknown param: ${key}`);
    return this._commit([{ op: 'lock', key }]);
  }

  unlock(key) {
    if (!this.registry.get(key)) throw new SyncError('VALIDATION', `unknown param: ${key}`);
    return this._commit([{ op: 'unlock', key }]);
  }

  issueCert(key, cert) {
    if (!this.registry.get(key)) throw new SyncError('VALIDATION', `unknown param: ${key}`);
    return this._commit([{ op: 'cert', key, value: cert }]);
  }

  // Apply a batch of entries atomically: fully validated first, then one
  // delta record, then one active.json swap. Never half-applied.
  applyEntries(entries, { validate = true } = {}) {
    if (validate) {
      const preview = this._project(entries);
      this.registry.validateState(preview.values);
    }
    return this._commit(entries);
  }

  _project(entries) {
    const values = { ...this.state.values };
    const locks = { ...this.state.locks };
    for (const e of entries) {
      if (e.op === 'set') {
        this.registry.validateValue(e.key, e.value);
        if (locks[e.key]) throw new SyncError('VALIDATION', `param locked: ${e.key}`);
        values[e.key] = e.value;
      } else if (e.op === 'lock') locks[e.key] = true;
      else if (e.op === 'unlock') delete locks[e.key];
    }
    return { values, locks };
  }

  _commit(entries) {
    const seq = this.seq + 1;
    let vector = this.state.vector;
    const stamped = entries.map((e) => {
      // Foreign entries keep their original vector so causality survives
      // the pack -> apply -> feedback round trip; local ops get stamped.
      if (e.vector && e.node) {
        vector = mergeVector(vector, e.vector);
        return e;
      }
      vector = tick(vector, this.node);
      return { ...e, node: this.node, vector };
    });
    const record = { seq, entries: stamped };

    this._fault('before-delta-append');
    fs.appendFileSync(this.deltaFile, JSON.stringify(record) + '\n');
    this._fault('after-delta-append');

    const next = {
      values: { ...this.state.values },
      locks: { ...this.state.locks },
      certs: { ...this.state.certs },
      vector,
      safeSet: this.state.safeSet,
      rollbackPhase: this.state.rollbackPhase,
      seq,
    };
    for (const e of stamped) {
      if (e.op === 'set') next.values[e.key] = e.value;
      else if (e.op === 'lock') next.locks[e.key] = true;
      else if (e.op === 'unlock') delete next.locks[e.key];
      else if (e.op === 'cert') next.certs[e.key] = e.value;
      else if (e.op === 'clear-certs') next.certs = {};
      else if (e.op === 'rollback-phase') next.rollbackPhase = e.value;
    }
    this._writeActive(next);
    this.state = next;
    this.seq = seq;
    return stamped;
  }

  _writeActive(state) {
    const tmp = this.activeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    this._fault('before-active-rename');
    fs.renameSync(tmp, this.activeFile);
  }

  // ---------- safe set ----------

  commitSafeSet(manifest) {
    for (const [key, value] of Object.entries(manifest.values ?? {})) {
      this.registry.validateValue(key, value);
    }
    const tmp = this.safeFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, this.safeFile);
    this.state.safeSet = manifest;
    this._fault('after-safe-commit');
    this._enforceSafeSet();
  }

  // Dangerous values (out of range / type / violated interlock) on
  // safety-critical keys are overridden by the safe set.
  _enforceSafeSet() {
    const safe = this.state.safeSet?.values ?? {};
    const dangerous = this.registry.dangerousKeys(this.state.values);
    const fixes = [];
    for (const key of dangerous) {
      const def = this.registry.get(key);
      if (def?.safetyCritical && key in safe && this.state.values[key] !== safe[key]) {
        fixes.push({ op: 'set', key, value: safe[key], reason: 'safe-set-override' });
      }
    }
    if (fixes.length > 0) {
      // Internal repair path: bypasses interlock re-validation of the
      // transitional state, the safe set itself is pre-validated.
      this._commit(fixes);
    }
    return fixes;
  }

  // Test/debug hook: force a value in without validation, simulating a
  // corrupted or controller-side forced write.
  forceSet(key, value) {
    return this._commit([{ op: 'set', key, value }]);
  }

  // ---------- rollback (layered: unlock -> params -> certs) ----------

  rollback(phase) {
    const idx = ROLLBACK_ORDER.indexOf(phase);
    if (idx === -1) throw new SyncError('ROLLBACK', `unknown rollback phase: ${phase}`);
    const current = ROLLBACK_ORDER.indexOf(this.state.rollbackPhase);
    if (idx !== current + 1) {
      throw new SyncError('ROLLBACK',
        `rollback order violated: phase ${phase} requires ${ROLLBACK_ORDER[idx - 1] ?? 'none'}, current is ${this.state.rollbackPhase}`);
    }
    const entries = [{ op: 'rollback-phase', value: phase }];
    if (phase === 'unlocked') {
      for (const key of Object.keys(this.state.locks)) entries.push({ op: 'unlock', key });
    } else if (phase === 'params-reverted') {
      const safe = this.state.safeSet?.values ?? {};
      for (const [key, value] of Object.entries(safe)) {
        entries.push({ op: 'set', key, value, reason: 'rollback' });
      }
    } else if (phase === 'certs-cleared') {
      entries.push({ op: 'clear-certs' });
    }
    this._commit(entries);
    return phase;
  }

  rollbackAll() {
    for (const phase of ROLLBACK_ORDER) this.rollback(phase);
    return this.state.rollbackPhase;
  }

  // ---------- recovery ----------

  // Load base snapshot, replay the delta log on top, then enforce the safe
  // set. Whatever the crash point, the result is either the old committed
  // state or the fully applied batch -- never half-applied.
  static load(dir, registry, opts = {}) {
    const store = new Store(dir, registry, opts);
    const base = readJson(store.activeFile, null);
    if (base) {
      store.state = { ...store.state, ...base };
      store.seq = base.seq ?? 0;
    }
    let lines = [];
    try {
      lines = fs.readFileSync(store.deltaFile, 'utf8').split('\n').filter(Boolean);
    } catch { /* no delta log yet */ }
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; } // torn tail write
      if (record.seq <= store.seq) continue;
      let vector = store.state.vector;
      for (const e of record.entries) {
        if (e.op === 'set') store.state.values[e.key] = e.value;
        else if (e.op === 'lock') store.state.locks[e.key] = true;
        else if (e.op === 'unlock') delete store.state.locks[e.key];
        else if (e.op === 'cert') store.state.certs[e.key] = e.value;
        else if (e.op === 'clear-certs') store.state.certs = {};
        else if (e.op === 'rollback-phase') store.state.rollbackPhase = e.value;
        vector = mergeVector(vector, e.vector ?? {});
      }
      store.state.vector = vector;
      store.seq = record.seq;
    }
    const manifest = readJson(store.safeFile, null);
    if (manifest) store.state.safeSet = manifest;
    // Persist the recovered snapshot, then make dangerous values safe.
    store._writeActive({ ...store.state, seq: store.seq });
    store._enforceSafeSet();
    return store;
  }

  // Replay the delta log into a flat entry list (used to build pack/feedback libs).
  exportEntries() {
    let lines = [];
    try {
      lines = fs.readFileSync(this.deltaFile, 'utf8').split('\n').filter(Boolean);
    } catch { return []; }
    const entries = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      for (const e of record.entries) entries.push(e);
    }
    return entries;
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ ...this.state, seq: this.seq }));
  }
}
