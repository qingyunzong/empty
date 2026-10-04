'use strict';

const { Ledger } = require('./ledger');
const { CODES, LedgerError } = require('./errors');

const FAULT_POINTS = Object.freeze(['beforeEvent', 'afterEvent', 'afterSnapshot']);

class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated crash at fault point: ${point}`);
    this.name = 'SimulatedCrash';
    this.point = point;
  }
}

// Append-only journal. Each successful event commit appends three records:
//   {type:'event'} -> {type:'snapshot'} -> {type:'head'}
// A failed event (LedgerError) is journaled as an event record only, so replay
// deterministically reproduces the failure. Crashes can be injected at the
// three defined fault points.
class Journal {
  constructor(ledger = new Ledger()) {
    this.ledger = ledger;
    this.records = [];
  }

  commit(event, options = {}) {
    const fault = options.fault;
    if (fault === 'beforeEvent') throw new SimulatedCrash(fault);
    let error = null;
    try {
      this.ledger.apply(event);
    } catch (err) {
      if (err instanceof LedgerError) error = err;
      else throw err;
    }
    this.records.push({ type: 'event', event });
    if (error) return { ok: false, error };
    if (fault === 'afterEvent') throw new SimulatedCrash(fault);
    this.records.push({ type: 'snapshot', state: this.ledger.snapshot() });
    if (fault === 'afterSnapshot') throw new SimulatedCrash(fault);
    this.records.push({ type: 'head', event: this.ledger.head });
    return { ok: true };
  }

  toJSONL() {
    return this.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

// Recover a ledger by replaying the journal up to the most recent consistent
// head. Events past the head are ignored; duplicate events are idempotent by
// id. With `repair`, an account driven into ERROR by a replayed event is
// immediately repaired so replay can continue.
function recover(lines, options = {}) {
  const repair = options.repair === true;
  const records = parseLines(lines);

  let headId = null;
  let headIndex = -1;
  records.forEach((rec, idx) => {
    if (!rec || (rec.type !== 'event' && rec.type !== 'snapshot' && rec.type !== 'head')) {
      throw new LedgerError(CODES.CORRUPT_JOURNAL, `invalid record at line ${idx + 1}`);
    }
    if (rec.type === 'event' && (!rec.event || typeof rec.event.id !== 'string')) {
      throw new LedgerError(CODES.CORRUPT_JOURNAL, `event record without id at line ${idx + 1}`);
    }
    if (rec.type === 'head') {
      headId = rec.event;
      headIndex = idx;
    }
  });

  const seen = new Map();
  for (const rec of records) {
    if (rec.type !== 'event') continue;
    const key = canonical(rec.event);
    if (seen.has(rec.event.id) && seen.get(rec.event.id) !== key) {
      throw new LedgerError(CODES.CORRUPT_JOURNAL, `conflicting duplicate event id ${rec.event.id}`);
    }
    seen.set(rec.event.id, key);
  }

  const ledger = new Ledger();
  const repairs = [];
  let ignored = 0;
  let headReached = headId === null;
  for (const rec of records) {
    if (rec.type !== 'event') continue;
    if (headReached) {
      ignored += 1;
      continue;
    }
    try {
      ledger.apply(rec.event);
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      if (repair) {
        const acct = ledger.getAccount(rec.event.account);
        if (acct && acct.state === 'ERROR') {
          ledger.apply({ id: `auto-repair:${rec.event.id}`, op: 'repair', account: rec.event.account });
          repairs.push(rec.event.id);
        }
      }
    }
    if (rec.event.id === headId) headReached = true;
  }
  if (!headReached) {
    throw new LedgerError(CODES.CORRUPT_JOURNAL, `head references unknown event ${headId}`);
  }

  if (repairs.length === 0) {
    let snapshot = null;
    for (let i = 0; i <= headIndex; i += 1) {
      if (records[i].type === 'snapshot') snapshot = records[i].state;
    }
    if (snapshot && canonical(snapshot) !== canonical(ledger.snapshot())) {
      throw new LedgerError(CODES.CORRUPT_JOURNAL, 'replayed state does not match journaled snapshot');
    }
  }

  return { ledger, head: ledger.head, repairs, ignored };
}

function parseLines(lines) {
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') lastNonEmpty = i;
  }
  const records = [];
  for (let i = 0; i <= lastNonEmpty; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      if (i === lastNonEmpty) continue; // torn tail write: ignore partial last line
      throw new LedgerError(CODES.CORRUPT_JOURNAL, `unparseable journal line ${i + 1}`);
    }
  }
  return records;
}

module.exports = { Journal, recover, FAULT_POINTS, SimulatedCrash };
