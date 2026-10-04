'use strict';
const { canonical, sha256hex, ExitError } = require('./util');

const BUY = 'buy';
const SELL = 'sell';
const OPEN = 'open';

// DvP matching engine. Frames are deduplicated by seq, replayed in seq (log)
// order, and every state-changing step is appended to a hash-chained audit log.
class Engine {
  constructor() {
    this.limits = { funds: null, securities: null }; // null = unlimited
    this.window = 100; // matching window in virtual-clock ticks
    this.frozen = { funds: 0, securities: 0 };
    this.spent = { funds: 0, securities: 0 }; // settled (delivered) amounts
    this.orders = new Map(); // clOrdId -> order
    this.payloads = new Map(); // clOrdId -> canonical payload (dedup / exit 4)
    this.fills = [];
    this.compensations = [];
    this.events = [];
    this.clock = 0;
    this.auditRoot = sha256hex('DvP-AUDIT-v1');
  }

  emit(seq, kind, details) {
    const ev = { n: this.events.length, seq, ts: this.clock, kind, ...details };
    this.events.push(ev);
    this.auditRoot = sha256hex(this.auditRoot + '\n' + canonical(ev));
    return ev;
  }

  available(kind) {
    const lim = this.limits[kind];
    if (lim === null) return Infinity;
    return lim - this.frozen[kind] - this.spent[kind];
  }

  freeze(kind, amount) {
    if (amount > this.available(kind)) return false;
    this.frozen[kind] += amount;
    return true;
  }

  release(kind, amount) {
    this.frozen[kind] -= amount;
  }

  // Advance the virtual clock; orders whose matching window has ended expire
  // and their remaining freeze is released.
  advance(ts, seq) {
    if (ts <= this.clock) return;
    this.clock = ts;
    for (const o of this.orders.values()) {
      if (o.status === OPEN && o.expiry <= this.clock) {
        const kind = o.side === BUY ? 'funds' : 'securities';
        this.release(kind, o.frozenRemain);
        const expiredQty = o.remaining;
        o.remaining = 0;
        o.frozenRemain = 0;
        o.status = 'expired';
        this.emit(seq, 'expired', {
          clOrdId: o.clOrdId,
          qty: expiredQty,
          releasedFunds: o.side === BUY ? expiredQty * o.price : 0,
          releasedSecurities: o.side === SELL ? expiredQty : 0,
        });
      }
    }
  }

  // Duplicate clOrdId with identical payload is an idempotent retransmission;
  // with a different payload it is a hard error (exit 4).
  checkClOrd(frame) {
    if (frame.clOrdId === undefined) return 'fresh';
    const { crc, seq, ts, ...payload } = frame;
    const key = canonical(payload);
    const prev = this.payloads.get(frame.clOrdId);
    if (prev === undefined) {
      this.payloads.set(frame.clOrdId, key);
      return 'fresh';
    }
    if (prev !== key) {
      throw new ExitError(4, `duplicate clOrdId ${JSON.stringify(frame.clOrdId)} with different payload`);
    }
    return 'duplicate';
  }

  getOrder(id) {
    const o = this.orders.get(id);
    if (!o) throw new ExitError(3, `unknown origId ${JSON.stringify(id)}`);
    return o;
  }

  dispatch(f) {
    switch (f.type) {
      case 'limits': return this.onLimits(f);
      case 'new': return this.onNew(f);
      case 'amend': return this.onAmend(f);
      case 'cancel': return this.onCancel(f);
      case 'match': return this.onMatch(f);
      case 'settle': return this.onSettle(f);
      case 'fail': return this.onFail(f);
      default: throw new ExitError(2, `unknown type ${JSON.stringify(f.type)}`);
    }
  }

  onLimits(f) {
    this.advance(f.ts, f.seq);
    if (f.funds !== undefined) this.limits.funds = f.funds;
    if (f.securities !== undefined) this.limits.securities = f.securities;
    if (f.window !== undefined) this.window = f.window;
    this.emit(f.seq, 'limits_set', {
      funds: this.limits.funds,
      securities: this.limits.securities,
      window: this.window,
    });
  }

  onNew(f) {
    this.advance(f.ts, f.seq);
    if (this.checkClOrd(f) === 'duplicate') {
      this.emit(f.seq, 'duplicate_ignored', { clOrdId: f.clOrdId });
      return;
    }
    const kind = f.side === BUY ? 'funds' : 'securities';
    const cost = f.side === BUY ? f.qty * f.price : f.qty;
    const order = {
      clOrdId: f.clOrdId, side: f.side, qty: f.qty, price: f.price,
      filled: 0, remaining: f.qty, status: OPEN,
      frozenRemain: cost, frozenFilled: 0,
      ts: f.ts, seq: f.seq, expiry: f.ts + this.window,
    };
    this.orders.set(f.clOrdId, order);
    if (!this.freeze(kind, cost)) {
      order.status = 'rejected';
      order.frozenRemain = 0;
      this.emit(f.seq, 'order_rejected', {
        clOrdId: f.clOrdId,
        reason: kind === 'funds' ? 'insufficient_funds' : 'insufficient_securities',
      });
      return;
    }
    this.emit(f.seq, 'order_accepted', {
      clOrdId: f.clOrdId, side: f.side, qty: f.qty, price: f.price, expiry: order.expiry,
    });
  }

