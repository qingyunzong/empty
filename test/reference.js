'use strict';
// Independent matching reference, used only by the interleaving property test.
// Shares no code with src/engine.js on purpose; semantics are re-derived here
// in a plain functional style.

function refRun(frames) {
  const bySeq = new Map();
  for (const f of frames) if (!bySeq.has(f.seq)) bySeq.set(f.seq, f);
  const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);

  const st = {
    limits: { funds: null, securities: null },
    window: 100,
    frozen: { funds: 0, securities: 0 },
    spent: { funds: 0, securities: 0 },
    clock: 0,
    orders: new Map(),
    fills: [],
    comps: [],
  };
  const kindOf = (o) => (o.side === 'buy' ? 'funds' : 'securities');
  const avail = (k) => (st.limits[k] === null ? Infinity : st.limits[k] - st.frozen[k] - st.spent[k]);

  for (const f of ordered) {
    if (f.ts > st.clock) {
      st.clock = f.ts;
      for (const o of st.orders.values()) {
        if (o.status === 'open' && o.expiry <= st.clock) {
          st.frozen[kindOf(o)] -= o.frozenRemain;
          o.frozenRemain = 0;
          o.remaining = 0;
          o.status = 'expired';
        }
      }
    }
    if (f.type === 'limits') {
      if (f.funds !== undefined) st.limits.funds = f.funds;
      if (f.securities !== undefined) st.limits.securities = f.securities;
      if (f.window !== undefined) st.window = f.window;
    } else if (f.type === 'new') {
      const cost = f.side === 'buy' ? f.qty * f.price : f.qty;
      const kind = kindOf(f);
      const o = {
        clOrdId: f.clOrdId, side: f.side, qty: f.qty, price: f.price,
        filled: 0, remaining: f.qty, status: 'open',
        frozenRemain: cost, frozenFilled: 0, ts: f.ts, expiry: f.ts + st.window,
      };
      if (cost > avail(kind)) {
        o.status = 'rejected';
        o.frozenRemain = 0;
      } else {
        st.frozen[kind] += cost;
      }
      st.orders.set(o.clOrdId, o);
    } else if (f.type === 'cancel') {
      const o = st.orders.get(f.origId);
      if (o && o.status === 'open') {
        st.frozen[kindOf(o)] -= o.frozenRemain;
        o.frozenRemain = 0;
        o.remaining = 0;
        o.status = 'cancelled';
      }
    } else if (f.type === 'match') {
      const id = (a, b) => (a.clOrdId < b.clOrdId ? -1 : 1);
      const buys = [...st.orders.values()]
        .filter((o) => o.status === 'open' && o.side === 'buy' && o.remaining > 0)
        .sort((a, b) => b.price - a.price || a.ts - b.ts || id(a, b));
      const sells = [...st.orders.values()]
        .filter((o) => o.status === 'open' && o.side === 'sell' && o.remaining > 0)
        .sort((a, b) => a.price - b.price || a.ts - b.ts || id(a, b));
      let bi = 0;
      let si = 0;
      while (bi < buys.length && si < sells.length) {
        const b = buys[bi];
        const s = sells[si];
        if (b.price < s.price) break;
        const maker = b.ts < s.ts || (b.ts === s.ts && b.clOrdId <= s.clOrdId) ? b : s;
        const px = maker.price;
        const q = Math.min(b.remaining, s.remaining);
        if (b.frozenRemain < px * q || s.frozenRemain < q) break; // DvP: reject pair
        b.frozenRemain -= b.price * q;
        st.frozen.funds -= (b.price - px) * q;
        b.frozenFilled += px * q;
        s.frozenRemain -= q;
        s.frozenFilled += q;
        b.filled += q;
        b.remaining -= q;
        s.filled += q;
        s.remaining -= q;
        if (b.remaining === 0) b.status = 'filled';
        if (s.remaining === 0) s.status = 'filled';
        st.fills.push({
          fillId: 'F' + (st.fills.length + 1),
          buyId: b.clOrdId, sellId: s.clOrdId, qty: q, price: px,
          settled: false, compensated: false,
        });
        if (b.remaining === 0) bi++;
        if (s.remaining === 0) si++;
      }
    } else if (f.type === 'settle') {
      for (const fl of st.fills) {
        if (fl.settled) continue;
        if (f.origId !== undefined && fl.buyId !== f.origId && fl.sellId !== f.origId) continue;
        fl.settled = true;
        st.frozen.funds -= fl.qty * fl.price;
        st.spent.funds += fl.qty * fl.price;
        st.frozen.securities -= fl.qty;
        st.spent.securities += fl.qty;
        st.orders.get(fl.buyId).frozenFilled -= fl.qty * fl.price;
        st.orders.get(fl.sellId).frozenFilled -= fl.qty;
      }
    } else if (f.type === 'fail') {
      for (const fl of st.fills) {
        if (!fl.settled || fl.compensated) continue;
        if (fl.buyId !== f.origId && fl.sellId !== f.origId) continue;
        fl.compensated = true;
        st.spent.funds -= fl.qty * fl.price;
        st.spent.securities -= fl.qty;
        st.comps.push({
          fillId: fl.fillId, triggeredBy: f.origId,
          fundsCredited: fl.qty * fl.price, securitiesCredited: fl.qty,
        });
      }
    }
  }
  const acct = (k) => ({
    limit: st.limits[k],
    frozen: st.frozen[k],
    spent: st.spent[k],
    available: st.limits[k] === null ? null : st.limits[k] - st.frozen[k] - st.spent[k],
  });
  return {
    accounts: { funds: acct('funds'), securities: acct('securities') },
    orders: [...st.orders.values()].map((o) => ({
      clOrdId: o.clOrdId, status: o.status, filled: o.filled, remaining: o.remaining,
    })),
    fills: st.fills,
    compensations: st.comps,
  };
}

module.exports = { refRun };
