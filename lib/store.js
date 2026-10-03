'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { LedgerError, CrashError, crossDay, recoverAmbiguous } = require('./errors');
const { applyPlan } = require('./plan');

const FILES = {
  head: 'HEAD',
  snapshot: 'snapshot.json',
  snapshotTmp: 'snapshot.json.tmp',
  wal: 'wal.jsonl',
  walArchived: 'wal.jsonl.archived',
  walTmp: 'wal.jsonl.tmp',
};

const CRASH_POINTS = ['before-fsync', 'before-wal-rename', 'after-head-update'];

const p = (dir, f) => path.join(dir, f);

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJsonDurable(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  fsyncFile(file);
}

// --- snapshot encoding: payload line + sha256 trailer; a staged snapshot is
// only trustworthy when the trailer verifies ---

function encodeSnapshot(obj) {
  const payload = JSON.stringify(obj);
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  return `${payload}\nsha256:${sha}\n`;
}

function decodeSnapshot(text) {
  const idx = text.lastIndexOf('\nsha256:');
  if (idx <= 0) return null;
  const payload = text.slice(0, idx);
  const sha = text.slice(idx + '\nsha256:'.length).trim();
  const expect = crypto.createHash('sha256').update(payload).digest('hex');
  if (sha !== expect) return null;
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!obj || typeof obj.date !== 'string' || !Number.isInteger(obj.gen) || !Array.isArray(obj.entries)) {
    return null;
  }
  return obj;
}

// --- raw file probes ---

function fileInfo(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, empty: st.size === 0 };
  } catch {
    return { exists: false, empty: true };
  }
}

function readSnapshotFile(file) {
  const info = fileInfo(file);
  if (!info.exists) return { kind: 'missing', data: null };
  let data = null;
  try {
    data = decodeSnapshot(fs.readFileSync(file, 'utf8'));
  } catch {
    data = null;
  }
  return data ? { kind: 'valid', data } : { kind: 'invalid', data: null };
}

function readHeadRaw(dir) {
  const file = p(dir, FILES.head);
  if (!fileInfo(file).exists) return { kind: 'missing', data: null };
  let obj = null;
  try {
    obj = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    obj = null;
  }
  const ok =
    obj &&
    typeof obj.date === 'string' &&
    (obj.state === 'open' || obj.state === 'committed') &&
    Number.isInteger(obj.gen);
  return ok ? { kind: 'ok', data: obj } : { kind: 'corrupt', data: null };
}

function readWalEntries(dir) {
  const file = p(dir, FILES.wal);
  if (!fileInfo(file).exists) return [];
  const text = fs.readFileSync(file, 'utf8');
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.op !== 'add' || !rec.entry) {
      throw new LedgerError('E_STATE', 2, `wal: unknown record op ${rec.op}`);
    }
    entries.push(rec.entry);
  }
  return entries;
}

function serializeWal(entries) {
  if (entries.length === 0) return '';
  return entries.map((e) => JSON.stringify({ op: 'add', entry: e })).join('\n') + '\n';
}

function replaceWal(dir, entries) {
  const tmp = p(dir, FILES.walTmp);
  fs.writeFileSync(tmp, serializeWal(entries));
  fsyncFile(tmp);
  fs.renameSync(tmp, p(dir, FILES.wal));
  fsyncDir(dir);
}

function mustOpenHead(dir) {
  const head = readHeadRaw(dir);
  if (head.kind !== 'ok') throw new LedgerError('E_STATE', 2, 'no day begun (HEAD missing or corrupt)');
  if (head.data.state !== 'open') {
    throw new LedgerError('E_STATE', 2, `day ${head.data.date} is already committed`);
  }
  return head.data;
}

// --- public API ---

function begin(dir, date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new LedgerError('E_USAGE', 2, 'date must be YYYY-MM-DD');
  }
  fs.mkdirSync(dir, { recursive: true });
  const head = readHeadRaw(dir);
  if (head.kind === 'ok' && head.data.state === 'open') {
    throw new LedgerError('E_STATE', 2, `day ${head.data.date} already open`);
  }
  const gen = head.kind === 'ok' ? head.data.gen : 0;
  // wal first, HEAD last: a crash mid-begin leaves the old committed state intact
  fs.writeFileSync(p(dir, FILES.wal), '');
  fsyncFile(p(dir, FILES.wal));
  writeJsonDurable(p(dir, FILES.head), { date, state: 'open', gen });
  fsyncDir(dir);
  return { date, gen };
}

