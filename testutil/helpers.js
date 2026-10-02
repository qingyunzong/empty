import { createHash } from 'node:crypto';
import { tokenize } from '../src/textindex.js';

// Deterministic PRNG (LCG) so tests are reproducible offline.
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Independent brute-force phrase match over an enumeration of live events.
export function brutePhrase(events, phrase) {
  const terms = tokenize(phrase);
  if (terms.length === 0) return [];
  const out = [];
  for (const ev of events) {
    const tokens = tokenize(ev.text);
    for (let i = 0; i + terms.length <= tokens.length; i++) {
      if (terms.every((t, k) => tokens[i + k] === t)) {
        out.push(ev.id);
        break;
      }
    }
  }
  return out;
}

// Independent brute-force near match: enumerate every text window of size
// `window` (positions p..p+window) and require all terms inside one window.
export function bruteNear(events, terms, window) {
  const norm = terms.map((t) => String(t).toLowerCase());
  const out = [];
  for (const ev of events) {
    const tokens = tokenize(ev.text);
    let hit = false;
    for (let start = 0; start < tokens.length && !hit; start++) {
      const end = Math.min(start + window, tokens.length - 1);
      const inWindow = new Set(tokens.slice(start, end + 1));
      if (norm.every((t) => inWindow.has(t))) hit = true;
    }
    if (hit) out.push(ev.id);
  }
  return out;
}

// Independent per-tradeId grouping used to cross-check the store's report.
export function independentRefundReport(events, undoneTradeIds) {
  const trades = {};
  for (const ev of events) {
    const t = (trades[ev.tradeId] ??= { feeTotal: 0, budget: 0 });
    t.feeTotal += ev.fee;
    t.budget = Math.max(t.budget, ev.refundBudget);
  }
  for (const [tradeId, t] of Object.entries(trades)) {
    t.refundedTotal = undoneTradeIds.has(tradeId) ? t.feeTotal : 0;
    t.budgetRemaining = t.budget - t.refundedTotal;
  }
  return trades;
}
