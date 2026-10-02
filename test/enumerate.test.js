import test from 'node:test';
import assert from 'node:assert/strict';
import { ReleaseEngine } from '../src/engine.js';

// Acceptance 3: enumerate every event sequence of length <= 6 drawn from a
// 6-event pool (1956 sequences) and check the engine against an independent
// reference state machine plus structural invariants.

const POOL = [
  { kind: 'cip', eventTs: 0, line: 'L1', start: -100, end: 0, ok: true, op: 'c1' },
  { kind: 'fill', eventTs: 100, batch: 'b1', vol: 100, weight: 100, op: 'f1' }, // density 1.0 ok
  { kind: 'fill', eventTs: 200, batch: 'b1', vol: 100, weight: 200, op: 'f2' }, // density 2.0 bad
  { kind: 'lab', eventTs: 300, batch: 'b1', pass: true, op: 'l1' },
  { kind: 'retract', eventTs: 400, target: 'cip', id: 'c1' },
  { kind: 'retract', eventTs: 500, target: 'lab', id: 'l1' },
];

// Reference oracle: status as a pure function of the final active event set.
function oracleStatus(events) {
  const active = [];
  for (const e of events) {
    if (e.kind === 'retract') {
      const i = active.findIndex((x) => x.kind === e.target && x.op === e.id);
      if (i >= 0) active.splice(i, 1);
    } else {
      active.push(e);
    }
  }
  const cips = active.filter((e) => e.kind === 'cip');
  const fills = active.filter((e) => e.kind === 'fill' && e.batch === 'b1');
  const labs = active.filter((e) => e.kind === 'lab' && e.batch === 'b1');
  const lab = labs.length ? labs[labs.length - 1] : null;

  if (fills.some((f) => !(f.vol > 0))) return 'REJECT';
  if (fills.some((f) => f.weight / f.vol < 0.95 || f.weight / f.vol > 1.05)) return 'REJECT';
  if (fills.length === 0) return 'HOLD';
  const inWindow = (ts) => {
    let lastOk = null;
    for (const c of cips) if (c.ok && c.end <= ts && (!lastOk || c.end > lastOk.end)) lastOk = c;
    if (!lastOk) return false;
    return !cips.some((c) => c !== lastOk && c.start >= lastOk.end && c.start <= ts);
  };
  if (fills.some((f) => !inWindow(f.eventTs))) return 'HOLD';
  if (!lab) return 'HOLD';
  if (!lab.pass) return 'HOLD';
  return 'RELEASE';
}

function* sequences(pool, maxLen, prefix = []) {
  if (prefix.length > 0) yield prefix;
  if (prefix.length === maxLen) return;
  for (let i = 0; i < pool.length; i += 1) {
    const rest = [...pool.slice(0, i), ...pool.slice(i + 1)];
    yield* sequences(rest, maxLen, [...prefix, pool[i]]);
  }
}

function checkInvariants(engine, seqLabel) {
  const versions = new Map();
  for (const t of engine.transitions) {
    assert.notEqual(t.from, t.to, `${seqLabel}: self transition`);
    assert.notEqual(t.from, 'REJECT', `${seqLabel}: transition out of REJECT`);
    const prev = versions.get(t.batch) ?? 0;
    assert.equal(t.version, prev + 1, `${seqLabel}: versions must increase by 1`);
    versions.set(t.batch, t.version);
    if (t.from === 'RELEASE' && t.to === 'HOLD') {
      assert.ok(
        engine.comps.some((c) => c.seq === t.seq),
        `${seqLabel}: RELEASE->HOLD must carry a compensation record`,
      );
    }
  }
  for (const c of engine.comps) {
    assert.ok(
      engine.transitions.some((t) => t.seq === c.seq && t.from === 'RELEASE' && t.to === 'HOLD'),
      `${seqLabel}: orphan compensation`,
    );
  }
}

test('acceptance 3: all 1956 sequences of <=6 events match the reference state machine', () => {
  let count = 0;
  const tally = { HOLD: 0, RELEASE: 0, REJECT: 0 };
  for (const seq of sequences(POOL, 6)) {
    count += 1;
    const engine = new ReleaseEngine();
    for (const e of seq) engine.process(e); // must never throw (monotonicity is enforced inside)
    const label = seq.map((e) => e.op ?? `${e.target}:${e.id}`).join(',');
    checkInvariants(engine, label);
    const final = engine.batches.get('b1');
    const expected = oracleStatus(seq);
    if (!final) {
      // No fill/lab for b1 seen yet: the batch does not exist and the
      // reference machine can only be in HOLD.
      assert.equal(expected, 'HOLD', `${label}: no batch but oracle not HOLD`);
      continue;
    }
    assert.equal(final.status, expected, `${label}: status mismatch`);
    tally[expected] += 1;
  }
  assert.equal(count, 1956);
  // Sanity: the enumeration actually exercises all three statuses.
  assert.ok(tally.HOLD > 0 && tally.RELEASE > 0 && tally.REJECT > 0, JSON.stringify(tally));
});
