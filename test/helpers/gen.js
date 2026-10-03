// Seeded random event-stream generator. Produces only domain-valid events
// (no E_NEG/E_VERSION/E_SEQ failures) so the fuzz test can compare the VM
// against the reference fold prefix by prefix.
import { recordHash } from '../../src/hash.js';

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATES = ['2024-01-15', '2024-01-16', '2024-01-17'];
const ISINS = ['US0378331005', 'US5949181045', 'XS0987654321', 'US88160R1014'];

function priceKindOf(isin) { return isin.startsWith('XS') ? 'gross' : 'net'; }

export function genEvents(seed, n = 200) {
  const rnd = mulberry32(seed);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const money = () => Math.round(rnd() * 20000) / 100 + 10;
  const feeAmt = () => Math.round(rnd() * 500) / 100;

  const trades = new Map();
  let counter = 0;
  let seq = 0;
  const events = [];

  function effective(t) {
    let bestVer = -1;
    for (const v of t.versions.keys()) {
      if (t.tomb.has(v) || t.versions.get(v).size === 0) continue;
      if (v > bestVer) bestVer = v;
    }
    if (bestVer < 0) return null;
    let best = null;
    for (const rec of t.versions.get(bestVer).values()) {
      if (best === null || rec.hash < best.hash) best = rec;
    }
    return best;
  }

  function netOk() {
    const net = new Map();
    for (const t of trades.values()) {
      const e = effective(t);
      if (!e) continue;
      const k = `${e.date}|${e.isin}`;
      net.set(k, (net.get(k) || 0) + (e.side === 'buy' ? e.qty : -e.qty));
    }
    for (const v of net.values()) if (v < 0) return false;
    return true;
  }

  function priceText(p) {
    const r = rnd();
    if (r < 0.6) return p.toFixed(2);
    if (r < 0.8) {
      const a = Math.floor(p);
      const b = Math.round((p - a) * 100) / 100;
      return `${a} + ${b.toFixed(2)}`;
    }
    return `(${p.toFixed(2)})`;
  }

  function recText(kind, rec) {
    const base = `${kind} ${rec.id} v${rec.version} on ${rec.date} ${rec.side} ${rec.qty} ${rec.isin} @ ${priceText(rec.price)} ${rec.priceKind}`;
    return rec.fee ? `${base} fee ${rec.fee.toFixed(2)}` : base;
  }

  function mkRec(id, version, date, side, qty, isin) {
    const rec = { id, version, date, side, qty, isin, priceKind: priceKindOf(isin), price: money(), fee: feeAmt() };
    rec.hash = recordHash(rec);
    return rec;
  }

  function insert(t, rec) {
    if (!t.versions.has(rec.version)) t.versions.set(rec.version, new Map());
    t.versions.get(rec.version).set(rec.hash, rec);
  }

  while (events.length < n) {
    const r = rnd();
    if (r < 0.45 || trades.size === 0) {
      const date = pick(DATES);
      const isin = pick(ISINS);
      let side = rnd() < 0.65 ? 'buy' : 'sell';
      let qty = 1 + Math.floor(rnd() * 50);
      if (side === 'sell') {
        let avail = 0;
        for (const t of trades.values()) {
          const e = effective(t);
          if (e && e.date === date && e.isin === isin) avail += e.side === 'buy' ? e.qty : -e.qty;
        }
        if (avail < 1) side = 'buy';
        else qty = 1 + Math.floor(rnd() * Math.min(50, avail));
      }
      const rec = mkRec(`T${++counter}`, 1, date, side, qty, isin);
      const t = { date, versions: new Map(), tomb: new Set() };
      insert(t, rec);
      trades.set(rec.id, t);
      seq++;
      events.push({ seq, text: recText('trade', rec) });
    } else if (r < 0.75) {
      const id = pick([...trades.keys()]);
      const t = trades.get(id);
      const eff = effective(t);
      if (!eff) continue;
      const maxVer = Math.max(...t.versions.keys());
      const concurrent = rnd() < 0.25;
      const ver = concurrent ? 1 + Math.floor(rnd() * maxVer) : maxVer + 1;
      const cand = mkRec(id, ver, t.date, eff.side, 1 + Math.floor(rnd() * 60), eff.isin);
      const saved = t.versions.get(ver) ? new Map(t.versions.get(ver)) : null;
      insert(t, cand);
      if (!netOk()) {
        if (saved) t.versions.set(ver, saved);
        else t.versions.delete(ver);
        continue;
      }
      seq++;
      events.push({ seq, text: recText('amend', cand) });
    } else if (r < 0.9) {
      const id = pick([...trades.keys()]);
      const t = trades.get(id);
      const live = [...t.versions.keys()].filter((v) => !t.tomb.has(v));
      if (live.length === 0) continue;
      const v = pick(live);
      t.tomb.add(v);
      if (!netOk()) { t.tomb.delete(v); continue; }
      seq++;
      events.push({ seq, text: `revoke ${id} v${v} on ${t.date}` });
    } else {
      if (events.length === 0) continue;
      const prev = events[events.length - 1];
      events.push({ seq: prev.seq, text: prev.text }); // idempotent replay
    }
  }
  return events;
}
