import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

// Differential test: enumerate every event sequence of length 1..6 over a
// small alphabet and compare the engine against an independent model, plus
// global invariants (monotonic audit log, REJECT absorbing for labs, no
// pending-as-unsatisfiable).

const CIP0 = { type: 'cip', eventTs: 0, line: 'L1', start: -2000, end: -1000, ok: true, op: 'cip-0' };
const DMIN = 0.95, DMAX = 1.10;

const ALPHABET = [
  { type: 'fill', eventTs: 1000, batch: 'B', vol: 500, weight: 500, op: 'f-good' }, // density 1.0
  { type: 'fill', eventTs: 2000, batch: 'B', vol: 500, weight: 100, op: 'f-bad' },  // density 0.2
  { type: 'lab', eventTs: 3000, batch: 'B', pass: true, op: 'l-pass' },
  { type: 'lab', eventTs: 4000, batch: 'B', pass: false, op: 'l-fail' },
  { type: 'retract', eventTs: 5000, kind: 'lab', id: 'l-pass' },
  { type: 'retract', eventTs: 6000, kind: 'fill', id: 'f-bad' },
];

// Independent reference model: final state as a pure function of the sequence.
function modelState(seq) {
  const fills = new Map();
  const labs = new Map();
  for (const e of seq) {
    if (e.type === 'fill') { if (!fills.has(e.op)) fills.set(e.op, e); }
    else if (e.type === 'lab') { if (!labs.has(e.op)) labs.set(e.op, e); }
    else if (e.type === 'retract') {
      if (e.kind === 'fill') fills.delete(e.id);
      else if (e.kind === 'lab') labs.delete(e.id);
    }
  }
  if (fills.size === 0) return 'EMPTY';
  for (const f of fills.values()) {
    if (!(f.vol > 0)) return 'REJECT';
    const d = f.weight / f.vol;
    if (!(d >= DMIN && d <= DMAX)) return 'REJECT';
  }
  let state = 'HOLD';
  for (const l of labs.values()) { // arrival order (Map insertion order)
    if (state !== 'HOLD') break;
    state = l.pass ? 'RELEASE' : 'REJECT';
  }
  return state;
}

function* sequences(alphabet, maxLen, prefix = []) {
  if (prefix.length > 0) yield prefix;
  if (prefix.length === maxLen) return;
  for (const e of alphabet) yield* sequences(alphabet, maxLen, [...prefix, e]);
}

test('enumerate all sequences of <=6 events against the reference state machine', () => {
  let checked = 0;
  for (const seq of sequences(ALPHABET, 6)) {
    const e = new Engine();
    e.process(CIP0);
    for (const ev of seq) e.process(ev);

    // 1. final state matches the independent model
    assert.equal(e.state.get('B')?.state ?? 'EMPTY', modelState(seq), `seq=${seq.map((s) => s.op ?? s.id).join(',')}`);

    // 2. audit log is append-only with strictly monotonic seq
    for (let i = 1; i < e.transitions.length; i++) {
      assert.ok(e.transitions[i].seq > e.transitions[i - 1].seq);
    }

    // 3. a lab event never flips REJECT -> RELEASE
    assert.ok(!e.transitions.some((t) => t.trigger === 'lab' && t.from === 'REJECT'));

    // 4. pending is never conflated with unsatisfiable: fills present, no lab
    //    applied and no hard violation implies HOLD, never REJECT
    const activeLabs = new Map();
    for (const s of seq) {
      if (s.type === 'lab') { if (!activeLabs.has(s.op)) activeLabs.set(s.op, s); }
      else if (s.type === 'retract' && s.kind === 'lab') activeLabs.delete(s.id);
    }
    const cur = e.state.get('B') ?? { state: 'EMPTY', reason: 'NO_FILL' };
    if (cur.state === 'HOLD') assert.equal(cur.reason, 'AWAITING_LAB');
    if (activeLabs.size === 0) assert.notEqual(cur.state, 'RELEASE');

    checked++;
  }
  assert.equal(checked, 6 + 36 + 216 + 1296 + 7776 + 46656); // 55986
});