  onAmend(f) {
    this.advance(f.ts, f.seq);
    if (this.checkClOrd(f) === 'duplicate') {
      this.emit(f.seq, 'duplicate_ignored', { clOrdId: f.clOrdId });
      return;
    }
    const o = this.getOrder(f.origId); // exit 3 when unknown
    if (o.status !== OPEN) {
      this.emit(f.seq, 'amend_rejected', { clOrdId: f.clOrdId, origId: f.origId, reason: 'not_open', status: o.status });
      return;
    }
    const newQty = f.qty === undefined ? o.qty : f.qty;
    const newPrice = f.price === undefined ? o.price : f.price;
    // The filled portion is immutable: an amend may not cross below it.
    if (newQty < o.filled) {
      this.emit(f.seq, 'amend_rejected', { clOrdId: f.clOrdId, origId: f.origId, reason: 'crosses_filled', filled: o.filled });
      return;
    }
    const kind = o.side === BUY ? 'funds' : 'securities';
    const target = o.side === BUY ? (newQty - o.filled) * newPrice : newQty - o.filled;
    const delta = target - o.frozenRemain;
    if (delta > 0 && !this.freeze(kind, delta)) {
      this.emit(f.seq, 'amend_rejected', {
        clOrdId: f.clOrdId, origId: f.origId,
        reason: kind === 'funds' ? 'insufficient_funds' : 'insufficient_securities',
      });
      return;
    }
    if (delta < 0) this.release(kind, -delta);
    const old = { qty: o.qty, price: o.price };
    o.qty = newQty;
    o.price = newPrice;
    o.remaining = newQty - o.filled;
    o.frozenRemain = target;
    o.ts = f.ts; // amend loses time priority
    o.seq = f.seq;
    this.emit(f.seq, 'amend_accepted', {
      clOrdId: f.clOrdId, origId: f.origId,
      oldQty: old.qty, oldPrice: old.price,
      qty: newQty, price: newPrice, remaining: o.remaining,
    });
  }

  onCancel(f) {
    this.advance(f.ts, f.seq);
    if (this.checkClOrd(f) === 'duplicate') {
      this.emit(f.seq, 'duplicate_ignored', { clOrdId: f.clOrdId });
      return;
    }
    const o = this.getOrder(f.origId); // exit 3 when unknown
    if (o.status !== OPEN) {
      this.emit(f.seq, 'cancel_rejected', { origId: f.origId, reason: 'not_open', status: o.status });
      return;
    }
    const kind = o.side === BUY ? 'funds' : 'securities';
    const released = o.frozenRemain;
    this.release(kind, released);
    const cancelledQty = o.remaining;
    o.remaining = 0;
    o.frozenRemain = 0;
    o.status = 'cancelled';
    this.emit(f.seq, 'cancel_accepted', {
      origId: f.origId,
      qty: cancelledQty,
      releasedFunds: o.side === BUY ? released : 0,
      releasedSecurities: o.side === SELL ? released : 0,
    });
  }

  onMatch(f) {
    this.advance(f.ts, f.seq); // window expiry is settled before matching
    const byId = (a, b) => (a.clOrdId < b.clOrdId ? -1 : a.clOrdId > b.clOrdId ? 1 : 0);
    // Price-time priority; same price and same timestamp break by clOrdId.
    const buys = [...this.orders.values()]
      .filter((o) => o.status === OPEN && o.side === BUY && o.remaining > 0)
      .sort((a, b) => b.price - a.price || a.ts - b.ts || byId(a, b));
    const sells = [...this.orders.values()]
      .filter((o) => o.status === OPEN && o.side === SELL && o.remaining > 0)
      .sort((a, b) => a.price - b.price || a.ts - b.ts || byId(a, b));
    let bi = 0;
    let si = 0;
    while (bi < buys.length && si < sells.length) {
      const b = buys[bi];
      const s = sells[si];
      if (b.price < s.price) break;
      // Execution price: the maker's (earlier resting) price.
      const maker = (b.ts < s.ts || (b.ts === s.ts && b.clOrdId <= s.clOrdId)) ? b : s;
      const px = maker.price;
      const q = Math.min(b.remaining, s.remaining);
      // DvP: both legs must be deliverable at once, otherwise the whole
      // pairing is rejected and neither side is deducted.
      if (b.frozenRemain < px * q || s.frozenRemain < q) {
        this.emit(f.seq, 'pair_rejected', { buyId: b.clOrdId, sellId: s.clOrdId, qty: q, price: px });
        break;
      }
      b.frozenRemain -= b.price * q;
      const improvement = (b.price - px) * q;
      if (improvement > 0) this.release('funds', improvement);
      b.frozenFilled += px * q;
      s.frozenRemain -= q;
      s.frozenFilled += q;
      b.filled += q;
      b.remaining -= q;
      s.filled += q;
      s.remaining -= q;
      if (b.remaining === 0) b.status = 'filled';
      if (s.remaining === 0) s.status = 'filled';
      const fill = {
        fillId: 'F' + (this.fills.length + 1),
        buyId: b.clOrdId, sellId: s.clOrdId,
        qty: q, price: px, seq: f.seq, ts: this.clock,
        settled: false, compensated: false,
      };
      this.fills.push(fill);
      this.emit(f.seq, 'fill', {
        fillId: fill.fillId, buyId: fill.buyId, sellId: fill.sellId,
        qty: q, price: px, buyRemaining: b.remaining, sellRemaining: s.remaining,
      });
      if (b.remaining === 0) bi++;
      if (s.remaining === 0) si++;
    }
  }