function validateEntry(entry, existingIds) {
  const bad = (msg) => new LedgerError('E_ENTRY', 2, msg);
  if (!entry || typeof entry !== 'object') throw bad('entry must be an object');
  if (typeof entry.id !== 'string' || entry.id === '') throw bad('entry.id must be a non-empty string');
  if (existingIds.has(entry.id)) throw bad(`duplicate entry id ${entry.id}`);
  if (typeof entry.account !== 'string' || entry.account === '') throw bad('entry.account must be a non-empty string');
  if (!Number.isSafeInteger(entry.amount)) throw bad('entry.amount must be a safe integer');
  const type = entry.type === undefined ? 'NORMAL' : entry.type;
  if (type !== 'NORMAL' && type !== 'REVERSAL') throw bad(`unknown entry type ${type}`);
  if (type === 'REVERSAL') {
    if (typeof entry.refId !== 'string' || !existingIds.has(entry.refId)) {
      throw bad(`REVERSAL ${entry.id} must reference an existing entry`);
    }
  }
  return { ...entry, type };
}

function add(dir, entry) {
  mustOpenHead(dir);
  const entries = readWalEntries(dir);
  const normalized = validateEntry(entry, new Set(entries.map((e) => e.id)));
  const file = p(dir, FILES.wal);
  fs.appendFileSync(file, JSON.stringify({ op: 'add', entry: normalized }) + '\n');
  fsyncFile(file);
  return normalized;
}

function rewrite(dir, plan) {
  const head = readHeadRaw(dir);
  if (head.kind !== 'ok' || head.data.state !== 'open') {
    throw crossDay('rewrite requires the current day to be open (uncommitted)');
  }
  if (!plan || plan.date !== head.data.date) {
    throw crossDay(`plan targets date ${plan && plan.date} but open day is ${head.data.date}`);
  }
  const entries = readWalEntries(dir);
  const next = applyPlan(entries, plan);
  replaceWal(dir, next);
  return next;
}

function commit(dir, opts = {}) {
  const crashAt = opts.crashAt || null;
  if (crashAt && !CRASH_POINTS.includes(crashAt)) {
    throw new LedgerError('E_USAGE', 2, `unknown crash point ${crashAt}`);
  }
  const head = mustOpenHead(dir);
  const entries = readWalEntries(dir);
  const snapshot = { date: head.date, gen: head.gen + 1, entries };

  const tmpFile = p(dir, FILES.snapshotTmp);
  fs.writeFileSync(tmpFile, encodeSnapshot(snapshot));
  if (crashAt === 'before-fsync') {
    // simulate the OS discarding the un-fsynced tail of the staged snapshot
    const fd = fs.openSync(tmpFile, 'r+');
    const size = fs.fstatSync(fd).size;
    fs.ftruncateSync(fd, Math.floor(size / 2));
    fs.closeSync(fd);
    fsyncDir(dir);
    throw new CrashError(crashAt);
  }
  fsyncFile(tmpFile);
  fsyncDir(dir);

  if (crashAt === 'before-wal-rename') throw new CrashError(crashAt);
  fs.renameSync(p(dir, FILES.wal), p(dir, FILES.walArchived));
  fsyncDir(dir);

  fs.renameSync(tmpFile, p(dir, FILES.snapshot));
  fsyncDir(dir);

  writeJsonDurable(p(dir, FILES.head), { date: head.date, state: 'committed', gen: head.gen + 1 });
  fsyncDir(dir);
  if (crashAt === 'after-head-update') throw new CrashError(crashAt);

  fs.rmSync(p(dir, FILES.walArchived), { force: true });
  fsyncDir(dir);
  return snapshot;
}

// --- recovery classification ---

