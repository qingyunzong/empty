import fs from 'node:fs';
import path from 'node:path';
import { canonical, sha256, Graph, LotError, EXIT } from './core.js';

export const FAULT_POINTS = ['edge-pre-fsync', 'edge-post-fsync', 'snapshot-pre-rename', 'cert-post-commit'];

function fault(point) {
  if (process.env.LOT_FAULT === point) process.exit(70); // simulated crash
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best effort */ }
}

export class Store {
  constructor(dir, { tol } = {}) {
    this.dir = dir;
    this.graph = new Graph({ tol });
    this.vv = {}; // site -> max seq seen
    this.seq = 0; // local log sequence
    this.records = []; // original lot/event records in arrival order
    this.manifest = []; // cert commit entries, hash chained
    fs.mkdirSync(path.join(dir, 'certs'), { recursive: true });
    this.logFd = null;
  }

  static open(dir, opts) {
    const store = new Store(dir, opts);
    store.recover();
    store.logFd = fs.openSync(path.join(dir, 'log.jsonl'), 'a');
    return store;
  }

  close() {
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
  }

  logPath() { return path.join(this.dir, 'log.jsonl'); }
  manifestPath() { return path.join(this.dir, 'manifest.jsonl'); }

  noteSeq(rec) {
    if (rec.site && typeof rec.seq === 'number') {
      this.vv[rec.site] = Math.max(this.vv[rec.site] ?? 0, rec.seq);
    }
  }

  applyRecord(rec) {
    if (rec.kind === 'lot') this.graph.addLot(rec);
    else this.graph.applyEvent(rec);
    this.records.push(rec);
    this.noteSeq(rec);
  }

  recover() {
    // 1. snapshot (atomic via rename; stray tmp means crash before rename)
    const tmpSnap = path.join(this.dir, 'snapshot.json.tmp');
    if (fs.existsSync(tmpSnap)) fs.rmSync(tmpSnap);
    let baseSeq = 0;
    const snapPath = path.join(this.dir, 'snapshot.json');
    if (fs.existsSync(snapPath)) {
      try {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        if (snap.sum === sha256(canonical({ seq: snap.seq, vv: snap.vv, records: snap.records }))) {
          baseSeq = snap.seq;
          this.seq = snap.seq;
          this.vv = snap.vv;
          for (const rec of snap.records) this.applyRecord(rec);
        }
      } catch { /* corrupt snapshot: fall back to full log replay */ }
    }

    // 2. edge log: replay valid prefix, truncate torn tail (no half records)
    this.replayLog(this.logPath(), baseSeq, (rec) => this.applyRecord(rec));

    // 3. cert manifest: valid prefix only, dedupe by certId (no double certs)
    const seen = new Set();
    this.replayLog(this.manifestPath(), 0, (entry) => {
      if (seen.has(entry.certId)) return;
      seen.add(entry.certId);
      this.manifest.push(entry);
    });

    // 4. drop orphan cert files never committed to the manifest
    const certsDir = path.join(this.dir, 'certs');
    for (const file of fs.readdirSync(certsDir)) {
      const id = file.replace(/\.json$/, '');
      if (!seen.has(id)) fs.rmSync(path.join(certsDir, file));
    }

    this.graph.tryResolvePending();
  }

  replayLog(file, baseSeq, apply) {
    if (!fs.existsSync(file)) return;
    const buf = fs.readFileSync(file);
    let offset = 0;
    let validEnd = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl === -1) break; // torn tail: no newline terminator
      const line = buf.subarray(offset, nl).toString('utf8');
      let entry;
      try {
        entry = JSON.parse(line);
      } catch { break; }
      const { sum, ...body } = entry;
      if (sum !== sha256(canonical(body))) break; // checksum mismatch: torn/corrupt
      if ((body.seq ?? 0) > baseSeq || file === this.manifestPath()) apply(body.rec ?? body.entry);
      if (body.seq > this.seq && file !== this.manifestPath()) this.seq = body.seq;
      offset = nl + 1;
      validEnd = offset;
    }
    if (validEnd < buf.length) {
      const fd = fs.openSync(file, 'r+');
      try {
        fs.ftruncateSync(fd, validEnd);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
  }

  appendRecord(rec) {
    if (this.graph.hasRecord(rec)) return false; // idempotent
    if (rec.kind === 'lot') this.graph.addLot(rec);
    else this.graph.applyEvent(rec); // throws validation before anything is persisted
    const body = { seq: this.seq + 1, rec };
    const line = canonical({ ...body, sum: sha256(canonical(body)) }) + '\n';
    if (process.env.LOT_FAULT === 'edge-pre-fsync' && process.env.LOT_FAULT_TEAR) {
      fs.writeSync(this.logFd, line.slice(0, line.length >> 1)); // torn write
      process.exit(70);
    }
    fs.writeSync(this.logFd, line);
    fault('edge-pre-fsync');
    fs.fsyncSync(this.logFd);
    fault('edge-post-fsync');
    this.seq = body.seq;
    this.records.push(rec);
    this.noteSeq(rec);
    this.graph.tryResolvePending();
    return true;
  }

  nextSeq(site) {
    return (this.vv[site] ?? 0) + 1;
  }

  saveSnapshot() {
    const body = { seq: this.seq, vv: this.vv, records: this.records };
    const snap = { ...body, sum: sha256(canonical(body)) };
    const tmp = path.join(this.dir, 'snapshot.json.tmp');
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(snap));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fault('snapshot-pre-rename');
    fs.renameSync(tmp, path.join(this.dir, 'snapshot.json'));
    fsyncDir(this.dir);
  }

  commitCert(cert) {
    if (this.manifest.some((e) => e.certId === cert.certId)) return false; // no double cert
    const certPath = path.join(this.dir, 'certs', `${cert.certId}.json`);
    const fd = fs.openSync(certPath, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(cert, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const prev = this.manifest.length ? this.manifest[this.manifest.length - 1].sum : sha256('lot-genealogy/manifest/v1');
    const entry = { certId: cert.certId, root: cert.root, ts: new Date().toISOString(), prev };
    const line = canonical({ entry, sum: sha256(canonical({ entry })) }) + '\n';
    fs.appendFileSync(this.manifestPath(), line);
    const mfd = fs.openSync(this.manifestPath(), 'r');
    try { fs.fsyncSync(mfd); } finally { fs.closeSync(mfd); }
    fault('cert-post-commit');
    this.manifest.push({ entry, sum: sha256(canonical({ entry })) });
    return true;
  }

  pending() {
    return this.graph.pending();
  }
}

export function syncStores(a, b) {
  const transfer = (src, dst) => {
    const missing = src.records.filter((r) => (r.seq ?? 0) > (dst.vv[r.site] ?? 0) && !dst.graph.hasRecord(r));
    // lots before events, then causal order by (site, seq); pending absorbs the rest
    const rank = (r) => (r.kind === 'lot' ? 0 : 1);
    missing.sort((x, y) => rank(x) - rank(y) || x.site.localeCompare(y.site) || x.seq - y.seq);
    let moved = 0;
    for (const rec of missing) {
      if (dst.appendRecord(rec)) moved++;
    }
    return moved;
  };
  const toB = transfer(a, b);
  const toA = transfer(b, a);
  a.graph.tryResolvePending();
  b.graph.tryResolvePending();
  return { toB, toA };
}
