import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ParamStore } from './store.js';
import { ValidationError, FaultInjected } from './errors.js';

// On-disk layout of a param db directory:
//   active.json            committed snapshot (atomic via tmp + rename)
//   active.json.tmp        transient snapshot
//   delta.log              append-only JSON lines, each with sha256 checksum
//   schema.json            compiled schema source (param defs)
//   safe-set/manifest.json safe-set manifest
//   safe-set/COMMITTED     commit marker for the manifest
//
// Fault injection points (option `fault` or env PARAM_SYNC_FAULT):
//   before-delta-append | after-delta-append |
//   before-active-rename | after-manifest-commit

export const FAULT_POINTS = [
  'before-delta-append',
  'after-delta-append',
  'before-active-rename',
  'after-manifest-commit',
];

function checksumOf(entry) {
  const { checksum, ...payload } = entry;
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class PersistentStore {
  constructor(dir, schema, nodeId, opts = {}) {
    this.dir = dir;
    this.schema = schema;
    this.nodeId = nodeId;
    this.fault = opts.fault ?? process.env.PARAM_SYNC_FAULT ?? null;
    this.store = new ParamStore(schema, nodeId);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  maybeFault(point) {
    if (this.fault === point) throw new FaultInjected(point);
  }

  get deltaPath() { return path.join(this.dir, 'delta.log'); }
  get activePath() { return path.join(this.dir, 'active.json'); }
  get activeTmpPath() { return path.join(this.dir, 'active.json.tmp'); }
  get safeSetDir() { return path.join(this.dir, 'safe-set'); }
  get manifestPath() { return path.join(this.safeSetDir, 'manifest.json'); }
  get manifestTmpPath() { return path.join(this.safeSetDir, 'manifest.json.tmp'); }
  get manifestCommitPath() { return path.join(this.safeSetDir, 'COMMITTED'); }

  // --- change capture with persistence around the delta append fault points
  set(key, value) {
    const entry = this.store.set(key, value);
    this.persistDelta(entry);
    return entry;
  }

  lock(key) {
    const entry = this.store.lock(key);
    this.persistDelta(entry);
    return entry;
  }

  unlock(key) {
    const entry = this.store.unlock(key);
    this.persistDelta(entry);
    return entry;
  }

  persistDelta(entry) {
    this.maybeFault('before-delta-append');
    const line = JSON.stringify({ ...entry, checksum: checksumOf(entry) }) + '\n';
    fs.appendFileSync(this.deltaPath, line);
    this.maybeFault('after-delta-append');
  }

  // --- atomic snapshot commit
  commitSnapshot() {
    const snap = this.store.snapshot();
    fs.writeFileSync(this.activeTmpPath, JSON.stringify(snap, null, 2));
    this.maybeFault('before-active-rename');
    fs.renameSync(this.activeTmpPath, this.activePath);
    // Snapshot is durable: delta log can be truncated.
    fs.writeFileSync(this.deltaPath, '');
    return snap;
  }

  // --- safe-set manifest commit
  commitSafeSet(entries) {
    for (const [key, value] of Object.entries(entries)) {
      const def = this.schema.params.get(key);
      if (!def) throw new ValidationError(`safe-set: unknown key '${key}'`);
      this.store.validateValue(def, value);
    }
    const manifest = { seq: this.store.seq, entries };
    fs.mkdirSync(this.safeSetDir, { recursive: true });
    fs.writeFileSync(this.manifestTmpPath, JSON.stringify(manifest, null, 2));
    fs.renameSync(this.manifestTmpPath, this.manifestPath);
    fs.writeFileSync(this.manifestCommitPath, String(manifest.seq));
    this.maybeFault('after-manifest-commit');
    return manifest;
  }

  readSafeSet() {
    if (!fs.existsSync(this.manifestPath) || !fs.existsSync(this.manifestCommitPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
  }

  // --- recovery: never leaves a half-applied state.
  // 1. Base state = committed active.json (tmp without rename is discarded).
  // 2. Replay only checksum-valid delta lines (partial tail discarded).
  // 3. Uncommitted deltas mean a crash mid-apply: any safety-critical key
  //    covered by the committed safe-set manifest is overridden to its safe
  //    value, so dangerous values can never survive recovery.
  static recover(dir, schema, nodeId, opts = {}) {
    const ps = new PersistentStore(dir, schema, nodeId, opts);
    const report = { replayed: 0, discarded: 0, overridden: [], dirty: false };

    if (fs.existsSync(ps.activePath)) {
      const snap = JSON.parse(fs.readFileSync(ps.activePath, 'utf8'));
      ps.store = ParamStore.fromSnapshot(schema, snap);
    }
    if (fs.existsSync(ps.activeTmpPath)) fs.rmSync(ps.activeTmpPath);

    if (fs.existsSync(ps.deltaPath)) {
      const lines = fs.readFileSync(ps.deltaPath, 'utf8').split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        let entry = null;
        try { entry = JSON.parse(line); } catch { entry = null; }
        if (!entry || entry.checksum !== checksumOf(entry)) {
          report.discarded += 1;
          break; // partial tail: stop replay here
        }
        ps.store.applyDelta(entry);
        report.replayed += 1;
      }
    }

    if (report.replayed > 0) {
      report.dirty = true;
      const manifest = ps.readSafeSet();
      if (manifest) {
        for (const [key, safeValue] of Object.entries(manifest.entries)) {
          const def = schema.params.get(key);
          const entry = ps.store.state.get(key);
          if (def && def.safety && entry && entry.value !== safeValue) {
            entry.value = safeValue;
            entry.locked = false;
            report.overridden.push(key);
          }
        }
      }
      // Finalize recovery: persist a clean snapshot, clear the delta log.
      ps.commitSnapshot();
    }
    return { store: ps, report };
  }
}

export function writeSchema(dir, defs) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify(defs, null, 2));
}

export function readSchema(dir) {
  const p = path.join(dir, 'schema.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
