'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { sha256, canonical, atomicWriteSync, readJson, LedgerError } = require('./util');
const { readJournal } = require('./journal');

const DEFAULT_BATCH = 500;

function statePaths(dir) {
  return {
    snapshot: path.join(dir, 'snapshot.json'),
    changeset: path.join(dir, 'changeset.ndjson'),
    meta: path.join(dir, 'changeset.meta.json'),
    db: path.join(dir, 'db.json'),
    checkpoint: path.join(dir, 'checkpoint.json'),
    cert: path.join(dir, 'cert.json'),
  };
}

function freshDb() {
  return {
    accounts: {},
    txns: {},
    undone: {},
    conflicts: [],
    applied: {},
    progress: { changesetId: null, appliedSeq: 0, batch: 0 },
  };
}

function adjustBalance(db, account, delta) {
  const next = (db.accounts[account] || 0) + delta;
  if (!Number.isInteger(next)) {
    throw new LedgerError('bad-amount', 'non-integer balance for account ' + account, { account });
  }
  if (next < 0) {
    throw new LedgerError('negative-balance', 'balance of ' + account + ' would become ' + next, { account, balance: next });
  }
  db.accounts[account] = next;
}

function addConflict(db, row, target, reason) {
  db.conflicts.push({ row: row.id, target, reason });
}

// 同一事务键后写覆盖前写；撤销事件可回指；重复撤销只生效一次并留冲突标记。
function applyRow(db, row) {
  if (row.undo !== undefined) {
    const target = row.undo;
    if (db.undone[target]) {
      addConflict(db, row, target, 'duplicate-undo');
      return;
    }
    const txn = db.txns[target];
    if (!txn) {
      addConflict(db, row, target, 'unknown-txn');
      return;
    }
    adjustBalance(db, txn.account, -txn.amount_cents);
    delete db.txns[target];
    db.undone[target] = { by: row.id, account: txn.account, amount_cents: txn.amount_cents };
    return;
  }
  const existing = db.txns[row.id];
  if (existing) {
    adjustBalance(db, existing.account, -existing.amount_cents);
  } else if (db.undone[row.id]) {
    addConflict(db, row, row.id, 'reuse-after-undo');
    return;
  }
  db.txns[row.id] = { account: row.account, amount_cents: row.amount_cents };
  adjustBalance(db, row.account, row.amount_cents);
}

function reverseRow(db, row) {
  if (row.undo !== undefined) {
    const u = db.undone[row.undo];
    if (u && u.by === row.id) {
      db.txns[row.undo] = { account: u.account, amount_cents: u.amount_cents };
      adjustBalance(db, u.account, u.amount_cents);
      delete db.undone[row.undo];
    }
    return;
  }
  const txn = db.txns[row.id];
  if (txn && txn.account === row.account && txn.amount_cents === row.amount_cents) {
    adjustBalance(db, txn.account, -txn.amount_cents);
    delete db.txns[row.id];
  } else {
    addConflict(db, row, row.id, 'stale-reverse');
  }
}

function applyEvent(db, uid, ev) {
  if (db.applied[uid]) return false;
  if (ev.op === 'add') applyRow(db, ev.row);
  else if (ev.op === 'delete') reverseRow(db, ev.row);
  else if (ev.op === 'modify') {
    reverseRow(db, ev.oldRow);
    applyRow(db, ev.row);
  }
  db.applied[uid] = 1;
  return true;
}

function scan({ journal, dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const P = statePaths(dir);
  const lines = readJournal(journal);
  if (fs.existsSync(P.meta) && fs.existsSync(P.checkpoint)) {
    const meta = readJson(P.meta);
    const ck = readJson(P.checkpoint);
    if (ck.changesetId === meta.id && ck.committedSeq < meta.count) {
      throw new LedgerError('pending-changeset', 'previous changeset not fully applied; run apply/resume first', {
        committedSeq: ck.committedSeq,
        count: meta.count,
      });
    }
  }
  const prev = fs.existsSync(P.snapshot) ? readJson(P.snapshot) : { lines: [] };
  const events = [];
  const n = Math.max(prev.lines.length, lines.length);
  for (let i = 0; i < n; i++) {
    const o = prev.lines[i];
    const c = lines[i];
    if (o && c && o.hash !== c.hash) {
      events.push({ seq: events.length + 1, op: 'modify', line: i + 1, hash: c.hash, row: c.row, oldRow: o.row });
    } else if (!o && c) {
      events.push({ seq: events.length + 1, op: 'add', line: i + 1, hash: c.hash, row: c.row });
    } else if (o && !c) {
      events.push({ seq: events.length + 1, op: 'delete', line: i + 1, hash: o.hash, row: o.row });
    }
  }
  const id = sha256(canonical(events.map((e) => [e.op, e.line, e.hash])));
  const journalHash = sha256(lines.map((l) => l.hash).join('\n'));
  let rowHash = 'genesis';
  if (fs.existsSync(P.checkpoint)) rowHash = readJson(P.checkpoint).rowHash;
  atomicWriteSync(P.changeset, events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  atomicWriteSync(P.meta, JSON.stringify({ id, count: events.length, journalHash }, null, 2) + '\n');
  atomicWriteSync(P.snapshot, JSON.stringify({ lines: lines.map((l) => ({ hash: l.hash, row: l.row })) }));
  atomicWriteSync(P.checkpoint, JSON.stringify({ changesetId: id, batch: 0, committedSeq: 0, rowHash, journalHash }, null, 2) + '\n');
  return { changesetId: id, events: events.length, journalHash };
}

function loadEvents(P) {
  if (!fs.existsSync(P.changeset)) {
    throw new LedgerError('missing-changeset', 'no changeset found; run scan first', { file: P.changeset });
  }
  const text = fs.readFileSync(P.changeset, 'utf8');
  return text.split('\n').filter((s) => s.length > 0).map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new LedgerError('bad-json', 'changeset line ' + (i + 1) + ' is not valid JSON', { line: i + 1 });
    }
  });
}

