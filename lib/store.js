'use strict';
const fs = require('fs');
const path = require('path');
const { sha256hex } = require('./util');

const MAX_FRAME = 1 << 20;

function splitRaw(buf) {
  const raws = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len < 2 || len > MAX_FRAME || off + 4 + len > buf.length) break;
    raws.push(buf.slice(off, off + 4 + len));
    off += 4 + len;
  }
  return raws;
}

// Durable state: inbox.log (raw frames as received), events.log (settled
// journal, source of truth), balances.json (derived cache), cert-*.json
// (atomic tmp+rename). Recovery replays inbox through the deterministic
// engine and re-syncs only entries beyond the persisted seq, so every
// crash point recovers idempotently.
class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.inboxPath = path.join(dir, 'inbox.log');
    this.eventsPath = path.join(dir, 'events.log');
    this.balancesPath = path.join(dir, 'balances.json');
    this.inboxFd = fs.openSync(this.inboxPath, 'a+');
    this.eventsFd = fs.openSync(this.eventsPath, 'a+');
  }

  recover() {
    const inboxFrames = splitRaw(fs.readFileSync(this.inboxPath));
    this.inboxHashes = new Set(inboxFrames.map((r) => sha256hex(r.toString('base64'))));
    this.persistedSeq = 0;
    const eventsRaw = fs.readFileSync(this.eventsPath, 'utf8');
    for (const line of eventsRaw.split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.seq > this.persistedSeq) this.persistedSeq = entry.seq;
    }
    return { inboxFrames };
  }

  appendInbox(raw) {
    const hash = sha256hex(raw.toString('base64'));
    if (this.inboxHashes.has(hash)) return false;
    fs.writeSync(this.inboxFd, raw);
    fs.fsyncSync(this.inboxFd);
    this.inboxHashes.add(hash);
    return true;
  }

  syncEntries(allEntries) {
    let written = 0;
    for (const e of allEntries) {
      if (e.seq > this.persistedSeq) {
        fs.writeSync(this.eventsFd, JSON.stringify(e) + '\n');
        this.persistedSeq = e.seq;
        written++;
      }
    }
    if (written > 0) fs.fsyncSync(this.eventsFd);
    return written;
  }

  writeAtomic(filePath, data) {
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  }

  writeBalances(obj) {
    this.writeAtomic(this.balancesPath, JSON.stringify(obj, null, 2) + '\n');
  }

  certPath(periodId) {
    return path.join(this.dir, `cert-${periodId}.json`);
  }

  // Returns true if published. beforePublish hook runs after the tmp write
  // and before the atomic rename (crash point: before publishing certificate).
  writeCert(periodId, cert, beforePublish) {
    const data = JSON.stringify(cert, null, 2) + '\n';
    const p = this.certPath(periodId);
    if (fs.existsSync(p) && fs.readFileSync(p, 'utf8') === data) return false;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, data);
    if (beforePublish) beforePublish();
    fs.renameSync(tmp, p);
    return true;
  }

  close() {
    fs.closeSync(this.inboxFd);
    fs.closeSync(this.eventsFd);
  }
}

module.exports = { Store };
