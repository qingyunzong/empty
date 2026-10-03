'use strict';

const crypto = require('node:crypto');

const WINDOW_MS = 10_000;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function merkleRoot(leaves) {
  if (leaves.length === 0) return crypto.createHash('sha256').update('').digest('hex');
  let level = leaves.map((leaf) => sha256(Buffer.from(leaf, 'utf8')));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(sha256(Buffer.concat([level[i], right])));
    }
    level = next;
  }
  return level[0].toString('hex');
}

function windowOf(ts) {
  return Math.floor(ts / WINDOW_MS);
}

function parseRecord(line, lineNo, file, errors) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    errors.push({ file, line: lineNo, reason: 'invalid-json' });
    return null;
  }
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    errors.push({ file, line: lineNo, reason: 'not-an-object' });
    return null;
  }
  for (const field of ['orderId', 'symbol', 'qty', 'price', 'ts']) {
    if (!(field in rec)) {
      errors.push({ file, line: lineNo, reason: `missing-field:${field}` });
      return null;
    }
  }
  if (typeof rec.orderId !== 'string' || rec.orderId.length === 0) {
    errors.push({ file, line: lineNo, reason: 'bad-orderId' });
    return null;
  }
  if (typeof rec.symbol !== 'string' || rec.symbol.length === 0) {
    errors.push({ file, line: lineNo, reason: 'bad-symbol' });
    return null;
  }
  if (!Number.isFinite(rec.qty) || rec.qty <= 0) {
    errors.push({ file, line: lineNo, reason: 'qty-not-positive' });
    return null;
  }
  if (!Number.isInteger(rec.price)) {
    errors.push({ file, line: lineNo, reason: 'price-not-integer-cents' });
    return null;
  }
  if (!Number.isFinite(rec.ts) || rec.ts < 0) {
    errors.push({ file, line: lineNo, reason: 'bad-ts' });
    return null;
  }
  return {
    orderId: rec.orderId,
    symbol: rec.symbol,
    qty: rec.qty,
    price: rec.price,
    ts: rec.ts,
    line: lineNo,
  };
}

function parseStream(text, file, errors) {
  const records = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    const rec = parseRecord(line, i + 1, file, errors);
    if (rec) records.push(rec);
  }
  return records;
}

function joinStreams(tradesText, cancelsText) {
  const errors = [];
  const trades = parseStream(tradesText, 'trades', errors);
  const cancels = parseStream(cancelsText, 'cancels', errors);

  const tradeWm = trades.reduce((m, t) => Math.max(m, t.ts), -Infinity);
  const cancelWm = cancels.reduce((m, c) => Math.max(m, c.ts), -Infinity);
  // A window is closed once both sides' watermarks have moved past it.
  const closedThreshold = Math.min(
    tradeWm === -Infinity ? Infinity : windowOf(tradeWm),
    cancelWm === -Infinity ? Infinity : windowOf(cancelWm),
  );

  const keyOf = (r) => JSON.stringify([r.orderId, r.symbol]);

  const tradesByKey = new Map();
  for (const t of trades) {
    const key = keyOf(t);
    if (!tradesByKey.has(key)) tradesByKey.set(key, []);
    tradesByKey.get(key).push(t);
  }
  for (const list of tradesByKey.values()) {
    list.sort((a, b) => a.ts - b.ts || a.line - b.line);
  }

  const cancelsByKey = new Map();
  for (const c of cancels) {
    const key = keyOf(c);
    if (!cancelsByKey.has(key)) cancelsByKey.set(key, []);
    cancelsByKey.get(key).push(c);
  }
  // The same cancel arriving more than once takes effect only once:
  // dedupe by full content, keeping the first occurrence's line number.
  for (const [key, list] of cancelsByKey) {
    const seen = new Set();
    const unique = [];
    for (const c of list) {
      const id = JSON.stringify([c.orderId, c.symbol, c.qty, c.price, c.ts]);
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(c);
    }
    unique.sort((a, b) => a.ts - b.ts || a.line - b.line);
    cancelsByKey.set(key, unique);
  }

  const fills = [];
  const orphanCancels = [];
  const lateJoins = [];
  const summary = new Map();

  const addSummary = (symbol, qty, price) => {
    const cur = summary.get(symbol) || { qty: 0, amountCents: 0 };
    cur.qty += qty;
    cur.amountCents += qty * price;
    summary.set(symbol, cur);
  };

  const allKeys = new Set([...tradesByKey.keys(), ...cancelsByKey.keys()]);

  for (const key of allKeys) {
    const tList = tradesByKey.get(key) || [];
    const cList = cancelsByKey.get(key) || [];
    const tradeStates = tList.map((t) => ({ trade: t, remaining: t.qty }));
    const totalQty = tList.reduce((s, t) => s + t.qty, 0);

    for (const c of cList) {
      if (tList.length === 0) {
        orphanCancels.push({
          orderId: c.orderId,
          symbol: c.symbol,
          qty: c.qty,
          win: windowOf(c.ts),
          proof: merkleRoot([`cancels:${c.line}`]),
        });
        continue;
      }
      let toApply = c.qty;
      if (toApply > totalQty) {
        orphanCancels.push({
          orderId: c.orderId,
          symbol: c.symbol,
          qty: toApply - totalQty,
          win: windowOf(c.ts),
          proof: merkleRoot([`cancels:${c.line}`]),
        });
        toApply = totalQty;
      }
      for (const state of tradeStates) {
        if (toApply <= 0) break;
        if (state.remaining <= 0) continue;
        const t = state.trade;
        const take = Math.min(state.remaining, toApply);
        toApply -= take;
        const matchWin = Math.max(windowOf(t.ts), windowOf(c.ts));
        const entry = {
          orderId: t.orderId,
          symbol: t.symbol,
          qty: take,
          win: matchWin,
          proof: merkleRoot([`trades:${t.line}`, `cancels:${c.line}`]),
        };
        if (matchWin < closedThreshold) {
          // The match belongs to an already-closed window: report it as a
          // late-join without touching the published window or the summary.
          lateJoins.push({ ...entry, cancelWin: windowOf(c.ts) });
        } else {
          state.remaining -= take;
          fills.push(entry);
        }
      }
      if (toApply > 0) {
        orphanCancels.push({
          orderId: c.orderId,
          symbol: c.symbol,
          qty: toApply,
          win: windowOf(c.ts),
          proof: merkleRoot([`cancels:${c.line}`]),
        });
      }
    }

    for (const state of tradeStates) {
      if (state.remaining <= 0) continue;
      const t = state.trade;
      fills.push({
        orderId: t.orderId,
        symbol: t.symbol,
        qty: state.remaining,
        win: windowOf(t.ts),
        proof: merkleRoot([`trades:${t.line}`]),
      });
      // Only the uncancelled remainder is settleable; cancelled chunks stay
      // in fills as join evidence but never count toward the day-end amount.
      addSummary(t.symbol, state.remaining, t.price);
      state.remaining = 0;
    }
  }

  const byWinThenOrder = (a, b) =>
    a.win - b.win || (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0);
  fills.sort(byWinThenOrder);
  orphanCancels.sort(byWinThenOrder);
  lateJoins.sort(byWinThenOrder);

  const symbols = {};
  for (const [symbol, agg] of [...summary.entries()].sort()) {
    symbols[symbol] = agg;
  }

  return { fills, orphanCancels, lateJoins, symbols, errors };
}

module.exports = { joinStreams, merkleRoot, windowOf, WINDOW_MS };
