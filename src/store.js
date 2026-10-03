import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QError } from './errors.js';
import { encodeSegment, decodeSegment, findPhrase } from './segment.js';
import { emptyManifest, computeHead, elemHashHex } from './manifest.js';

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

// Fault injection points (env QCERT_FAULT or opts.fault):
//   'seg'          crash after a torn (partial) segment write
//   'pre-manifest' crash after full segment write, before manifest write
//   'replace'      crash after manifest.tmp write, before atomic rename
export class Store {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.fault = opts.fault ?? process.env.QCERT_FAULT ?? null;
    this.onFault = opts.onFault ?? (() => process.exit(70));
    for (const sub of ['segments', 'quarantine', 'archive']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
  }

  get manifestPath() { return path.join(this.dir, 'manifest.json'); }
  get tmpPath() { return path.join(this.dir, 'manifest.tmp'); }
  get journalPath() { return path.join(this.dir, 'journal.log'); }
  segPath(id) { return path.join(this.dir, 'segments', `${id}.seg`); }

  crash(point) {
    this.onFault(point);
    throw new QError('E_FAULT', `fault injected at ${point}`);
  }

  readManifest() {
    if (!fs.existsSync(this.manifestPath)) return null;
    return JSON.parse(fs.readFileSync(this.manifestPath, 'utf8'));
  }

  verify(m) {
    if (computeHead(m.elements) !== m.head) {
      throw new QError('E_CHAIN', `manifest head mismatch at epoch ${m.epoch}`);
    }
    for (const el of m.elements) {
      if (el.kind !== 'seg') continue;
      const p = this.segPath(el.id);
      if (!fs.existsSync(p)) throw new QError('E_CHAIN', `missing segment file ${el.id}`);
      if (sha256hex(fs.readFileSync(p)) !== el.hash) {
        throw new QError('E_CHAIN', `segment ${el.id} hash mismatch`);
      }
    }
    return true;
  }

  load() {
    const m = this.readManifest();
    if (!m) return emptyManifest();
    this.verify(m);
    return m;
  }

  writeFileFsync(p, buf) {
    const fd = fs.openSync(p, 'w');
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }

  fsyncDir(p) {
    try {
      const fd = fs.openSync(p, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch { /* best effort on non-Linux */ }
  }

  commit(m) {
    this.writeFileFsync(this.tmpPath, Buffer.from(JSON.stringify(m, null, 2)));
    if (this.fault === 'replace') this.crash('replace');
    fs.renameSync(this.tmpPath, this.manifestPath);
    this.fsyncDir(this.dir);
    fs.appendFileSync(this.journalPath, JSON.stringify(m) + '\n');
  }

  readJournal() {
    if (!fs.existsSync(this.journalPath)) return [];
    return fs.readFileSync(this.journalPath, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  put(id, text) {
    const m = this.load();
    if (m.elements.some((e) => e.kind === 'seg' && e.id === id)) {
      throw new QError('E_DUP', `duplicate live id ${id}`);
    }
    const epoch = m.epoch + 1;
    const data = encodeSegment({ id, epoch, text });
    if (this.fault === 'seg') {
      const fd = fs.openSync(this.segPath(id), 'w');
      fs.writeSync(fd, data.subarray(0, Math.floor(data.length / 2)));
      fs.closeSync(fd);
      this.crash('seg');
    }
    this.writeFileFsync(this.segPath(id), data);
    this.fsyncDir(path.join(this.dir, 'segments'));
    if (this.fault === 'pre-manifest') this.crash('pre-manifest');
    const next = {
      version: 1,
      epoch,
      elements: [...m.elements, { kind: 'seg', id, hash: sha256hex(data) }],
    };
    next.head = computeHead(next.elements);
    this.commit(next);
    return next;
  }

  del(id) {
    const m = this.load();
    const i = m.elements.findIndex((e) => e.kind === 'seg' && e.id === id);
    if (i < 0) throw new QError('E_ABSENT', `no live segment ${id}`);
    const epoch = m.epoch + 1;
    const pred = i > 0 ? elemHashHex(m.elements[i - 1]) : null;
    const succ = i < m.elements.length - 1 ? elemHashHex(m.elements[i + 1]) : null;
    const tomb = { kind: 'tomb', id, hash: m.elements[i].hash, pred, succ, epoch };
    const elements = [...m.elements];
    elements[i] = tomb;
    const next = { version: 1, epoch, elements, head: computeHead(elements) };
    fs.renameSync(this.segPath(id), path.join(this.dir, 'archive', `${id}.seg`));
    this.commit(next);
    return next;
  }

  query(phrase) {
    const m = this.load(); // verifies chain: E_CHAIN on tamper
    const results = [];
    for (const el of m.elements) {
      if (el.kind !== 'seg') continue;
      const seg = decodeSegment(fs.readFileSync(this.segPath(el.id)));
      const positions = findPhrase(seg.index, phrase);
      if (positions.length > 0) results.push({ id: el.id, positions });
    }
    return results;
  }

  inclusionProof(m, idx, segFile) {
    const data = fs.readFileSync(segFile);
    const el = m.elements[idx];
    return {
      type: 'inclusion',
      id: el.id,
      epoch: m.epoch,
      head: m.head,
      index: idx,
      segHash: el.hash,
      segmentB64: data.toString('base64'),
      elements: m.elements,
    };
  }

  prove(id) {
    const m = this.load();
    const liveIdx = m.elements.findIndex((e) => e.kind === 'seg' && e.id === id);
    if (liveIdx >= 0) return this.inclusionProof(m, liveIdx, this.segPath(id));
    const tomb = [...m.elements].reverse().find((e) => e.kind === 'tomb' && e.id === id);
    if (!tomb) throw new QError('E_ABSENT', `unknown id ${id}`);
    const exclusion = {
      type: 'exclusion',
      id,
      epoch: m.epoch,
      head: m.head,
      tombstone: tomb,
      elements: m.elements,
    };
    // Old inclusion proof from the journal (segment bytes preserved in archive/).
    let inclusion = null;
    const journal = this.readJournal();
    for (let i = journal.length - 1; i >= 0; i--) {
      const jm = journal[i];
      const idx = jm.elements.findIndex((e) => e.kind === 'seg' && e.id === id);
      if (idx >= 0) {
        inclusion = this.inclusionProof(jm, idx, path.join(this.dir, 'archive', `${id}.seg`));
        break;
      }
    }
    return { type: 'exclusion+inclusion', exclusion, inclusion };
  }

  // Recovery: only the last complete chain (manifest.json) is authoritative.
  // Never mutates state when the chain does not verify.
  recover(log = []) {
    const m = this.readManifest();
    if (m) this.verify(m); // E_CHAIN aborts before any state migration
    const man = m ?? emptyManifest();
    log.push(`manifest: ok epoch=${man.epoch} head=${man.head}`);
    if (fs.existsSync(this.tmpPath)) {
      fs.rmSync(this.tmpPath);
      log.push('tmp: discarded stale manifest.tmp');
    }
    const referenced = new Set(
      man.elements.filter((e) => e.kind === 'seg').map((e) => `${e.id}.seg`),
    );
    const files = fs.readdirSync(path.join(this.dir, 'segments')).sort();
    let quarantined = 0;
    for (const f of files) {
      if (referenced.has(f)) continue;
      const p = path.join(this.dir, 'segments', f);
      let reason = 'orphan';
      try {
        decodeSegment(fs.readFileSync(p));
      } catch (e) {
        if (e.code === 'E_TORN') reason = 'torn';
      }
      fs.renameSync(p, path.join(this.dir, 'quarantine', f));
      quarantined++;
      log.push(`quarantine: ${f} reason=${reason}`);
    }
    const segs = man.elements.filter((e) => e.kind === 'seg').length;
    const tombs = man.elements.filter((e) => e.kind === 'tomb').length;
    log.push(`done: epoch=${man.epoch} segments=${segs} tombstones=${tombs} quarantined=${quarantined}`);
    return log;
  }
}
