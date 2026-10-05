import { ClearingError, E } from './errors.js';
import { TzTable } from './tz.js';
import { CalendarSet } from './calendar.js';
import { mergeDayIntervals } from './interval.js';
import { hashObject } from './hash.js';
import {
  parseUtcMinutes,
  parseLocalMinutes,
  formatUtcMinutes,
  dayNumberToDate,
} from './time.js';

export const ENGINE_VERSION = '1.0.0';

// Transaction schema (normal):
//   { id, account, calendar, amount, utc | local, hold?, holdReason? }
// Reversal (append-only correction; history is never deleted):
//   { id, type: "reversal", reverses: <txId>, utc | local }
// A reversal books the negated original amount into the ORIGINAL settlement
// day (as-of correction) and marks that day for recomputation.
export class ClearingEngine {
  constructor({ tzTable, calendar }) {
    this.tz = tzTable instanceof TzTable ? tzTable : new TzTable(tzTable);
    this.cals = calendar instanceof CalendarSet ? calendar : new CalendarSet(calendar, this.tz);
    this.txs = [];
    this.byId = new Map();
    this.dayTxs = new Map(); // "calId|dayNum" -> booked entries [{account, amount}]
    this.dayNets = new Map(); // "calId|dayNum" -> Map(account -> net)
    this.pending = [];
    this.boundaryHits = [];
    this.correctionDays = new Map(); // calId -> Set(dayNum)
    this.reversedIds = new Set();
    this.lastInstant = null;
    this.settled = false;
  }

  static dayKey(calId, dayNum) {
    return `${calId}|${dayNum}`;
  }

