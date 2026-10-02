'use strict';

const { AuditChain } = require('./audit');

class BusinessError extends Error {
  constructor(message, code = 'BUSINESS_REJECTED') {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
  }
}

// Line lifecycle: OPEN -> ACKED -> SETTLED. A SETTLED line is immutable
// history: it can only be corrected by a reversal line (reversalOf) that
// moves the same amount back. REJECTED (business NAK) and ABORTED (batch
// timeout) are terminal states that release the frozen amount.
const LINE = {
  OPEN: 'OPEN',
  ACKED: 'ACKED',
  SETTLED: 'SETTLED',
  REJECTED: 'REJECTED',
  ABORTED: 'ABORTED',
};
const TERMINAL = new Set([LINE.SETTLED, LINE.REJECTED, LINE.ABORTED]);

class Ledger {
  constructor(clock, { batchTimeoutMs = 10000 } = {}) {
    this.clock = clock;
    this.batchTimeoutMs = batchTimeoutMs;
    this.accounts = new Map(); // id -> {id, balance, frozen}
    this.batches = new Map();  // id -> {id, lines: Map, submittedAt, aborted}
    this.audit = new AuditChain();
  }

  addAccount(id, balance) {
    if (typeof id !== 'string' || id.length === 0) throw new BusinessError('account id must be a non-empty string');
    if (this.accounts.has(id)) throw new BusinessError(`account ${id} already exists`);
    if (!Number.isInteger(balance) || balance < 0) throw new BusinessError('balance must be a non-negative integer');
    this.accounts.set(id, { id, balance, frozen: 0 });
    this.audit.record('account', { id, balance });
  }

  getLine(batchId, lineNo) {
    const batch = this.batches.get(batchId);
    return batch ? batch.lines.get(lineNo) : undefined;
  }

  // Submitting a batch freezes the total of its payment lines up front.
  submitBatch(batchId, lines) {
    if (!Number.isInteger(batchId) || batchId < 0) throw new BusinessError('batchId must be a non-negative integer');
    if (this.batches.has(batchId)) throw new BusinessError(`batch ${batchId} already exists`);
    if (!Array.isArray(lines) || lines.length === 0) throw new BusinessError('batch must contain at least one line');

    const seen = new Set();
    const parsed = lines.map((l) => {
      if (!l || typeof l !== 'object') throw new BusinessError('line must be an object');
      const { lineNo, from, to, amount, reversalOf } = l;
      if (!Number.isInteger(lineNo) || lineNo < 0) throw new BusinessError('lineNo must be a non-negative integer');
      if (seen.has(lineNo)) throw new BusinessError(`duplicate lineNo ${lineNo} in batch`);
      seen.add(lineNo);
      if (!this.accounts.has(from)) throw new BusinessError(`unknown payer account ${from}`);
      if (!this.accounts.has(to)) throw new BusinessError(`unknown payee account ${to}`);
      if (!Number.isInteger(amount) || amount <= 0) throw new BusinessError('amount must be a positive integer (minor units)');
      const line = { batchId, lineNo, from, to, amount, reversalOf: null, state: LINE.OPEN, reversedBy: null };
      if (reversalOf !== undefined && reversalOf !== null) {
        const ref = this.getLine(reversalOf.batchId, reversalOf.lineNo);
        if (!ref) throw new BusinessError('reversal target does not exist');
        if (ref.state !== LINE.SETTLED) {
          throw new BusinessError(`reversal target is ${ref.state}, only SETTLED lines can be reversed`, 'IMMUTABLE_HISTORY');
        }
        if (ref.reversedBy) throw new BusinessError('line already reversed', 'IMMUTABLE_HISTORY');
        if (from !== ref.to || to !== ref.from || amount !== ref.amount) {
          throw new BusinessError('reversal must move the exact amount back from payee to payer');
        }
        line.reversalOf = { batchId: reversalOf.batchId, lineNo: reversalOf.lineNo };
      }
      return line;
    });

    // Freeze: check available funds per payer for the whole batch first.
    const need = new Map();
    for (const l of parsed) need.set(l.from, (need.get(l.from) || 0) + l.amount);
    for (const [acct, amt] of need) {
      const a = this.accounts.get(acct);
      if (a.balance - a.frozen < amt) {
        throw new BusinessError(`insufficient available funds in ${acct}: need ${amt}, have ${a.balance - a.frozen}`, 'INSUFFICIENT_FUNDS');
      }
    }
    for (const [acct, amt] of need) this.accounts.get(acct).frozen += amt;

    const batch = { id: batchId, lines: new Map(), submittedAt: this.clock.now(), aborted: false };
    for (const l of parsed) {
      batch.lines.set(l.lineNo, l);
      if (l.reversalOf) this.getLine(l.reversalOf.batchId, l.reversalOf.lineNo).reversedBy = { batchId, lineNo: l.lineNo };
    }
    this.batches.set(batchId, batch);
    this.audit.record('submit', {
      batchId,
      frozen: Object.fromEntries(need),
      lines: parsed.map((l) => ({ lineNo: l.lineNo, from: l.from, to: l.to, amount: l.amount, reversalOf: l.reversalOf })),
    });
    return batch;
  }