  onSettle(f) {
    this.advance(f.ts, f.seq);
    let targets = this.fills.filter((fl) => !fl.settled);
    if (f.origId !== undefined) {
      this.getOrder(f.origId); // exit 3 when unknown
      targets = targets.filter((fl) => fl.buyId === f.origId || fl.sellId === f.origId);
    }
    for (const fl of targets) {
      fl.settled = true;
      // Finalize: frozen balances become delivered (spent). Append-only.
      this.frozen.funds -= fl.qty * fl.price;
      this.spent.funds += fl.qty * fl.price;
      this.frozen.securities -= fl.qty;
      this.spent.securities += fl.qty;
      this.orders.get(fl.buyId).frozenFilled -= fl.qty * fl.price;
      this.orders.get(fl.sellId).frozenFilled -= fl.qty;
      this.emit(f.seq, 'settled', { fillId: fl.fillId, qty: fl.qty, price: fl.price });
    }
  }

  onFail(f) {
    this.advance(f.ts, f.seq);
    this.getOrder(f.origId); // exit 3 when unknown
    // After settlement the ledger cannot be erased; fail only appends a
    // compensation entry that economically reverses the settled fill.
    const targets = this.fills.filter(
      (fl) => fl.settled && !fl.compensated && (fl.buyId === f.origId || fl.sellId === f.origId),
    );
    if (targets.length === 0) {
      this.emit(f.seq, 'fail_rejected', { origId: f.origId, reason: 'no_settled_fills' });
      return;
    }
    for (const fl of targets) {
      fl.compensated = true;
      this.spent.funds -= fl.qty * fl.price;
      this.spent.securities -= fl.qty;
      const comp = {
        fillId: fl.fillId, triggeredBy: f.origId,
        fundsCredited: fl.qty * fl.price, securitiesCredited: fl.qty,
      };
      this.compensations.push(comp);
      this.emit(f.seq, 'fail_compensation', { ...comp });
    }
  }

  result() {
    const acct = (kind) => ({
      limit: this.limits[kind],
      frozen: this.frozen[kind],
      spent: this.spent[kind],
      available: this.limits[kind] === null ? null : this.available(kind),
    });
    return {
      ok: true,
      clock: this.clock,
      window: this.window,
      accounts: { funds: acct('funds'), securities: acct('securities') },
      orders: [...this.orders.values()].map((o) => ({
        clOrdId: o.clOrdId, side: o.side, qty: o.qty, price: o.price,
        filled: o.filled, remaining: o.remaining, status: o.status,
        frozenRemain: o.frozenRemain, frozenFilled: o.frozenFilled, expiry: o.expiry,
      })),
      fills: this.fills.map((fl) => ({ ...fl })),
      compensations: this.compensations.map((c) => ({ ...c })),
      events: this.events.map((ev) => ({ ...ev })),
      auditRoot: this.auditRoot,
    };
  }
}

// Dedup retransmissions by seq, replay in log (seq) order.
function run(frames) {
  const bySeq = new Map();
  const uniq = [];
  for (const f of frames) {
    const key = canonical(f);
    const prev = bySeq.get(f.seq);
    if (prev !== undefined) {
      if (prev !== key) throw new ExitError(2, `conflicting retransmission for seq ${f.seq}`);
      continue;
    }
    bySeq.set(f.seq, key);
    uniq.push(f);
  }
  uniq.sort((a, b) => a.seq - b.seq);
  const eng = new Engine();
  for (const f of uniq) eng.dispatch(f);
  return eng.result();
}

module.exports = { Engine, run };
