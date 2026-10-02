'use strict';

const { canon, sha256hex } = require('./canon');
const { BusinessError } = require('./errors');

const DEFAULT_CURRENCIES = ['USD', 'EUR', 'CNY', 'GBP', 'JPY', 'HKD', 'SGD', 'CHF', 'AUD', 'CAD'];
const GENESIS = '0'.repeat(64);

// Amounts are integer minor units (cents). Input format: "-?D+[.DD]".
function parseAmount(s) {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(s));
  if (!m) throw new BusinessError(`invalid amount: ${s}`);
  let v = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -v : v;
}

function fmt(cents) {
  const neg = cents < 0n;
  const s = (neg ? -cents : cents).toString().padStart(3, '0');
  const r = `${s.slice(0, -2)}.${s.slice(-2)}`;
  return neg ? '-' + r : r;
}

const keyOf = (batch, lineNo) => `${batch}:${lineNo}`;

// Business state machine. Lines: OPEN -> ACKED -> SETTLED, or OPEN -> NAKED.
// SETTLED is final and immutable; corrections happen only via reversal lines
// in a new batch. Every mutation is appended to a sha256 hash chain over
// canonically serialized events (the audit certificate).
class Ledger {
  constructor(clock, opts = {}) {
    this.clock = clock;
    this.limit = opts.limit != null ? parseAmount(opts.limit) : null;
    this.perLineLimit = opts.perLineLimit != null ? parseAmount(opts.perLineLimit) : null;
    this.currencies = opts.currencies ?? DEFAULT_CURRENCIES;
    this.frozen = 0n;
    this.settledPay = 0n;
    this.settledReceive = 0n;
    this.batches = new Map();
    this.lines = new Map();
    this.audit = [];
    this.head = GENESIS;
    this.onBatchAborted = null;
  }

  _event(kind, fields) {
    const event = { at: this.clock.now(), kind, seq: this.audit.length, ...fields };
    this.head = sha256hex(this.head + '|' + canon(event));
    this.audit.push(event);
  }

  verifyAudit() {
    let head = GENESIS;
    for (const e of this.audit) head = sha256hex(head + '|' + canon(e));
    return head === this.head;
  }

  submitBatch({ batchId, lines, timeoutMs = null }) {
    if (!Number.isInteger(batchId) || batchId < 0) throw new BusinessError(`invalid batch id ${batchId}`);
    if (this.batches.has(batchId)) throw new BusinessError(`batch ${batchId} already exists`);
    if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('batch must contain lines');
    const recs = lines.map((l) => {
      if (!Number.isInteger(l.lineNo)) throw new BusinessError(`invalid lineNo ${l.lineNo}`);
      if (l.direction !== 'pay' && l.direction !== 'receive') {
        throw new BusinessError(`invalid direction ${l.direction}`);
      }
      return {
        batch: batchId,
        lineNo: l.lineNo,
        amount: parseAmount(l.amount),
        currency: String(l.currency),
        direction: l.direction,
        reversalOf: l.reversalOf ?? null,
        state: 'OPEN',
        frozenAmt: 0n,
      };
    });
    const seen = new Set();
    for (const r of recs) {
      const k = keyOf(batchId, r.lineNo);
      if (seen.has(k)) throw new BusinessError(`duplicate line ${k}`);
      seen.add(k);
    }
    for (const r of recs) {
      if (r.reversalOf) {
        const t = this.lines.get(keyOf(r.reversalOf.batch, r.reversalOf.lineNo));
        if (!t) throw new BusinessError('reversal target not found');
        if (t.state !== 'SETTLED') throw new BusinessError('reversal target is not SETTLED');
      }
    }
    let freeze = 0n;
    for (const r of recs) if (r.direction === 'pay') freeze += r.amount;
    if (this.limit !== null && this.frozen + freeze > this.limit) {
      throw new BusinessError('limit exceeded');
    }
    this.frozen += freeze;
    for (const r of recs) {
      if (r.direction === 'pay') r.frozenAmt = r.amount;
      this.lines.set(keyOf(batchId, r.lineNo), r);
    }
    const batch = { id: batchId, state: 'OPEN', lineNos: recs.map((r) => r.lineNo), timerId: null };
    this.batches.set(batchId, batch);
    if (timeoutMs != null) batch.timerId = this.clock.set(() => this._abort(batchId), timeoutMs);
    this._event('freeze', { batch: batchId, amount: fmt(freeze), frozen: fmt(this.frozen) });
  }