  // Called by the protocol layer when a DATA frame is delivered in order.
  // Returns 'acked' | 'ignored' (late/duplicate delivery after terminal state).
  onDelivered(batchId, lineNo) {
    const line = this.getLine(batchId, lineNo);
    if (!line) return 'ignored';
    if (line.state !== LINE.OPEN) return 'ignored';
    line.state = LINE.ACKED;
    this.audit.record('ack', { batchId, lineNo });
    return 'acked';
  }

  settle(batchId, lineNo) {
    const line = this.getLine(batchId, lineNo);
    if (!line) throw new BusinessError(`unknown line ${batchId}/${lineNo}`);
    if (line.state === LINE.SETTLED) {
      throw new BusinessError('line already SETTLED; history is immutable, correct it with a reversal line', 'IMMUTABLE_HISTORY');
    }
    if (line.state !== LINE.ACKED) throw new BusinessError(`cannot settle line in state ${line.state}`);
    line.state = LINE.SETTLED;
    const from = this.accounts.get(line.from);
    const to = this.accounts.get(line.to);
    from.frozen -= line.amount;
    from.balance -= line.amount;
    to.balance += line.amount;
    this.audit.record('settle', { batchId, lineNo, amount: line.amount });
  }

  // Business NAK: reject one line, unfreeze exactly its amount.
  nak(batchId, lineNo) {
    const line = this.getLine(batchId, lineNo);
    if (!line) throw new BusinessError(`unknown line ${batchId}/${lineNo}`);
    if (line.state === LINE.SETTLED) {
      throw new BusinessError('cannot NAK a SETTLED line; history is immutable, correct it with a reversal line', 'IMMUTABLE_HISTORY');
    }
    if (TERMINAL.has(line.state)) throw new BusinessError(`cannot NAK line in state ${line.state}`);
    line.state = LINE.REJECTED;
    this.accounts.get(line.from).frozen -= line.amount;
    this.audit.record('nak', { batchId, lineNo, unfrozen: line.amount });
  }

  // Virtual-clock driven: a batch whose lines are not all terminal once the
  // timeout elapses is aborted as a whole and every remaining freeze released.
  checkTimeouts() {
    for (const batch of this.batches.values()) {
      if (batch.aborted) continue;
      const open = [...batch.lines.values()].filter((l) => !TERMINAL.has(l.state));
      if (open.length === 0) continue;
      if (this.clock.now() - batch.submittedAt >= this.batchTimeoutMs) {
        batch.aborted = true;
        for (const l of open) {
          l.state = LINE.ABORTED;
          this.accounts.get(l.from).frozen -= l.amount;
        }
        this.audit.record('abort', { batchId: batch.id, lines: open.map((l) => l.lineNo) });
      }
    }
  }

  batchState(batch) {
    if (batch.aborted) return 'ABORTED';
    const lines = [...batch.lines.values()];
    if (lines.every((l) => l.state === LINE.SETTLED)) return 'SETTLED';
    if (lines.every((l) => TERMINAL.has(l.state))) return 'CLOSED';
    return 'OPEN';
  }

  snapshot() {
    return {
      accounts: [...this.accounts.values()]
        .map((a) => ({ id: a.id, balance: a.balance, frozen: a.frozen, available: a.balance - a.frozen }))
        .sort((x, y) => (x.id < y.id ? -1 : 1)),
      batches: [...this.batches.values()]
        .map((b) => ({ batchId: b.id, state: this.batchState(b) }))
        .sort((x, y) => x.batchId - y.batchId),
      lines: [...this.batches.values()]
        .flatMap((b) => [...b.lines.values()])
        .map((l) => ({
          batchId: l.batchId, lineNo: l.lineNo, from: l.from, to: l.to,
          amount: l.amount, state: l.state, reversalOf: l.reversalOf, reversedBy: l.reversedBy,
        }))
        .sort((x, y) => x.batchId - y.batchId || x.lineNo - y.lineNo),
      audit: {
        count: this.audit.events.length,
        head: this.audit.head,
        events: this.audit.events,
      },
    };
  }
}

module.exports = { Ledger, BusinessError, LINE };
