import { createHash } from 'node:crypto';
import { canonical } from './canon.js';

export class UnknownOrigError extends Error {
  constructor(origId) {
    super(`unknown origId: ${origId}`);
    this.name = 'UnknownOrigError';
    this.code = 'UNKNOWN_ORIG';
    this.origId = origId;
  }
}

const cmpId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fin = (v) => (v === Infinity ? 'unlimited' : v);

// DvP matching engine. Frames must be validated (src/frame.js) and
// deduplicated + seq-ordered (src/runner.js) before apply().
export class Engine {
  constructor(config = {}) {
    this.window = config.window ?? 1000;
    this.accounts = new Map();
    for (const [name, a] of Object.entries(config.accounts ?? {})) {
      this.accounts.set(name, {
        cashAvail: a.cash ?? 0,
        cashFrozen: 0,
        secAvail: a.sec ?? 0,
        secFrozen: 0,
        configured: true,
      });
    }
    this.orders = new Map();
    this.trades = new Map();
    this.events = [];
    this.now = 0;
    this.tradeSeq = 0;
    this.compSeq = 0;
    this.hash = '0'.repeat(64);
  }

  acct(name) {
    if (!this.accounts.has(name)) {
      this.accounts.set(name, { cashAvail: Infinity, cashFrozen: 0, secAvail: Infinity, secFrozen: 0, configured: false });
    }
    return this.accounts.get(name);
  }

  emit(event) {
    this.hash = createHash('sha256').update(this.hash + '\n' + canonical(event)).digest('hex');
    this.events.push(event);
    return event;
  }

  auditRoot() {
    return this.hash;
  }

  apply(frame) {
    const ts = frame.ts ?? frame.seq;
    if (ts > this.now) this.now = ts;
    this.expire(frame.seq);
    switch (frame.op) {
      case 'new': return this.doNew(frame);
      case 'amend': return this.doAmend(frame);
      case 'cancel': return this.doCancel(frame);
      case 'match': return this.doMatch(frame);
      case 'settle': return this.doSettle(frame);
      case 'fail': return this.doFail(frame);
    }
  }

  // Matching-window timeout: open orders whose entry age reaches the window
  // are expired and their unmatched remainder is released.
  expire(atSeq) {
    const doomed = [...this.orders.values()]
      .filter((o) => o.state === 'open' && this.now - o.entryTs >= this.window)
      .sort((a, b) => a.entrySeq - b.entrySeq || cmpId(a.id, b.id));
    for (const o of doomed) {
      o.state = 'expired';
      const released = o.remaining;
      o.remaining = 0;
      this.emit({ type: 'expired', seq: atSeq, clOrdId: o.id, released });
    }
  }

  doNew(frame) {
    const order = {
      id: frame.clOrdId,
      side: frame.side,
      acct: frame.acct ?? 'default',
      qty: frame.qty,
      price: frame.price,
      filled: 0,
      remaining: frame.qty,
      entryTs: this.now,
      entrySeq: frame.seq,
      prioTs: this.now,
      state: 'open',
    };
    this.orders.set(order.id, order);
    this.emit({ type: 'order', seq: frame.seq, clOrdId: order.id, side: order.side, acct: order.acct, qty: order.qty, price: order.price, remaining: order.remaining });
  }

  doAmend(frame) {
    const o = this.orders.get(frame.origId);
    if (!o) throw new UnknownOrigError(frame.origId);
    if (o.state !== 'open') {
      return this.emit({ type: 'rejected', seq: frame.seq, instr: frame.clOrdId, op: 'amend', origId: o.id, reason: 'orderNotOpen' });
    }
    const newQty = frame.qty ?? o.qty;
    const newPrice = frame.price ?? o.price;
    // An amend may never touch the already-filled part.
    if (newQty < o.filled) {
      return this.emit({ type: 'rejected', seq: frame.seq, instr: frame.clOrdId, op: 'amend', origId: o.id, reason: 'amendCrossesFilled', filled: o.filled });
    }
    o.qty = newQty;
    if (newPrice !== o.price) {
      o.price = newPrice;
      // A price change loses time priority; a qty-only amend keeps it.
      o.prioTs = this.now;
    }
    o.remaining = newQty - o.filled;
    if (o.remaining === 0) o.state = 'filled';
    this.emit({ type: 'amended', seq: frame.seq, instr: frame.clOrdId, clOrdId: o.id, qty: o.qty, price: o.price, remaining: o.remaining });
  }

  doCancel(frame) {
    const o = this.orders.get(frame.origId);
    if (!o) throw new UnknownOrigError(frame.origId);
    if (o.state !== 'open') {
      return this.emit({ type: 'rejected', seq: frame.seq, instr: frame.clOrdId, op: 'cancel', origId: o.id, reason: 'orderNotOpen' });
    }
    o.state = 'canceled';
    const released = o.remaining;
    o.remaining = 0;
    this.emit({ type: 'canceled', seq: frame.seq, instr: frame.clOrdId, clOrdId: o.id, released });
  }