function classify(dir) {
  const probe = {
    head: readHeadRaw(dir),
    snapshot: readSnapshotFile(p(dir, FILES.snapshot)),
    tmp: readSnapshotFile(p(dir, FILES.snapshotTmp)),
    wal: fileInfo(p(dir, FILES.wal)),
    archived: fileInfo(p(dir, FILES.walArchived)),
  };
  const amb = (why, evidence) => {
    throw recoverAmbiguous(`${why} (evidence: ${evidence.join(', ') || 'none'})`);
  };

  if (probe.head.kind === 'corrupt') amb('HEAD is corrupt', [FILES.head]);
  if (probe.head.kind === 'missing') {
    const pending =
      probe.tmp.kind !== 'missing' || probe.archived.exists || (probe.wal.exists && !probe.wal.empty);
    if (probe.snapshot.kind === 'invalid') {
      amb('snapshot.json is invalid and HEAD is missing', [FILES.snapshot]);
    }
    if (!pending) {
      return {
        status: 'OLD_COMMITTED',
        evidence: probe.snapshot.kind === 'valid' ? [FILES.snapshot] : [],
      };
    }
    amb('HEAD missing with pending commit artifacts', [
      ...(probe.tmp.kind !== 'missing' ? [FILES.snapshotTmp] : []),
      ...(probe.archived.exists ? [FILES.walArchived] : []),
      ...(probe.wal.exists && !probe.wal.empty ? [FILES.wal] : []),
    ]);
  }

  const head = probe.head.data;
  if (head.state === 'committed') {
    if (probe.snapshot.kind !== 'valid') {
      amb('HEAD committed but snapshot.json missing or invalid', [FILES.head, FILES.snapshot]);
    }
    if (probe.tmp.kind !== 'missing') {
      amb('HEAD committed but staged snapshot.json.tmp exists', [FILES.head, FILES.snapshotTmp]);
    }
    if (probe.wal.exists && !probe.wal.empty) {
      amb('HEAD committed but wal.jsonl has entries', [FILES.head, FILES.wal]);
    }
    return { status: 'COMMITTED_NEW', evidence: [FILES.head, FILES.snapshot] };
  }

  // head.state === 'open'
  if (probe.tmp.kind === 'valid') {
    return { status: 'OPEN_NEW', evidence: [FILES.snapshotTmp] };
  }
  if (probe.tmp.kind === 'invalid') {
    if (probe.wal.exists) return { status: 'OPEN_OLD', evidence: [FILES.wal] };
    amb('staged snapshot torn and wal.jsonl missing', [FILES.snapshotTmp]);
  }
  if (probe.wal.exists && probe.archived.exists) {
    amb('both wal.jsonl and wal.jsonl.archived exist', [FILES.wal, FILES.walArchived]);
  }
  if (probe.wal.exists) return { status: 'OPEN_OLD', evidence: [FILES.wal] };
  if (probe.archived.exists) {
    amb('wal archived but no staged snapshot and HEAD still open', [FILES.walArchived, FILES.head]);
  }
  return { status: 'OPEN_OLD', evidence: [FILES.head] };
}

function recover(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const c = classify(dir); // throws E_RECOVER_AMBIGUOUS when undecidable
  const rm = (f) => fs.rmSync(p(dir, f), { force: true });
  switch (c.status) {
    case 'OPEN_OLD': {
      rm(FILES.snapshotTmp);
      rm(FILES.walTmp);
      if (!fileInfo(p(dir, FILES.wal)).exists) fs.writeFileSync(p(dir, FILES.wal), '');
      break;
    }
    case 'OPEN_NEW': {
      // the durable staged snapshot is the newest definite version: adopt its
      // entries as the open day's wal and drop the superseded archived wal
      const staged = readSnapshotFile(p(dir, FILES.snapshotTmp)).data;
      replaceWal(dir, staged.entries);
      rm(FILES.snapshotTmp);
      rm(FILES.walArchived);
      break;
    }
    case 'COMMITTED_NEW': {
      rm(FILES.walArchived);
      rm(FILES.walTmp);
      if (fileInfo(p(dir, FILES.wal)).exists && fileInfo(p(dir, FILES.wal)).empty) rm(FILES.wal);
      break;
    }
    case 'OLD_COMMITTED': {
      rm(FILES.walTmp);
      if (fileInfo(p(dir, FILES.wal)).exists && fileInfo(p(dir, FILES.wal)).empty) rm(FILES.wal);
      break;
    }
  }
  fsyncDir(dir);
  return c;
}

function status(dir) {
  if (!fs.existsSync(dir)) return { status: 'OLD_COMMITTED', evidence: [] };
  return classify(dir);
}

module.exports = {
  FILES,
  CRASH_POINTS,
  begin,
  add,
  rewrite,
  commit,
  recover,
  status,
  classify,
  readWalEntries,
  encodeSnapshot,
  decodeSnapshot,
};
