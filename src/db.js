'use strict';

const fs = require('fs');
const path = require('path');
const { JeError, EXIT_CRASH } = require('./errors');

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}

const canonStr = (v) => JSON.stringify(canon(v));

function appendLineSync(file, line) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function freshIndex() {
  return { balances: {}, lastSeq: 0, batches: {}, periods: {} };
}

function envCrashAt() {
  const m = /^post:(\d+)$/.exec(process.env.JE_CRASH_AT || '');
  return m ? Number(m[1]) : null;
}

class Db {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.postingsPath = path.join(dir, 'postings.jsonl');
    this.indexPath = path.join(dir, 'index.json');
    this.crashAt = opts.crashAt !== undefined ? opts.crashAt : envCrashAt();
    // 'exit' kills the process (CLI default); 'throw' raises E_CRASH so
    // embedders/tests can simulate the kill in-process.
    this.crashMode = opts.crashMode || 'exit';
    this.index = fs.existsSync(this.indexPath)
      ? JSON.parse(fs.readFileSync(this.indexPath, 'utf8'))
      : freshIndex();
    const postings = readJsonLines(this.postingsPath);
    this.nextSeq = postings.length === 0 ? 1 : postings[postings.length - 1].seq + 1;
  }

  static open(dir, opts) {
    fs.mkdirSync(dir, { recursive: true });
    return new Db(dir, opts);
  }

  writeIndex() {
    const tmp = this.indexPath + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify(canon(this.index), null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.indexPath);
  }

  wal(rec) {
    appendLineSync(this.walPath, JSON.stringify(rec));
  }

  beginRun(periods) {
    this.index.periods = { ...this.index.periods, ...periods };
    this.writeIndex();
  }

  // WAL point 1: BEGIN_BATCH.
  beginBatch(id, period) {
    this.wal({ t: 'BEGIN_BATCH', batch: id, period });
    this.index.batches[id] = 'IN_FLIGHT';
    this.writeIndex();
  }

  // WAL point 2: before each POST. Crash point: after the posting is
  // durable on disk, before the index update.
  post(batchId, legs) {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const entry = { seq, batch: batchId, legs };
    this.wal({ t: 'POST', ...entry });
    appendLineSync(this.postingsPath, JSON.stringify(entry));
    this.maybeCrash(seq);
    this.applyToIndex(entry);
    this.writeIndex();
    return seq;
  }

  maybeCrash(seq) {
    if (this.crashAt !== seq) return;
    const msg = `E_CRASH: simulated crash after POST seq=${seq} written to disk, before index update`;
    if (this.crashMode === 'throw') throw new JeError('E_CRASH', msg);
    process.stderr.write(msg + '\n');
    process.exit(EXIT_CRASH);
  }

  // WAL point 3: after END_BATCH.
  endBatch(id) {
    this.index.batches[id] = 'POSTED';
    this.writeIndex();
    this.wal({ t: 'END_BATCH', batch: id });
  }

  applyToIndex(entry) {
    for (const leg of entry.legs) {
      const signed = leg.side === 'dr' ? leg.amount : -leg.amount;
      this.index.balances[leg.account] = (this.index.balances[leg.account] || 0) + signed;
    }
    this.index.lastSeq = entry.seq;
  }
}

function recover(dir) {
  if (!fs.existsSync(dir)) {
    throw new JeError('E_IO', `db directory '${dir}' does not exist`);
  }
  const tmp = path.join(dir, 'index.json.tmp');
  if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

  const wal = readJsonLines(path.join(dir, 'wal.log'));
  const postings = readJsonLines(path.join(dir, 'postings.jsonl'));

  postings.forEach((p, i) => {
    if (p.seq !== i + 1) {
      throw new JeError('E_REPLAY', `posting sequence gap: expected seq=${i + 1}, found seq=${p.seq}`);
    }
  });

  const walPosts = new Map();
  const begins = [];
  const ends = new Set();
  for (const rec of wal) {
    if (rec.t === 'BEGIN_BATCH') begins.push(rec.batch);
    else if (rec.t === 'END_BATCH') ends.add(rec.batch);
    else if (rec.t === 'POST') walPosts.set(rec.seq, rec);
  }

  for (const p of postings) {
    const w = walPosts.get(p.seq);
    if (!w) {
      throw new JeError('E_REPLAY', `posting seq=${p.seq} has no matching WAL POST record`);
    }
    if (canonStr({ seq: w.seq, batch: w.batch, legs: w.legs }) !== canonStr(p)) {
      throw new JeError('E_REPLAY', `posting seq=${p.seq} does not match its WAL record`);
    }
  }

  const indexPath = path.join(dir, 'index.json');
  const index = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    : freshIndex();

  const replayed = [];
  const db = Object.create(Db.prototype);
  db.index = index;
  for (const p of postings) {
    if (p.seq > index.lastSeq) {
      db.applyToIndex(p);
      replayed.push(p.seq);
    }
  }

  // A begun-but-never-ended batch is IN_FLIGHT, never a failure.
  for (const b of begins) {
    if (!ends.has(b)) index.batches[b] = 'IN_FLIGHT';
  }

  db.indexPath = indexPath;
  db.writeIndex();

  return { replayed, batches: index.batches, balances: index.balances, lastSeq: index.lastSeq };
}

module.exports = { Db, recover, canonStr };