  // Price-time priority; ties on identical price and timestamp break by
  // clOrdId. Trade price is the maker's (earlier resting) price.
  doMatch(frame) {
    const prioCmp = (a, b) => a.prioTs - b.prioTs || cmpId(a.id, b.id);
    const buys = [...this.orders.values()]
      .filter((o) => o.state === 'open' && o.side === 'buy' && o.remaining > 0)
      .sort((a, b) => b.price - a.price || prioCmp(a, b));
    const sells = [...this.orders.values()]
      .filter((o) => o.state === 'open' && o.side === 'sell' && o.remaining > 0)
      .sort((a, b) => a.price - b.price || prioCmp(a, b));
    const skipBuy = new Set();
    const skipSell = new Set();
    for (;;) {
      const b = buys.find((o) => o.remaining > 0 && !skipBuy.has(o.id));
      const s = sells.find((o) => o.remaining > 0 && !skipSell.has(o.id));
      if (!b || !s || b.price < s.price) break;
      const qty = Math.min(b.remaining, s.remaining);
      const maker = prioCmp(b, s) <= 0 ? b : s;
      const price = maker.price;
      const amount = qty * price;
      const buyAcct = this.acct(b.acct);
      const sellAcct = this.acct(s.acct);
      // DvP: both legs must be deliverable at once, otherwise the whole
      // pairing is rejected and neither side is debited.
      if (buyAcct.cashAvail < amount) {
        this.emit({ type: 'matchRejected', seq: frame.seq, reason: 'insufficientCash', buyId: b.id, sellId: s.id, qty, price });
        skipBuy.add(b.id);
        continue;
      }
      if (sellAcct.secAvail < qty) {
        this.emit({ type: 'matchRejected', seq: frame.seq, reason: 'insufficientSecurities', buyId: b.id, sellId: s.id, qty, price });
        skipSell.add(s.id);
        continue;
      }
      buyAcct.cashAvail -= amount;
      buyAcct.cashFrozen += amount;
      sellAcct.secAvail -= qty;
      sellAcct.secFrozen += qty;
      const tradeId = 'T' + ++this.tradeSeq;
      this.trades.set(tradeId, { id: tradeId, buyId: b.id, sellId: s.id, qty, price, amount, buyAcct: b.acct, sellAcct: s.acct, state: 'matched', seq: frame.seq });
      b.filled += qty;
      b.remaining -= qty;
      s.filled += qty;
      s.remaining -= qty;
      if (b.remaining === 0) b.state = 'filled';
      if (s.remaining === 0) s.state = 'filled';
      this.emit({ type: 'trade', seq: frame.seq, tradeId, buyId: b.id, sellId: s.id, qty, price });
      this.emit({ type: 'freeze', seq: frame.seq, tradeId, acct: b.acct, asset: 'cash', qty: amount, ...this.balances(buyAcct) });
      this.emit({ type: 'freeze', seq: frame.seq, tradeId, acct: s.acct, asset: 'sec', qty, ...this.balances(sellAcct) });
      this.emit({ type: 'remaining', seq: frame.seq, clOrdId: b.id, filled: b.filled, remaining: b.remaining });
      this.emit({ type: 'remaining', seq: frame.seq, clOrdId: s.id, filled: s.filled, remaining: s.remaining });
    }
  }

  balances(a) {
    if (!a.configured) return {};
    return { balances: { cashAvail: a.cashAvail, cashFrozen: a.cashFrozen, secAvail: a.secAvail, secFrozen: a.secFrozen } };
  }

  // Settlement is final: frozen cash/securities move to the counterparty.
  doSettle(frame) {
    const t = this.trades.get(frame.origId);
    if (!t) throw new UnknownOrigError(frame.origId);
    if (t.state !== 'matched') {
      return this.emit({ type: 'rejected', seq: frame.seq, instr: frame.clOrdId, op: 'settle', origId: t.id, reason: 'tradeNotMatched' });
    }
    const buyAcct = this.acct(t.buyAcct);
    const sellAcct = this.acct(t.sellAcct);
    buyAcct.cashFrozen -= t.amount;
    sellAcct.cashAvail += t.amount;
    sellAcct.secFrozen -= t.qty;
    buyAcct.secAvail += t.qty;
    t.state = 'settled';
    this.emit({ type: 'settled', seq: frame.seq, instr: frame.clOrdId, tradeId: t.id });
  }

  // After settle the ledger is append-only: a fail books a compensating
  // movement referencing the settled trade; the trade itself is never erased.
  doFail(frame) {
    const t = this.trades.get(frame.origId);
    if (!t) throw new UnknownOrigError(frame.origId);
    if (t.state !== 'settled') {
      return this.emit({ type: 'rejected', seq: frame.seq, instr: frame.clOrdId, op: 'fail', origId: t.id, reason: 'tradeNotSettled' });
    }
    const buyAcct = this.acct(t.buyAcct);
    const sellAcct = this.acct(t.sellAcct);
    buyAcct.secAvail -= t.qty;
    buyAcct.cashAvail += t.amount;
    sellAcct.cashAvail -= t.amount;
    sellAcct.secAvail += t.qty;
    t.state = 'compensated';
    const compId = 'C' + ++this.compSeq;
    this.emit({ type: 'compensated', seq: frame.seq, instr: frame.clOrdId, compId, tradeId: t.id, qty: t.qty, amount: t.amount });
  }

  snapshot() {
    return {
      orders: [...this.orders.values()].map((o) => ({ clOrdId: o.id, side: o.side, qty: o.qty, price: o.price, filled: o.filled, remaining: o.remaining, state: o.state })),
      trades: [...this.trades.values()].map((t) => ({ tradeId: t.id, buyId: t.buyId, sellId: t.sellId, qty: t.qty, price: t.price, state: t.state })),
      accounts: [...this.accounts.entries()].map(([name, a]) => ({ acct: name, cashAvail: fin(a.cashAvail), cashFrozen: a.cashFrozen, secAvail: fin(a.secAvail), secFrozen: a.secFrozen })),
    };
  }

  finish() {
    this.emit({ type: 'end', ...this.snapshot() });
  }
}
