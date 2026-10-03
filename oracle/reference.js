'use strict';

// Independent reference state machine used as the test oracle.
// Shares no code with lib/engine.js; implements the same spec:
//   hold -> ACTIVE, inc partial up to limit, dec clamped by buffered
//   complete candidates, complete settles + releases, void releases,
//   reverse only after COMPLETED, ttl expiry auto-voids, per-seq dedup.

function summarize(frames, { limit, ttl }) {
  const auths = new Map();
  let clock = 0;

  const get = (id) => {
    if (!auths.has(id)) {
      auths.set(id, {
        status: 'INIT', frozen: 0, charged: 0, nextSeq: 1, expiresAt: 0,
        seen: new Map(), buffer: new Map(), ledger: [],
      });
    }
    return auths.get(id);
  };

  const canon = (f) => JSON.stringify({
    authId: f.authId, type: f.type, amount: f.amount, seq: f.seq, ack: f.ack,
  });

  const led = (a, f, kind, amount) => a.ledger.push({
    clock, seq: f ? f.seq : null, kind, amount,
    frozenAfter: a.frozen, chargedAfter: a.charged,
  });

  const floor = (a) => {
    let m = 0;
    for (const g of a.buffer.values()) if (g.type === 'complete' && g.amount > m) m = g.amount;
    return m;
  };

  const apply = (a, f) => {
    a.nextSeq += 1;
    switch (f.type) {
      case 'hold':
        if (a.status !== 'INIT' || f.amount === 0 || f.amount > limit) return;
        a.frozen = f.amount; a.status = 'ACTIVE'; a.expiresAt = clock + ttl;
        led(a, f, 'hold', f.amount);
        return;
      case 'inc': {
        if (a.status !== 'ACTIVE') return;
        const acc = Math.min(f.amount, Math.max(0, limit - a.frozen - a.charged));
        if (acc > 0) { a.frozen += acc; led(a, f, 'inc', acc); }
        return;
      }
      case 'dec': {
        if (a.status !== 'ACTIVE') return;
        const ap = Math.min(f.amount, Math.max(0, a.frozen - floor(a)));
        if (ap > 0) { a.frozen -= ap; led(a, f, 'dec', ap); }
        return;
      }
      case 'complete': {
        if (a.status !== 'ACTIVE') return;
        if (f.amount > a.frozen) throw Object.assign(new Error('neg'), { code: 4 });
        a.charged += f.amount; a.frozen -= f.amount;
        const rel = a.frozen; a.frozen = 0; a.status = 'COMPLETED';
        led(a, f, 'complete', f.amount);
        if (rel > 0) led(a, f, 'release', rel);
        return;
      }
      case 'void':
        if (a.status !== 'ACTIVE') return;
        const released = a.frozen;
        a.frozen = 0; a.status = 'VOIDED';
        led(a, f, 'void', released);
        return;
      case 'reverse':
        if (a.status !== 'COMPLETED' || f.amount !== a.charged) return;
        a.charged = 0; a.status = 'REVERSED';
        led(a, f, 'reverse', f.amount);
        return;
      default:
    }
  };

  for (const f of frames) {
    clock += 1;
    for (const a of auths.values()) {
      if (a.status === 'ACTIVE' && clock > a.expiresAt) {
        const released = a.frozen;
        a.frozen = 0; a.status = 'VOIDED';
        led(a, null, 'auto_void', released);
      }
    }
    const a = get(f.authId);
    const c = canon(f);
    if (a.seen.has(f.seq)) {
      if (a.seen.get(f.seq) !== c) throw Object.assign(new Error('conflict'), { code: 3 });
      continue;
    }
    a.seen.set(f.seq, c);
    if (f.seq > a.nextSeq) { a.buffer.set(f.seq, f); continue; }
    apply(a, f);
    while (a.buffer.has(a.nextSeq)) {
      const g = a.buffer.get(a.nextSeq);
      a.buffer.delete(a.nextSeq);
      apply(a, g);
    }
  }

  const out = {};
  for (const [id, a] of [...auths.entries()].sort()) {
    out[id] = {
      status: a.status, frozen: a.frozen, charged: a.charged,
      available: limit - a.frozen - a.charged, ack: a.nextSeq - 1, ledger: a.ledger,
    };
  }
  return out;
}

function* permutations(items) {
  const arr = items.slice();
  const n = arr.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  yield arr.slice();
  let i = 1;
  const c = new Array(n).fill(0);
  while (i < n) {
    if (c[i] < i) {
      const j = i % 2 === 0 ? 0 : c[i];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      yield arr.slice();
      c[i] += 1;
      i = 1;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
}

module.exports = { summarize, permutations };