  _validate(rec) {
    if (!this.currencies.includes(rec.currency)) return 'currency_not_allowed';
    if (rec.amount <= 0n) return 'amount_not_positive';
    if (this.perLineLimit !== null && rec.amount > this.perLineLimit) return 'per_line_limit_exceeded';
    return null;
  }

  onLineReceived(batchId, lineNo) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state !== 'OPEN') return; // late frame for aborted/settled batch
    const rec = this.lines.get(keyOf(batchId, lineNo));
    if (!rec || rec.state !== 'OPEN') return;
    const reason = this._validate(rec);
    if (reason) {
      rec.state = 'NAKED';
      this.frozen -= rec.frozenAmt;
      this._event('nak', { batch: batchId, lineNo, reason, unfrozen: fmt(rec.frozenAmt) });
      rec.frozenAmt = 0n;
    } else {
      rec.state = 'ACKED';
      this._event('ack', { batch: batchId, lineNo });
    }
  }

  onBatchComplete(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state !== 'OPEN') return;
    if (batch.timerId !== null) {
      this.clock.clear(batch.timerId);
      batch.timerId = null;
    }
    batch.state = 'SETTLED';
    for (const lineNo of batch.lineNos) {
      const rec = this.lines.get(keyOf(batchId, lineNo));
      if (rec.state !== 'ACKED') continue;
      rec.state = 'SETTLED';
      if (rec.direction === 'pay') this.settledPay += rec.amount;
      else this.settledReceive += rec.amount;
      this.frozen -= rec.frozenAmt;
      rec.frozenAmt = 0n;
      this._event('settle', { batch: batchId, lineNo, amount: fmt(rec.amount) });
    }
  }

  _abort(batchId) {
    const batch = this.batches.get(batchId);
    if (!batch || batch.state !== 'OPEN') return;
    batch.state = 'ABORTED';
    batch.timerId = null;
    let unfrozen = 0n;
    for (const lineNo of batch.lineNos) {
      const rec = this.lines.get(keyOf(batchId, lineNo));
      if (rec.state === 'OPEN' || rec.state === 'ACKED') {
        rec.state = 'OPEN';
        unfrozen += rec.frozenAmt;
        rec.frozenAmt = 0n;
      }
    }
    this.frozen -= unfrozen;
    this._event('abort', { batch: batchId, unfrozen: fmt(unfrozen) });
    if (this.onBatchAborted) this.onBatchAborted(batchId);
  }

  findLine(batch, lineNo) {
    return this.lines.get(keyOf(batch, lineNo)) ?? null;
  }

  result() {
    return {
      frozen: fmt(this.frozen),
      settledPay: fmt(this.settledPay),
      settledReceive: fmt(this.settledReceive),
      batches: [...this.batches.values()].map((b) => ({ batch: b.id, state: b.state })),
      lines: [...this.lines.values()]
        .sort((a, b) => a.batch - b.batch || a.lineNo - b.lineNo)
        .map((r) => ({
          batch: r.batch,
          lineNo: r.lineNo,
          state: r.state,
          amount: fmt(r.amount),
          currency: r.currency,
          direction: r.direction,
          reversalOf: r.reversalOf,
        })),
      audit: { events: this.audit.length, head: this.head, valid: this.verifyAudit() },
    };
  }
}

module.exports = { Ledger, parseAmount, fmt };