  #resolveInstant(tx, zone) {
    if (tx.utc != null && tx.local != null) {
      throw new Error(`tx ${tx.id}: specify either utc or local, not both`);
    }
    if (tx.utc != null) return parseUtcMinutes(tx.utc);
    if (tx.local != null) return this.tz.localToUtc(zone, parseLocalMinutes(tx.local));
    throw new Error(`tx ${tx.id}: missing utc/local timestamp`);
  }

  // Map an instant to its settlement day in `cal`: the first business day D
  // whose cutoff instant is strictly after the tx instant. The day-cut
  // interval is [cutoff(prevBusinessDay(D)), cutoff(D)) — half open.
  settlementDay(cal, instant) {
    const localMin = this.tz.utcToLocal(cal.zone, instant);
    const localDay = Math.floor(localMin / 1440);
    let d = this.cals.firstBusinessDayOnOrAfter(cal, localDay);
    if (this.cals.cutoffUtc(cal, d) <= instant) {
      d = this.cals.nextBusinessDay(cal, d);
    }
    const prev = this.cals.prevBusinessDay(cal, d);
    const boundaryHit = this.cals.cutoffUtc(cal, prev) === instant;
    return { dayNum: d, boundaryHit };
  }

  #checkOrder(tx, instant) {
    if (this.lastInstant !== null && instant < this.lastInstant) {
      throw new ClearingError(E.ORDER, `tx ${tx.id}: timestamps must be non-decreasing`, {
        txId: tx.id,
        instant: formatUtcMinutes(instant),
        previous: formatUtcMinutes(this.lastInstant),
      });
    }
    this.lastInstant = instant;
  }

  #register(tx) {
    if (typeof tx.id !== 'string' || tx.id === '') throw new Error('tx: missing id');
    if (this.byId.has(tx.id)) {
      throw new ClearingError(E.ORDER, `duplicate tx id: ${tx.id}`, { txId: tx.id });
    }
    this.byId.set(tx.id, tx);
    this.txs.push(tx);
  }

  #book(calId, dayNum, account, amount) {
    const key = ClearingEngine.dayKey(calId, dayNum);
    let list = this.dayTxs.get(key);
    if (!list) {
      list = [];
      this.dayTxs.set(key, list);
    }
    list.push({ account, amount });
  }

  #noteBoundaryHit(tx, cal, instant, dayNum) {
    this.boundaryHits.push({
      txId: tx.id,
      calendar: cal.id,
      instantUtc: formatUtcMinutes(instant),
      boundary: 'localStart',
      settlementDay: dayNumberToDate(dayNum),
    });
  }

  #noteCorrectionDay(calId, dayNum) {
    let s = this.correctionDays.get(calId);
    if (!s) {
      s = new Set();
      this.correctionDays.set(calId, s);
    }
    s.add(dayNum);
  }

  #ingest(tx) {
    if (tx.type === 'reversal') {
      this.#ingestReversal(tx);
      return;
    }
    const cal = this.cals.get(tx.calendar);
    if (typeof tx.account !== 'string' || tx.account === '') throw new Error(`tx ${tx.id}: missing account`);
    const instant = this.#resolveInstant(tx, cal.zone);
    this.#checkOrder(tx, instant);
    this.#register(tx);
    if (tx.hold) {
      this.pending.push({
        txId: tx.id,
        calendar: cal.id,
        account: tx.account,
        reason: typeof tx.holdReason === 'string' ? tx.holdReason : 'HELD',
      });
      return;
    }
    if (!Number.isInteger(tx.amount)) throw new Error(`tx ${tx.id}: amount must be an integer (minor units)`);
    const { dayNum, boundaryHit } = this.settlementDay(cal, instant);
    if (boundaryHit) this.#noteBoundaryHit(tx, cal, instant, dayNum);
    this.#book(cal.id, dayNum, tx.account, tx.amount);
  }

  #ingestReversal(tx) {
    const original = this.byId.get(tx.reverses);
    if (!original) {
      throw new ClearingError(E.ORDER, `reversal ${tx.id}: unknown target ${tx.reverses}`, { txId: tx.id });
    }
    const cal = this.cals.get(original.calendar);
    const instant = this.#resolveInstant(tx, cal.zone);
    this.#checkOrder(tx, instant);
    if (original.type === 'reversal') {
      throw new ClearingError(E.ORDER, `reversal ${tx.id}: cannot reverse a reversal`, { txId: tx.id });
    }
    if (original.hold) {
      throw new ClearingError(E.ORDER, `reversal ${tx.id}: target ${original.id} was never booked (held)`, { txId: tx.id });
    }
    if (this.reversedIds.has(original.id)) {
      throw new ClearingError(E.ORDER, `reversal ${tx.id}: target ${original.id} already reversed`, { txId: tx.id });
    }
    this.#register(tx);
    this.reversedIds.add(original.id);
    const origInstant = this.#resolveInstant(original, cal.zone);
    const { dayNum } = this.settlementDay(cal, origInstant);
    this.#book(cal.id, dayNum, original.account, -original.amount);
    this.#noteCorrectionDay(cal.id, dayNum);
  }

  #recomputeDays(keys) {
    for (const key of keys) {
      const nets = new Map();
      for (const entry of this.dayTxs.get(key) ?? []) {
        nets.set(entry.account, (nets.get(entry.account) ?? 0) + entry.amount);
      }
      this.dayNets.set(key, nets);
    }
  }

  #netsList() {
    const out = [];
    for (const [key, nets] of this.dayNets) {
      const sep = key.indexOf('|');
      const calId = key.slice(0, sep);
      const day = dayNumberToDate(Number(key.slice(sep + 1)));
      for (const [account, net] of nets) {
        out.push({ calendar: calId, account, day, net });
      }
    }
    out.sort((a, b) =>
      a.calendar === b.calendar
        ? a.account === b.account
          ? a.day < b.day ? -1 : a.day > b.day ? 1 : 0
          : a.account < b.account ? -1 : 1
        : a.calendar < b.calendar ? -1 : 1,
    );
    return out;
  }

  #mergedIntervals() {
    const out = [];
    for (const calId of [...this.correctionDays.keys()].sort()) {
      for (const r of mergeDayIntervals([...this.correctionDays.get(calId)])) {
        out.push({ calendar: calId, ...r });
      }
    }
    return out;
  }

  #certificate() {
    const body = {
      engineVersion: ENGINE_VERSION,
      tzVersion: this.tz.version,
      calendarVersion: this.cals.version,
      inputHashes: {
        transactions: hashObject(this.txs),
        tzTable: hashObject(this.tz.raw),
        calendar: hashObject(this.cals.raw),
      },
      mergedIntervals: this.#mergedIntervals(),
      boundaryHits: this.boundaryHits,
      netsHash: hashObject(this.#netsList()),
      pendingHash: hashObject(this.pending),
    };
    return { ...body, certificateHash: hashObject(body) };
  }

  #report() {
    return {
      nets: this.#netsList(),
      pending: this.pending,
      certificate: this.#certificate(),
    };
  }

  // Initial full settlement. Callable once per engine instance.
  settle(transactions) {
    if (this.settled) throw new Error('engine already settled; use applyCorrections');
    if (!Array.isArray(transactions)) throw new Error('transactions must be an array');
    for (const tx of transactions) this.#ingest(tx);
    this.#recomputeDays([...this.dayTxs.keys()]);
    this.settled = true;
    return this.#report();
  }

  // Append-only corrections (reversals and/or late transactions). Only the
  // affected settlement days are recomputed; everything else is untouched.
  applyCorrections(transactions) {
    if (!this.settled) throw new Error('call settle first');
    if (!Array.isArray(transactions)) throw new Error('corrections must be an array');
    for (const tx of transactions) this.#ingest(tx);
    const affectedKeys = [];
    for (const [calId, days] of this.correctionDays) {
      for (const d of days) affectedKeys.push(ClearingEngine.dayKey(calId, d));
    }
    // Late (non-reversal) arrivals book into new/existing days; those keys are
    // exactly the ones present in dayTxs but not yet in dayNets.
    for (const key of this.dayTxs.keys()) {
      if (!this.dayNets.has(key) && !affectedKeys.includes(key)) affectedKeys.push(key);
    }
    this.#recomputeDays(affectedKeys);
    return {
      ...this.#report(),
      recomputed: {
        days: affectedKeys.map((k) => {
          const sep = k.indexOf('|');
          return { calendar: k.slice(0, sep), day: dayNumberToDate(Number(k.slice(sep + 1))) };
        }),
        mergedIntervals: this.#mergedIntervals(),
      },
    };
  }
}

// Replay a report's inputs and check the certificate. Returns true when the
// recomputed certificate hash matches.
export function verifyReport({ tzTable, calendar, transactions }, report) {
  const engine = new ClearingEngine({ tzTable, calendar });
  const fresh = engine.settle(transactions);
  return fresh.certificate.certificateHash === report?.certificate?.certificateHash;
}
