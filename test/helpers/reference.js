// Independent fold reference used by the fuzz test. It shares only the
// lexer/parser/checker and small pure helpers with the production code;
// it does NOT use the bytecode compiler or the VM. For every prefix it
// recomputes the state from scratch by naive folding of effective versions.
import { parse } from '../../src/parser.js';
import { check } from '../../src/checker.js';
import { eventHash, recordHash } from '../../src/hash.js';
import { round6, zeroEntry, isZeroEntry, normalizeEntry } from '../../src/util.js';

function effectiveOf(t) {
  let bestVer = -1;
  for (const v of t.versions.keys()) {
    if (t.tomb.has(v)) continue;
    if (t.versions.get(v).size === 0) continue;
    if (v > bestVer) bestVer = v;
  }
  if (bestVer < 0) return null;
  let best = null;
  for (const rec of t.versions.get(bestVer).values()) {
    if (best === null || rec.hash < best.hash) best = rec;
  }
  return best;
}

function snapshotFrom(trades, seq) {
  const ledger = new Map();
  for (const t of trades.values()) {
    const rec = effectiveOf(t);
    if (!rec) continue;
    const key = `${rec.date}|${rec.isin}`;
    const e = ledger.get(key) || zeroEntry();
    const gross = rec.qty * rec.price;
    if (rec.side === 'buy') {
      e.bought += rec.qty;
      e.frozenCash = round6(e.frozenCash + (rec.priceKind === 'net' ? gross + rec.fee : gross));
    } else {
      e.sold += rec.qty;
      e.frozenShares += rec.qty;
      e.proceeds = round6(e.proceeds + (rec.priceKind === 'net' ? gross - rec.fee : gross));
    }
    ledger.set(key, e);
  }
  const ledgerOut = {};
  for (const key of [...ledger.keys()].sort()) {
    const e = ledger.get(key);
    if (isZeroEntry(e)) continue;
    ledgerOut[key] = normalizeEntry(e);
  }
  const tradesOut = {};
  for (const id of [...trades.keys()].sort()) {
    const t = trades.get(id);
    const eff = effectiveOf(t);
    tradesOut[id] = {
      date: t.date,
      effective: eff ? { version: eff.version, hash: eff.hash } : null,
      versions: [...t.versions.keys()].sort((a, b) => a - b),
      tombstoned: [...t.tomb].sort((a, b) => a - b),
    };
  }
  return { seq, ledger: ledgerOut, trades: tradesOut };
}

// Returns one snapshot per input event (prefix states).
export function referencePrefixes(events) {
  const trades = new Map();
  let lastSeq = 0;
  let lastHash = null;
  const snaps = [];
  for (const evt of events) {
    const hash = eventHash(evt);
    if (evt.seq === lastSeq && hash === lastHash) {
      snaps.push(snapshotFrom(trades, lastSeq));
      continue;
    }
    const stmt = check(parse(evt.text));
    if (stmt.kind === 'revoke') {
      trades.get(stmt.id).tomb.add(stmt.version);
    } else {
      const rec = {
        id: stmt.id, version: stmt.version, date: stmt.date, side: stmt.side,
        qty: stmt.qty, isin: stmt.isin, priceKind: stmt.priceKind,
        price: stmt.price, fee: stmt.fee,
      };
      rec.hash = recordHash(rec);
      let t = trades.get(rec.id);
      if (!t) { t = { date: rec.date, versions: new Map(), tomb: new Set() }; trades.set(rec.id, t); }
      if (!t.versions.has(rec.version)) t.versions.set(rec.version, new Map());
      t.versions.get(rec.version).set(rec.hash, rec);
    }
    lastSeq = evt.seq;
    lastHash = hash;
    snaps.push(snapshotFrom(trades, lastSeq));
  }
  return snaps;
}
