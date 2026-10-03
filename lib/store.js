'use strict';

const fs = require('node:fs');
const path = require('node:path');

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  const dfd = fs.openSync(path.dirname(file), 'r');
  fs.fsyncSync(dfd);
  fs.closeSync(dfd);
}

// Durable layout in the state dir:
//   wal.log           NDJSON records: {op:'frame'|'event'|'cert', ...}, fsynced per record
//   state.json        atomic snapshot of the collector (covers walFrames frame records)
//   cert-<period>.json  atomic Merkle certificates
class Store {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.snapPath = path.join(dir, 'state.json');
    this.walFd = null;
  }

  init({ fresh = false } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    if (fresh) {
      for (const f of fs.readdirSync(this.dir)) {
        if (/^(wal\.log|state\.json|cert-.*\.json|report\.json)$/.test(f)) {
          fs.rmSync(path.join(this.dir, f), { force: true });
        }
      }
    }
    this.walFd = fs.openSync(this.walPath, 'a');
  }

  close() {
    if (this.walFd !== null) {
      fs.closeSync(this.walFd);
      this.walFd = null;
    }
  }

  appendWal(rec) {
    fs.writeSync(this.walFd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this.walFd);
  }

  load() {
    let snapshot = null;
    try {
      snapshot = JSON.parse(fs.readFileSync(this.snapPath, 'utf8'));
    } catch { /* no snapshot yet */ }
    const frames = [];
    let raw = '';
    try {
      raw = fs.readFileSync(this.walPath, 'utf8');
    } catch { /* no wal yet */ }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        break; // torn tail from a crash: stop replay here
      }
      if (rec.op === 'frame') frames.push(rec.obj);
    }
    return { snapshot, frames };
  }

  saveSnapshot(state) {
    atomicWrite(this.snapPath, JSON.stringify(state));
  }

  certPath(periodId) {
    return path.join(this.dir, `cert-${periodId}.json`);
  }

  saveCert(periodId, cert) {
    atomicWrite(this.certPath(periodId), JSON.stringify(cert, null, 2) + '\n');
  }

  hasCert(periodId) {
    return fs.existsSync(this.certPath(periodId));
  }
}

module.exports = { Store, atomicWrite };
