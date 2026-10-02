import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { DispatchError } from '../src/errors.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const M = 60_000;
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

const tool = (id, cap, ts = T0, ws = T0, we = T0 + 2 * H) => ({
  eventTs: iso(ts), tool: id, cap, windowStart: iso(ws), windowEnd: iso(we), op: 'add',
});
const carrier = (id, lot, qty, ts = T0) => ({
  eventTs: iso(ts), carrier: id, lot, qty, op: 'add',
});
const metro = (lot, score, ts = T0) => ({ eventTs: iso(ts), lot, score, op: 'add' });
const retract = (kind, id, ts) => ({ eventTs: iso(ts), kind, id });

function replans(engine) {
  return engine.rework.filter((r) => r.type === 'replan');
}

test('acceptance 1: late metro rewrites priority and triggers a better replan', () => {
  const e = new Engine();
  e.ingest(tool('T1', 10));
  e.ingest(metro('L1', 1, T0));
  e.ingest(carrier('C1', 'L1', 10, T0)); // takes the whole budget, value 10
  e.ingest(carrier('C2', 'L2', 10, T0 + M)); // score 0 -> stays out
  assert.equal(e.assignment.get('C1'), 'T1');
  assert.equal(e.assignment.get('C2'), null);

  // Advance the watermark well past T0+2min.
  e.ingest(carrier('C3', 'L3', 1, T0 + 30 * M));
  // Late metro for L2 (event time T0+2min < watermark T0+25min): score 100.
  e.ingest(metro('L2', 100, T0 + 2 * M));

  assert.equal(e.lateLines.length, 1, 'late event logged');
  assert.match(e.lateLines[0], /LATE type=metro id=L2/);
  const lateReplans = replans(e).filter((r) => r.trigger === 'late_metro_add');
  assert.equal(lateReplans.length, 1);
  assert.ok(lateReplans[0].after > lateReplans[0].before, 'replan improves objective');
  assert.equal(e.assignment.get('C2'), 'T1', 'high-score late lot wins the budget');
  assert.equal(e.assignment.get('C1'), null);
  assert.equal(e.objective, 1000);
});

test('acceptance 2: tool window retract cascades migration, never negative remaining', () => {
  const e = new Engine();
  e.ingest(tool('T1', 10));
  e.ingest(tool('T2', 10));
  e.ingest(tool('T3', 10));
  e.ingest(metro('L1', 10, T0));
  e.ingest(metro('L2', 5, T0));
  e.ingest(metro('L3', 1, T0));
  e.ingest(carrier('C1', 'L1', 10, T0));
  e.ingest(carrier('C2', 'L2', 10, T0));
  e.ingest(carrier('C3', 'L3', 10, T0));
  assert.deepEqual(
    [...e.assignment.entries()].sort(),
    [['C1', 'T1'], ['C2', 'T2'], ['C3', 'T3']]
  );

  e.ingest(retract('tool', 'T1', T0 + M));

  // Cascade: C1 -> T2, C2 -> T3, C3 pushed out.
  assert.equal(e.assignment.get('C1'), 'T2');
  assert.equal(e.assignment.get('C2'), 'T3');
  assert.equal(e.assignment.get('C3'), null);
  const cascade = e.rework.filter((r) => r.type === 'migration' && r.trigger === 'retract_tool');
  assert.ok(cascade.some((m) => m.carrier === 'C1' && m.from === 'T1' && m.to === 'T2'));
  assert.ok(cascade.some((m) => m.carrier === 'C2' && m.from === 'T2' && m.to === 'T3'),
    'displaced carrier cascades onto the next window');
  assert.ok(cascade.some((m) => m.carrier === 'C3' && m.from === 'T3' && m.to === null));
  const toolRetract = e.rework.find((r) => r.type === 'tool_retract');
  assert.deepEqual(toolRetract.displaced, ['C1']);

  const out = e.finalize();
  for (const w of out.budgetObj.windows) {
    assert.ok(w.remaining >= 0, `negative remaining on ${w.tool}`);
  }
  assert.equal(out.budgetObj.windows.find((w) => w.tool === 'T1'), undefined);
});

test('metro retract releases locked budget and replans', () => {
  const e = new Engine();
  e.ingest(tool('T1', 5));
  e.ingest(metro('L1', 10, T0));
  e.ingest(carrier('C1', 'L1', 5, T0));
  assert.equal(e.assignment.get('C1'), 'T1');

  e.ingest(retract('metro', 'L1', T0 + M));
  const release = e.rework.find((r) => r.type === 'budget_release');
  assert.ok(release, 'budget release recorded');
  assert.equal(release.lot, 'L1');
  assert.equal(release.releasedQty, 5);
  assert.equal(e.assignment.get('C1'), null, 'scoreless carrier frees the window');
});

test('metro for unknown lot goes to pending without failing, resolves on arrival', () => {
  const e = new Engine();
  e.ingest(tool('T1', 4));
  e.ingest(metro('L9', 42, T0)); // no carrier for L9 yet
  const pending = e.rework.find((r) => r.type === 'metro_pending');
  assert.ok(pending);
  assert.equal(pending.lot, 'L9');

  e.ingest(carrier('C9', 'L9', 4, T0 + M));
  assert.ok(e.rework.find((r) => r.type === 'metro_pending_resolved'));
  assert.equal(e.assignment.get('C9'), 'T1');
  assert.equal(e.objective, 168);
});

test('cap < 0 reports CAP_INVALID', () => {
  const e = new Engine();
  assert.throws(() => e.ingest(tool('T1', -1)), (err) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.code, 'CAP_INVALID');
    return true;
  });
});

test('unknown event kind and bad op are rejected', () => {
  const e = new Engine();
  assert.throws(() => e.ingest({ eventTs: iso(T0), foo: 1 }), /KIND_INVALID|cannot infer/);
  assert.throws(
    () => e.ingest({ eventTs: iso(T0), carrier: 'C1', lot: 'L1', qty: 1, op: 'nope' }),
    (err) => err.code === 'INVALID_OP'
  );
});

test('finalize outputs: watermark, ties, unassigned, budget totals', () => {
  const e = new Engine();
  e.ingest(tool('T1', 5));
  e.ingest(metro('L1', 7, T0));
  e.ingest(carrier('C1', 'L1', 5, T0));
  e.ingest(carrier('C2', 'L1', 5, T0));
  e.ingest(carrier('C3', 'L2', 1, T0 + 10 * M)); // advances watermark
  const out = e.finalize();
  assert.equal(out.planObj.watermarkMs, T0 + 5 * M);
  assert.equal(out.planObj.objective, 35);
  assert.equal(out.planObj.tieCount, 2, 'C1/C2 are interchangeable');
  assert.equal(out.planObj.solutions.length, 2);
  assert.deepEqual(out.planObj.unassigned.sort(), ['C2', 'C3'].sort());
  const w = out.budgetObj.windows[0];
  assert.equal(w.cap, 5);
  assert.equal(w.used, 5);
  assert.equal(w.remaining, 0);
  assert.equal(out.budgetObj.totalRemaining, 0);
});
