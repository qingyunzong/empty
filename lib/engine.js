import fs from 'node:fs';
import path from 'node:path';
import { FeeError, ERR_INVALID_INPUT, ERR_TIME_REVERSED } from './errors.js';
import { parseTime, readNdjson, appendLinesFsync, writeJsonAtomic, sha256 } from './util.js';
import { RuleStore, computeFee } from './rules.js';

const JOURNAL_FILE = 'settled.ndjson';
const CHECKPOINT_FILE = 'checkpoint.json';

function journalPath(stateDir) {
  return path.join(stateDir, JOURNAL_FILE);
}

function checkpointPath(stateDir) {
  return path.join(stateDir, CHECKPOINT_FILE);
}

export function loadCheckpoint(stateDir) {
  const p = checkpointPath(stateDir);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Rebuilds the settled-fee map from the append-only journal.
// Last record per txId wins, so replaying after a crash is idempotent:
// re-applied records simply overwrite their identical predecessors.
export function loadSettled(stateDir) {
  const records = readNdjson(journalPath(stateDir));
  const settled = new Map();
  let journalLines = 0;
  for (const rec of records) {
    journalLines++;
    settled.set(rec.txId, rec);
  }
  return { settled, journalLines };
}

function buildRuleStore(rulesLines, fromIndex, lastRuleTime) {
  const store = new RuleStore();
  let last = lastRuleTime;
  for (let i = 0; i < rulesLines.length; i++) {
    const eventTime = store.apply(rulesLines[i], i + 1);
    if (i >= fromIndex) {
      if (last !== null && eventTime < last) {
        throw new FeeError(
          ERR_TIME_REVERSED,
          `rules line ${i + 1}: event time ${eventTime} goes backwards (last processed ${last})`,
        );
      }
      last = eventTime;
    }
  }
  return { store, lastRuleTime: last };
}

function validateTx(tx, lineNo) {
  const where = `tx line ${lineNo}`;
  if (!tx || typeof tx !== 'object' || Array.isArray(tx)) {
    throw new FeeError(ERR_INVALID_INPUT, `${where}: expected an object`);
  }
  if (typeof tx.txId !== 'string' || tx.txId.length === 0) {
    throw new FeeError(ERR_INVALID_INPUT, `${where}: txId must be a non-empty string`);
  }
  if (!Number.isInteger(tx.amount) || tx.amount < 0) {
    throw new FeeError(ERR_INVALID_INPUT, `${where}: amount must be a non-negative integer (minor units)`);
  }
  if (tx.time === undefined || tx.time === null) {
    throw new FeeError(ERR_INVALID_INPUT, `${where}: missing "time"`);
  }
  return parseTime(tx.time, `${where} time`);
}

function feeRecord(store, tx, t, seq, backfill) {
  const res = store.resolve(t);
  return {
    seq,
    txId: tx.txId,
    time: t,
    amount: tx.amount,
    rateBps: res.bestRateBps,
    ruleId: res.selected ? res.selected.ruleId : null,
    fee: computeFee(tx.amount, res.bestRateBps),
    tied: res.tied.map((x) => x.ruleId),
    backfill,
  };
}

function sameRecord(a, b) {
  return (
    a.txId === b.txId &&
    a.time === b.time &&
    a.amount === b.amount &&
    a.rateBps === b.rateBps &&
    a.ruleId === b.ruleId &&
    a.fee === b.fee &&
    a.backfill === b.backfill &&
    JSON.stringify(a.tied) === JSON.stringify(b.tied)
  );
}

// Consumes new rule ops and new tx lines, appends fee records to the journal
// (fsync) and only then persists the checkpoint (atomic rename). A crash
// between the two is safe: the next sync replays the same lines and the
// txId-keyed journal makes re-application idempotent, so backfilled
// transactions are neither skipped nor duplicated.
export function sync({ rulesPath, txPath, stateDir, hooks = {} }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const prev = loadCheckpoint(stateDir);
  const rp = rulesPath ?? prev?.rulesPath;
  const tp = txPath ?? prev?.txPath;
  if (!rp || !tp) {
    throw new FeeError(ERR_INVALID_INPUT, 'sync requires --rules and --tx (no checkpoint to inherit them from)');
  }
  rulesPath = path.resolve(rp);
  txPath = path.resolve(tp);
  if (!fs.existsSync(rulesPath)) throw new FeeError(ERR_INVALID_INPUT, `rules file not found: ${rulesPath}`);
  if (!fs.existsSync(txPath)) throw new FeeError(ERR_INVALID_INPUT, `tx file not found: ${txPath}`);

  const { settled } = loadSettled(stateDir);
  const rulesOffset = prev?.rulesOffset ?? 0;
  const txOffset = prev?.txOffset ?? 0;
  let seq = prev?.seq ?? 0;

  const rulesLines = readNdjson(rulesPath);
  const { store, lastRuleTime } = buildRuleStore(rulesLines, rulesOffset, prev?.lastRuleTime ?? null);

  const txLines = readNdjson(txPath);
  let lastTxTime = prev?.lastTxTime ?? null;
  const newRecords = [];
  let consumed = 0;
  let replayed = 0;
  let corrections = 0;
  for (let i = txOffset; i < txLines.length; i++) {
    const tx = txLines[i];
    const t = validateTx(tx, i + 1);
    const backfill = tx.backfill === true;
    consumed++;
    const rec = feeRecord(store, tx, t, seq + 1, backfill);
    const existing = settled.get(tx.txId);
    // Idempotent replay: a line that reproduces the already-journaled record
    // exactly (e.g. reprocessed after a crash before the checkpoint write) is
    // skipped, so recovery never duplicates transactions.
    if (existing && sameRecord(existing, rec)) {
      replayed++;
      continue;
    }
    if (!backfill) {
      if (lastTxTime !== null && t < lastTxTime) {
        throw new FeeError(
          ERR_TIME_REVERSED,
          `tx line ${i + 1}: time ${t} goes backwards (last processed ${lastTxTime}); mark legitimate late arrivals with "backfill": true`,
        );
      }
      if (existing) {
        throw new FeeError(
          ERR_TIME_REVERSED,
          `tx line ${i + 1}: duplicate txId "${tx.txId}" without "backfill": true`,
        );
      }
    }
    if (backfill && existing) corrections++;
    seq++;
    settled.set(tx.txId, rec);
    newRecords.push(rec);
    if (!backfill) lastTxTime = t;
  }

  appendLinesFsync(journalPath(stateDir), newRecords);

  // Crash hook: runs after the journal is durable but before the checkpoint
  // is written. Tests inject hooks.afterJournal to simulate a kill here;
  // the env var performs a real SIGKILL for manual CLI fault injection.
  hooks.afterJournal?.();
  if (process.env.SYNC_CRASH_AFTER_JOURNAL) {
    process.kill(process.pid, 'SIGKILL');
  }

  const checkpoint = {
    version: 1,
    rulesPath,
    txPath,
    rulesOffset: rulesLines.length,
    txOffset: txLines.length,
    lastRuleTime,
    lastTxTime,
    seq,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(checkpointPath(stateDir), checkpoint);

  return {
    consumed,
    appended: newRecords.length,
    replayed,
    corrections,
    settledCount: settled.size,
    rulesCount: store.size,
    checkpoint,
  };
}

function recordLine(r) {
  return [r.txId, r.time, r.amount, r.rateBps, r.ruleId ?? '-', r.fee].join('|');
}

function hashRecords(recs) {
  return sha256(recs.map(recordLine).join('\n') + '\n');
}

function sortRecords(recs) {
  return recs.sort((a, b) => a.time - b.time || (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));
}

function inInterval(r, from, to) {
  return (from === null || r.time >= from) && (to === null || r.time < to);
}

// Recomputes fees for [from, to) straight from the source files (full replay
// of that interval) and compares against the incrementally maintained journal.
export function verify({ stateDir, from = null, to = null, rulesPath = null, txPath = null }) {
  const checkpoint = loadCheckpoint(stateDir);
  if (!checkpoint) throw new FeeError(ERR_INVALID_INPUT, `no checkpoint in ${stateDir}; run sync first`);
  rulesPath = path.resolve(rulesPath ?? checkpoint.rulesPath);
  txPath = path.resolve(txPath ?? checkpoint.txPath);
  const fromT = from === null ? null : parseTime(from, 'from');
  const toT = to === null ? null : parseTime(to, 'to');
  if (fromT !== null && toT !== null && toT <= fromT) {
    throw new FeeError(ERR_INVALID_INPUT, `to must be after from`);
  }

  const { settled } = loadSettled(stateDir);
  const settledRecs = sortRecords([...settled.values()].filter((r) => inInterval(r, fromT, toT)));

  const rulesLines = readNdjson(rulesPath);
  const { store } = buildRuleStore(rulesLines, rulesLines.length, null);
  const txLines = readNdjson(txPath);
  const latest = new Map();
  for (let i = 0; i < txLines.length; i++) {
    const tx = txLines[i];
    const t = validateTx(tx, i + 1);
    latest.set(tx.txId, { tx, t });
  }
  const replayRecs = sortRecords(
    [...latest.values()]
      .filter(({ t }) => inInterval({ time: t }, fromT, toT))
      .map(({ tx, t }) => feeRecord(store, tx, t, 0, tx.backfill === true)),
  );

  const settledHash = hashRecords(settledRecs);
  const replayHash = hashRecords(replayRecs);
  const totalFee = settledRecs.reduce((sum, r) => sum + r.fee, 0);
  return {
    from: fromT,
    to: toT,
    count: settledRecs.length,
    totalFee,
    settledHash,
    replayHash,
    match: settledHash === replayHash && settledRecs.length === replayRecs.length,
  };
}

// Explains the fee for one transaction: all candidate rules, every rule tied
// for the best rate, and the deterministic tie-break that selected the winner.
export function explainFee({ stateDir, txId = null, time = null, amount = null, rulesPath = null, txPath = null }) {
  const checkpoint = loadCheckpoint(stateDir);
  if (!checkpoint) throw new FeeError(ERR_INVALID_INPUT, `no checkpoint in ${stateDir}; run sync first`);
  rulesPath = path.resolve(rulesPath ?? checkpoint.rulesPath);
  txPath = path.resolve(txPath ?? checkpoint.txPath);
  const rulesLines = readNdjson(rulesPath);
  const { store } = buildRuleStore(rulesLines, rulesLines.length, null);

  let tx = null;
  if (txId !== null) {
    const txLines = readNdjson(txPath);
    for (const line of txLines) {
      if (line && line.txId === txId) tx = line; // last occurrence wins (backfill corrections)
    }
    if (!tx) throw new FeeError(ERR_INVALID_INPUT, `txId not found: ${txId}`);
  } else {
    if (time === null || amount === null) {
      throw new FeeError(ERR_INVALID_INPUT, `fee requires --txId or both --time and --amount`);
    }
    tx = { txId: '(ad-hoc)', time, amount };
  }
  const t = validateTx(tx, '-');
  if (!Number.isInteger(tx.amount) || tx.amount < 0) {
    throw new FeeError(ERR_INVALID_INPUT, `amount must be a non-negative integer (minor units)`);
  }
  const res = store.resolve(t);
  return {
    txId: tx.txId,
    time: t,
    amount: tx.amount,
    candidates: res.candidates,
    bestRateBps: res.bestRateBps,
    tied: res.tied,
    selected: res.selected,
    reason: res.reason,
    fee: computeFee(tx.amount, res.bestRateBps),
  };
}
