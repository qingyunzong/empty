'use strict';

const fs = require('node:fs');
const { ERR } = require('./core');
const { Ledger } = require('./ledger');

class CrashError extends Error {
  constructor(point) {
    super(`simulated crash: ${point}`);
    this.crashPoint = point;
  }
}

function corrupt(message) {
  const err = new Error(`CORRUPT_JOURNAL: ${message}`);
  err.code = ERR.CORRUPT_JOURNAL;
  return err;
}

// Append-only journal. Per applied event the write protocol is:
//   1. event record
//   2. snapshot record (full ledger state after the event)
//   3. head record (consistency marker)
// Fault points: crashAfter 'none' | 'event' | 'snapshot'.
class JournalWriter {
  constructor(path) {
    this.path = path;
    this.seq = 0;
    fs.writeFileSync(path, '');
  }

  append(ledger, event, opts = {}) {
    const seq = this.seq + 1;
    const lines = [
      JSON.stringify({ kind: 'event', seq, event }),
      JSON.stringify({ kind: 'snapshot', seq, state: ledger.serialize() }),
      JSON.stringify({ kind: 'head', seq, id: event.id }),
    ];
    const crashAfter = opts.crashAfter;
    let count = 3;
    if (crashAfter === 'none') count = 0;
    else if (crashAfter === 'event') count = 1;
    else if (crashAfter === 'snapshot') count = 2;
    if (count > 0) fs.appendFileSync(this.path, lines.slice(0, count).join('\n') + '\n');
    if (count < 3) throw new CrashError(crashAfter || 'none');
    this.seq = seq;
    return seq;
  }
}

// Recover to the most recent consistent head. A torn final line (crash
// mid-write) is truncated; corruption anywhere else is CORRUPT_JOURNAL.
// Events past the last head are in-flight and discarded. Duplicate event
// ids are applied at most once (idempotent replay).
function recover(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1) break; // torn tail write
      throw corrupt(`unparseable record at line ${i + 1}`);
    }
  }

  let lastHeadIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== 'object' || !['event', 'snapshot', 'head'].includes(r.kind)
        || !Number.isInteger(r.seq) || r.seq < 1) {
      throw corrupt(`invalid record at line ${i + 1}`);
    }
    if (r.kind === 'head') lastHeadIdx = i;
  }

  if (lastHeadIdx === -1) return { ledger: new Ledger(), seq: 0 };
  const headSeq = records[lastHeadIdx].seq;

  for (let i = lastHeadIdx - 1; i >= 0; i--) {
    if (records[i].kind === 'snapshot' && records[i].seq === headSeq) {
      return { ledger: Ledger.restore(records[i].state), seq: headSeq };
    }
  }

  const events = records
    .filter((r) => r.kind === 'event' && r.seq <= headSeq)
    .sort((a, b) => a.seq - b.seq);
  const seqToId = new Map();
  for (const r of events) {
    if (!r.event || !r.event.id || !r.event.type || !r.event.account) {
      throw corrupt(`bad event record at seq ${r.seq}`);
    }
    if (seqToId.has(r.seq) && seqToId.get(r.seq) !== r.event.id) {
      throw corrupt(`conflicting events at seq ${r.seq}`);
    }
    seqToId.set(r.seq, r.event.id);
  }
  for (let s = 1; s <= headSeq; s++) {
    if (!seqToId.has(s)) throw corrupt(`missing event seq ${s}`);
  }

  const ledger = new Ledger();
  for (const r of events) ledger.apply(r.event); // duplicate ids skipped
  return { ledger, seq: headSeq };
}

module.exports = { JournalWriter, CrashError, recover };