function maybeCrash(point) {
  if (process.env.LEDGER_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return sha256('');
  let level = leaves.slice();
  while (level.length > 1) {
    if (level.length % 2 === 1) level.push(level[level.length - 1]);
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256(level[i] + level[i + 1]));
    level = next;
  }
  return level[0];
}

function buildCert({ journal, dir, lines }) {
  const P = statePaths(dir);
  if (!fs.existsSync(P.meta)) throw new LedgerError('missing-changeset', 'no changeset found; run scan first', { file: P.meta });
  const meta = readJson(P.meta);
  const ck = readJson(P.checkpoint);
  if (ck.committedSeq < meta.count) {
    throw new LedgerError('uncommitted-changes', 'changeset not fully committed; run apply/resume first', {
      committedSeq: ck.committedSeq,
      count: meta.count,
    });
  }
  const journalLines = lines || readJournal(journal);
  const journalHash = sha256(journalLines.map((l) => l.hash).join('\n'));
  if (journalHash !== ck.journalHash) {
    throw new LedgerError('bad-hash', 'journal changed since scan; cannot certify', {
      expected: ck.journalHash,
      actual: journalHash,
    });
  }
  const cert = {
    merkleRoot: merkleRoot(journalLines.map((l) => l.hash)),
    from: journalLines.length ? 1 : 0,
    to: journalLines.length,
    batches: ck.batch,
    committedSeq: ck.committedSeq,
    rowHash: ck.rowHash,
    changesetId: ck.changesetId,
  };
  atomicWriteSync(P.cert, JSON.stringify(cert, null, 2) + '\n');
  return cert;
}

function execute({ journal, dir, batchSize }) {
  const size = batchSize || DEFAULT_BATCH;
  const P = statePaths(dir);
  if (!fs.existsSync(P.meta)) throw new LedgerError('missing-changeset', 'no changeset found; run scan first', { file: P.meta });
  const meta = readJson(P.meta);
  const events = loadEvents(P);
  const lines = readJournal(journal);
  for (const ev of events) {
    if (ev.op === 'delete') continue;
    const jl = lines[ev.line - 1];
    if (!jl) {
      throw new LedgerError('missing-line', 'journal line ' + ev.line + ' referenced by changeset is missing', { line: ev.line });
    }
    if (jl.hash !== ev.hash) {
      throw new LedgerError('bad-hash', 'hash mismatch at journal line ' + ev.line, {
        line: ev.line,
        expected: ev.hash,
        actual: jl.hash,
      });
    }
  }
  const db = fs.existsSync(P.db) ? readJson(P.db) : freshDb();
  const ck = readJson(P.checkpoint);
  if (db.progress.changesetId !== meta.id) {
    db.progress = { changesetId: meta.id, appliedSeq: 0, batch: 0 };
  }
  const report = { changesetId: meta.id, redoneEvents: 0, appliedEvents: 0, batches: 0, committedSeq: 0, cert: null };

  // 崩溃点一：apply 写库后未写 checkpoint -> 未提交，可重做（事件幂等，重做安全）。
  if (db.progress.appliedSeq > ck.committedSeq) {
    for (let s = ck.committedSeq; s < db.progress.appliedSeq; s++) {
      const ev = events[s];
      applyEvent(db, meta.id + ':' + ev.seq, ev);
      ck.rowHash = sha256(ck.rowHash + ':' + ev.hash);
      report.redoneEvents++;
    }
    ck.committedSeq = db.progress.appliedSeq;
    ck.batch = db.progress.batch;
    atomicWriteSync(P.db, JSON.stringify(db));
    atomicWriteSync(P.checkpoint, JSON.stringify(ck, null, 2) + '\n');
  }

  while (ck.committedSeq < events.length) {
    const end = Math.min(events.length, ck.committedSeq + size);
    for (let s = ck.committedSeq; s < end; s++) {
      const ev = events[s];
      applyEvent(db, meta.id + ':' + ev.seq, ev);
      ck.rowHash = sha256(ck.rowHash + ':' + ev.hash);
      report.appliedEvents++;
    }
    db.progress = { changesetId: meta.id, appliedSeq: end, batch: ck.batch + 1 };
    atomicWriteSync(P.db, JSON.stringify(db));
    maybeCrash('db:' + (ck.batch + 1));
    ck.committedSeq = end;
    ck.batch += 1;
    atomicWriteSync(P.checkpoint, JSON.stringify(ck, null, 2) + '\n');
    maybeCrash('ckpt:' + ck.batch);
    report.batches++;
  }
  report.committedSeq = ck.committedSeq;

  // 崩溃点二：checkpoint 写后未写 cert -> 已提交，不重做，仅补发证书。
  maybeCrash('pre-cert');
  report.cert = buildCert({ journal, dir, lines });
  return report;
}

function replay(rows) {
  const db = freshDb();
  for (const row of rows) applyRow(db, row);
  return db;
}

module.exports = {
  DEFAULT_BATCH,
  statePaths,
  freshDb,
  adjustBalance,
  applyRow,
  reverseRow,
  applyEvent,
  scan,
  execute,
  buildCert,
  merkleRoot,
  replay,
};
