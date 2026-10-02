import fs from 'node:fs';
import path from 'node:path';
import { foldAll } from './machine.js';
import { canonical, sha256, keyOf } from './events.js';

export class StoreIntegrityError extends Error {}

const ZERO_HASH = '0'.repeat(64);

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function parseJsonl(raw, name) {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  return lines.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new StoreIntegrityError(`corrupt ${name} at line ${i + 1}`);
    }
  });
}

function readJsonSafe(p) {
  const raw = readFileSafe(p);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoreIntegrityError(`corrupt json file: ${p}`);
  }
}

function fsyncPath(p) {
  const fd = fs.openSync(p, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// tmp + fsync + rename: a crash before the rename leaves the old file intact.
function atomicWriteJson(tmpPath, finalPath, obj) {
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n');
  fsyncPath(tmpPath);
  fs.renameSync(tmpPath, finalPath);
}

function appendLines(p, lines) {
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, lines.join('\n') + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Verify the hash chain; returns the number of leading valid entries.
export function auditValidPrefix(entries) {
  let prev = ZERO_HASH;
  let count = 0;
  for (const en of entries) {
    const { hash, ...body } = en;
    if (en.prev !== prev || hash !== sha256(canonical(body))) break;
    prev = hash;
    count += 1;
  }
  return { validCount: count, head: prev };
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.p = {
      log: path.join(dir, 'events.jsonl'),
      index: path.join(dir, 'index.json'),
      indexTmp: path.join(dir, 'index.json.tmp'),
      state: path.join(dir, 'state.json'),
      stateTmp: path.join(dir, 'state.json.tmp'),
      audit: path.join(dir, 'audit.jsonl'),
      manifest: path.join(dir, 'manifest.json'),
      manifestTmp: path.join(dir, 'manifest.json.tmp'),
    };
    fs.mkdirSync(dir, { recursive: true });
    this.log = [];
    this.logRaw = '';
    this.state = null;
  }

  static open(dir) {
    const s = new Store(dir);
    s.load();
    return s;
  }

  // Read-only load: trust the snapshot only if it covers the exact current
  // log; otherwise re-fold from the event log. Never writes.
  load() {
    const raw = readFileSafe(this.p.log);
    this.logRaw = raw ?? '';
    this.log = raw === null ? [] : parseJsonl(raw, 'events log');
    const snap = readJsonSafe(this.p.state);
    if (snap && snap.state && snap.logCount === this.log.length && snap.logHash === sha256(this.logRaw)) {
      this.state = snap.state;
    } else {
      this.state = foldAll(this.log).state;
    }
    return this;
  }

  // Fault point 1/2: append to the event log (fsync). A crash before this
  // loses nothing; a crash after this but before the index is rebuilt by
  // recover()/commit().
  appendEvents(events) {
    const haveKeys = new Set(this.log.map(keyOf));
    const haveIds = new Set(this.log.map((e) => e.id));
    const added = [];
    for (const e of events) {
      if (haveKeys.has(keyOf(e)) || haveIds.has(e.id)) continue;
      this.log.push(e);
      haveKeys.add(keyOf(e));
      haveIds.add(e.id);
      added.push(e);
    }
    if (added.length) {
      appendLines(this.p.log, added.map((e) => JSON.stringify(e)));
      this.logRaw = readFileSafe(this.p.log) ?? '';
    }
    return added;
  }

  // Persist a mutation: re-fold deterministically, then write index,
  // snapshot (tmp+rename), audit entries and finally the audit manifest.
  commit() {
    const prevApplied = this.state ? this.state.applied : {};
    const prevPending = new Set(this.state ? this.state.pending.map(keyOf) : []);
    const { state, decisions } = foldAll(this.log);
    // Audit new decisions, pending events that just resolved, and decisions
    // reclassified because an earlier-sorting event arrived (e.g. a
    // concurrent assign that turns a previous assign into a conflict loser).
    const fresh = decisions
      .filter((d) => {
        const k = keyOf(d.event);
        const prev = prevApplied[k];
        if (prev) return prev.decision !== d.decision;
        if (d.decision === 'pending' && prevPending.has(k)) return false;
        return true;
      })
      .map((d) => (keyOf(d.event) in prevApplied ? { ...d, reclassified: true } : d));
    this.state = state;
    this.writeIndex();
    this.writeSnapshot();
    const entries = fresh.map((d) => ({
      op: d.event.op,
      wo: d.event.wo,
      alarm: d.event.alarm,
      event: d.event.id,
      site: d.event.site,
      seq: d.event.seq,
      decision: d.decision,
      reason: d.reason,
      ...(d.reclassified ? { reclassified: true } : {}),
    }));
    this.appendAudit(entries);
    return { decisions: fresh };
  }

  writeIndex() {
    atomicWriteJson(this.p.indexTmp, this.p.index, {
      applied: Object.keys(this.state.applied).sort(),
      vc: this.state.vc,
      logCount: this.log.length,
    });
  }

  writeSnapshot() {
    atomicWriteJson(this.p.stateTmp, this.p.state, {
      logCount: this.log.length,
      logHash: sha256(this.logRaw),
      state: this.state,
    });
  }

  // Audit entries are hash-chained; the manifest (count + head) is committed
  // last via tmp+rename. A crash after the commit leaves a consistent log.
  appendAudit(entries) {
    const manifest = readJsonSafe(this.p.manifest) || { count: 0, head: ZERO_HASH };
    let prev = manifest.head;
    let count = manifest.count;
    const lines = [];
    for (const en of entries) {
      count += 1;
      const body = { seq: count, ts: new Date().toISOString(), ...en, prev };
      const hash = sha256(canonical(body));
      lines.push(JSON.stringify({ ...body, hash }));
      prev = hash;
    }
    if (lines.length) appendLines(this.p.audit, lines);
    atomicWriteJson(this.p.manifestTmp, this.p.manifest, { count, head: prev });
    return { count, head: prev };
  }

  // Crash recovery. Idempotent: events already applied are never re-applied,
  // a half-written index is rebuilt from the log, orphaned tmp files are
  // discarded, and the audit log is truncated back to the committed manifest.
  recover() {
    const report = {
      discardedTmp: [],
      snapshot: 'valid',
      rebuiltIndex: false,
      truncatedAudit: 0,
      recoveryAudit: 0,
      logEvents: 0,
      appliedEvents: 0,
      pending: 0,
    };
    // 1. Orphaned tmp files mean a crash before a rename; the old file (or
    //    the log) stays authoritative.
    for (const [tmp, name] of [
      [this.p.stateTmp, 'state.json.tmp'],
      [this.p.indexTmp, 'index.json.tmp'],
      [this.p.manifestTmp, 'manifest.json.tmp'],
    ]) {
      if (fs.existsSync(tmp)) {
        fs.rmSync(tmp);
        report.discardedTmp.push(name);
      }
    }
    // 2. Event log is the source of truth.
    const raw = readFileSafe(this.p.log);
    this.logRaw = raw ?? '';
    this.log = raw === null ? [] : parseJsonl(raw, 'events log');
    report.logEvents = this.log.length;
    // 3. Snapshot: use it only if it covers the exact current log.
    const snap = readJsonSafe(this.p.state);
    if (snap && snap.state && snap.logCount === this.log.length && snap.logHash === sha256(this.logRaw)) {
      this.state = snap.state;
    } else {
      this.state = foldAll(this.log).state;
      report.snapshot = this.log.length ? 'rebuilt' : 'empty';
      this.writeSnapshot();
    }
    // 4. Index: rebuild when missing or not covering the applied set.
    const appliedKeys = Object.keys(this.state.applied).sort();
    const index = readJsonSafe(this.p.index);
    const indexOk = index
      && index.logCount === this.log.length
      && JSON.stringify([...(index.applied || [])].sort()) === JSON.stringify(appliedKeys);
    if (!indexOk) {
      this.writeIndex();
      report.rebuiltIndex = true;
    }
    // 5. Audit: verify chain, truncate anything past the committed manifest.
    const manifest = readJsonSafe(this.p.manifest);
    const auditRaw = readFileSafe(this.p.audit);
    const entries = auditRaw === null ? [] : parseJsonl(auditRaw, 'audit log');
    const { validCount } = auditValidPrefix(entries);
    const committed = manifest ? manifest.count : 0;
    if (validCount < committed) {
      throw new StoreIntegrityError('audit log corrupt within committed region');
    }
    if (manifest && validCount >= committed) {
      let prev = ZERO_HASH;
      for (let i = 0; i < committed; i += 1) prev = entries[i].hash;
      if (prev !== manifest.head) {
        throw new StoreIntegrityError('audit manifest head mismatch');
      }
    }
    if (entries.length > committed) {
      const kept = auditRaw.split('\n').filter((l) => l.trim() !== '').slice(0, committed);
      fs.writeFileSync(this.p.audit, kept.length ? kept.join('\n') + '\n' : '');
      if (kept.length) fsyncPath(this.p.audit);
      report.truncatedAudit = entries.length - committed;
    }
    // 6. Gap coverage: events whose effects are applied but were never
    //    audited (crash between log append and audit commit) get one
    //    recovery entry so the trail stays complete.
    const finalEntries = parseJsonl(readFileSafe(this.p.audit) ?? '', 'audit log');
    const covered = new Set();
    for (const en of finalEntries) {
      if (en.event) covered.add(en.event);
      if (Array.isArray(en.covered)) en.covered.forEach((id) => covered.add(id));
    }
    const missing = Object.values(this.state.applied)
      .map((a) => a.id)
      .filter((id) => !covered.has(id));
    if (missing.length) {
      this.appendAudit([{ op: 'recovery', covered: missing.sort(), note: 'applied events covered by recovery' }]);
      report.recoveryAudit = missing.length;
    }
    report.appliedEvents = Object.keys(this.state.applied).length;
    report.pending = this.state.pending.length;
    return report;
  }
}
