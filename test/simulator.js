// Independent reference simulator for the trunk-only op set.
// Shares no code with src/engine.js; rationals are [num, den] BigInt pairs.

function gcd(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}
const mk = (n, d = 1n) => {
  n = BigInt(n); d = BigInt(d);
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return [n / g, d / g];
};
const add = (a, b) => mk(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const sub = (a, b) => mk(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const cmp = (a, b) => { const l = a[0] * b[1], r = b[0] * a[1]; return l < r ? -1 : l > r ? 1 : 0; };
const fmt = (a) => (a[1] === 1n ? `${a[0]}` : `${a[0]}/${a[1]}`);

function parseFrac(s) {
  const t = String(s).trim();
  let m;
  if ((m = /^([+-]?\d+)\/(\d+)$/.exec(t))) return mk(BigInt(m[1]), BigInt(m[2]));
  if ((m = /^([+-]?\d+)$/.exec(t))) return mk(BigInt(m[1]));
  throw new Error('bad fraction');
}

function roundCents([n, d]) {
  const N = n * 100n;
  let q = N / d, r = N % d;
  if (r < 0n) r = -r;
  if (r * 2n > d || (r * 2n === d && q % 2n !== 0n)) q += N < 0n ? -1n : 1n;
  return mk(q, 100n);
}

// ops: plain op objects (no capId); returns {results, state}
export function simulate(limitStr, ops) {
  const limit = parseFrac(limitStr);
  const holds = new Map();    // tx -> frac
  const captures = new Map(); // id -> {tx, settled}
  let frozen = mk(0n), captured = mk(0n), capSeq = 0;
  const results = [];

  for (const op of ops) {
    const fail = (code) => results.push({ ok: false, code });
    try {
      switch (op.op) {
        case 'freeze': {
          const amt = parseFrac(op.amt);
          if (holds.has(op.tx)) { fail('E_STATE'); break; }
          if (cmp(amt, mk(0n)) <= 0) { fail('E_STATE'); break; }
          if (cmp(amt, sub(sub(limit, frozen), captured)) > 0) { fail('E_STATE'); break; }
          holds.set(op.tx, amt);
          frozen = add(frozen, amt);
          results.push({ ok: true });
          break;
        }
        case 'capture': {
          const hold = holds.get(op.tx);
          if (!hold) { fail('E_REF'); break; }
          const amt = parseFrac(op.amt);
          if (cmp(amt, mk(0n)) <= 0) { fail('E_STATE'); break; }
          if (cmp(amt, hold) > 0) { fail('E_STATE'); break; }
          const settled = roundCents(amt);
          if (cmp(settled, mk(0n)) <= 0) { fail('E_STATE'); break; }
          const f2 = sub(frozen, amt), c2 = add(captured, settled);
          if (cmp(add(f2, c2), limit) > 0) { fail('E_STATE'); break; }
          const id = `c${capSeq++}`;
          frozen = f2; captured = c2;
          const rem = sub(hold, amt);
          if (rem[0] === 0n) holds.delete(op.tx); else holds.set(op.tx, rem);
          captures.set(id, { tx: op.tx, settled });
          results.push({ ok: true, capId: id });
          break;
        }
        case 'void': {
          const hold = holds.get(op.tx);
          if (!hold) { fail('E_REF'); break; }
          frozen = sub(frozen, hold);
          holds.delete(op.tx);
          results.push({ ok: true });
          break;
        }
        case 'reverse': {
          const cands = [...captures.entries()]
            .filter(([id]) => id === op.captureId || id.startsWith(op.captureId));
          if (cands.length === 0) { fail('E_REF'); break; }
          cands.sort((a, b) => {
            const c = cmp(a[1].settled, b[1].settled);
            return c !== 0 ? c : (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
          });
          const [id, cap] = cands[0];
          captured = sub(captured, cap.settled);
          captures.delete(id);
          results.push({ ok: true });
          break;
        }
        default:
          fail('E_PARSE');
      }
    } catch {
      fail('E_PARSE');
    }
  }

  const holdsOut = {}, capturesOut = {};
  for (const [k, v] of holds) holdsOut[k] = fmt(v);
  for (const [k, v] of captures) capturesOut[k] = fmt(v.settled);
  return {
    results,
    state: {
      holds: holdsOut,
      captures: capturesOut,
      frozen: fmt(frozen),
      captured: fmt(captured),
      available: fmt(sub(sub(limit, frozen), captured)),
    },
  };
}
