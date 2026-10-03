import fs from 'node:fs';
import path from 'node:path';
import { Graph, entryId } from './graph.js';
import { canonical, sha256hex } from './canon.js';
import { LotError, EXIT } from './errors.js';

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

// Read JSONL log; stops at the first corrupt/partial line (crash tail).
function readLog(file) {
  const entries = [];
  if (!fs.existsSync(file)) return { entries, corruptOffset: null, size: 0 };
  const buf = fs.readFileSync(file);
  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl === -1) return { entries, corruptOffset: offset, size: buf.length };
    const line = buf.subarray(offset, nl).toString('utf8');
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      return { entries, corruptOffset: offset, size: buf.length };
    }
    if (!entry || typeof entry !== 'object' || entryId(entry) !== entry.id)
      return { entries, corruptOffset: offset, size: buf.length };
    entries.push(entry);
    offset = nl + 1;
  }
  return { entries, corruptOffset: null, size: buf.length };
}

export class Store {
  constructor(dir, { tolerance } = {}) {
    this.dir = dir;
    this.logPath = path.join(dir, 'edges.log');
    this.snapshotPath = path.join(dir, 'snapshot.json');
    this.manifestPath = path.join(dir, 'manifest.log');
    this.certsDir = path.join(dir, 'certs');
    this.configPath = path.join(dir, 'config.json');
    this.tolerance = tolerance;
    this.entries = [];
    this.graph = new Graph({ tolerance });
  }

  static init(dir, { site = 'local', tolerance } = {}) {
    fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
    const configPath = path.join(dir, 'config.json');
    if (!fs.existsSync(configPath)) atomicWrite(configPath, canonical({ site }) + '\n');
    const store = new Store(dir, { tolerance });
    store.load();
    return store;
  }

  get site() {
    try {
      return JSON.parse(fs.readFileSync(this.configPath, 'utf8')).site || 'local';
    } catch {
      return 'local';
    }
  }

  load() {
    const { entries } = readLog(this.logPath);
    this.entries = entries;
    this.graph = new Graph({ tolerance: this.tolerance });
    this.replayErrors = this.graph.replay(entries);
    return this;
  }

  #appendLine(entry) {
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, canonical(entry) + '\n');
      fs.fsyncSync(fd); // edge durable only after fsync
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(this.dir);
    this.entries.push(entry);
  }

  // Local operation: validate first, then append+fsync, then apply.
  add({ op, in: inputs = [], out: outputs = [], ts, site }) {
    if (ts === undefined) {
      ts = this.graph.lastTs + 1;
      // Backfilled parents must not postdate the pending ops that consume
      // them, or the time-order check would block convergence forever.
      if (op === 'register' && outputs.length === 1) {
        for (const p of this.graph.pending) {
          if (p.in.some((i) => i.lot === outputs[0].lot)) ts = Math.min(ts, p.ts);
        }
      }
    }
    const entry = {
      site: site || this.site,
      seq: (this.graph.vv[site || this.site] || 0) + 1,
      ts,
      op,
      in: inputs,
      out: outputs,
    };
    entry.id = entryId(entry);
    const verdict = this.graph.check(entry); // throws on validation failure
    if (verdict === 'duplicate') return { entry, verdict };
    this.#appendLine(entry);
    const applied = this.graph.apply(entry);
    this.saveSnapshot();
    return { entry, verdict: applied };
  }

  // Merge entries received from a peer (already fully formed).
  receive(entries) {
    let added = 0;
    for (const e of entries) {
      if (this.graph.has(e.id)) continue; // idempotent: duplicate edges dropped
      this.#appendLine(e);
      added++;
    }
    if (added) {
      this.graph = new Graph({ tolerance: this.tolerance });
      this.replayErrors = this.graph.replay(this.entries);
      this.saveSnapshot();
    }
    return added;
  }

  saveSnapshot() {
    const snap = {
      count: this.entries.length,
      hash: sha256hex(canonical(this.entries)),
      vv: this.graph.vv,
    };
    atomicWrite(this.snapshotPath, canonical(snap) + '\n'); // tmp+fsync+rename
  }

  // --- certificates ---

  manifestEntries() {
    return readLog(this.manifestPath).entries.map((e) => e.entry ?? e);
  }

  commitCert(cert) {
    const head = cert.head;
    const manifest = this.manifestEntries();
    const existing = manifest.find((m) => m.head === head);
    if (existing) return { head, committed: false, path: path.join(this.certsDir, head + '.json') };
    const certPath = path.join(this.certsDir, head + '.json');
    atomicWrite(certPath, canonical(cert) + '\n'); // cert file first
    const record = { entry: { head, root: cert.root } };
    record.id = entryId(record);
    const fd = fs.openSync(this.manifestPath, 'a');
    try {
      fs.writeSync(fd, canonical(record) + '\n');
      fs.fsyncSync(fd); // manifest commit after cert is durable
    } finally {
      fs.closeSync(fd);
    }
    fsyncDir(this.dir);
    return { head, committed: true, path: certPath };
  }

  certPath(head) {
    return path.join(this.certsDir, head + '.json');
  }

  // --- crash recovery ---

  resume() {
    const report = { truncatedBytes: 0, removedTmp: [], droppedManifest: [], removedOrphanCerts: [], snapshotRebuilt: false };
    // Fault point 1: edge log fsync boundary — drop partial tail, keep whole entries.
    const log = readLog(this.logPath);
    if (log.corruptOffset !== null) {
      fs.truncateSync(this.logPath, log.corruptOffset);
      report.truncatedBytes = log.size - log.corruptOffset;
    }
    // Fault point 2: snapshot rename boundary — stray tmp files are discarded.
    for (const dir of [this.dir, this.certsDir]) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.tmp')) {
          fs.unlinkSync(path.join(dir, f));
          report.removedTmp.push(f);
        }
      }
    }
    this.entries = log.entries;
    this.graph = new Graph({ tolerance: this.tolerance });
    this.replayErrors = this.graph.replay(this.entries);
    // Fault point 3: manifest committed after cert — reconcile both directions.
    const manifest = this.manifestEntries();
    const keep = [];
    for (const m of manifest) {
      const p = this.certPath(m.head);
      if (!fs.existsSync(p)) {
        report.droppedManifest.push(m.head); // commit without durable cert
        continue;
      }
      try {
        const cert = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (cert.head !== m.head) throw new Error('head mismatch');
        keep.push(m);
      } catch {
        report.droppedManifest.push(m.head);
      }
    }
    if (keep.length !== manifest.length) {
      atomicWrite(
        this.manifestPath,
        keep.map((m) => {
          const rec = { entry: m };
          rec.id = entryId(rec);
          return canonical(rec) + '\n';
        }).join('')
      );
    }
    const committedHeads = new Set(keep.map((m) => m.head));
    for (const f of fs.readdirSync(this.certsDir)) {
      if (f.endsWith('.json') && !committedHeads.has(f.slice(0, -5))) {
        fs.unlinkSync(path.join(this.certsDir, f)); // cert written but never committed
        report.removedOrphanCerts.push(f);
      }
    }
    // Snapshot is a cache; rebuild if missing or stale.
    let snapOk = false;
    try {
      const snap = JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8'));
      snapOk = snap.count === this.entries.length && snap.hash === sha256hex(canonical(this.entries));
    } catch {
      snapOk = false;
    }
    if (!snapOk) {
      this.saveSnapshot();
      report.snapshotRebuilt = true;
    }
    report.entries = this.entries.length;
    report.pending = this.graph.pending.length;
    return report;
  }
}
