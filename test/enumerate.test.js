import test from 'node:test';
import assert from 'node:assert/strict';
import { replay } from '../src/scheduler.js';
import { audit } from '../src/audit.js';
import { join, claim } from './helpers.js';

// All interleavings of two fixed per-AGV claim sequences (A keeps its internal
// order, B keeps its own); there are C(2n, n) of them.
function* interleavings(n) {
  const total = 2 * n;
  const choose = function* (k, start, prefix) {
    if (k === 0) {
      yield prefix;
      return;
    }
    for (let i = start; i <= total - k; i += 1) {
      yield* choose(k - 1, i + 1, [...prefix, i]);
    }
  };
  for (const positions of choose(n, 0, [])) {
    const set = new Set(positions);
    yield Array.from({ length: total }, (_, i) => (set.has(i) ? 'A' : 'B'));
  }
}

function buildEvents(order, n) {
  const events = [join('A'), join('B')];
  const counter = { A: 0, B: 0 };
  let seq = 0;
  for (const agv of order) {
    counter[agv] += 1;
    seq += 1;
    events.push(claim(`t${counter[agv]}`, agv, 1, seq, 100000, { s: seq }));
  }
  return events;
}

// 验收 4: 枚举 <=6 任务的全部调度序并逐一对照。
test('enumerate all schedules for <=6 tasks and cross-check winners', () => {
  const binom = (n, k) => {
    let r = 1;
    for (let i = 0; i < k; i += 1) r = (r * (n - i)) / (i + 1);
    return r;
  };
  let total = 0;
  for (let n = 1; n <= 6; n += 1) {
    let cases = 0;
    for (const order of interleavings(n)) {
      cases += 1;
      total += 1;
      const events = buildEvents(order, n);

      // reference: winner of each task is the AGV whose claim appears first
      const expected = {};
      const seen = { A: 0, B: 0 };
      for (const agv of order) {
        seen[agv] += 1;
        const task = `t${seen[agv]}`;
        if (!(task in expected)) expected[task] = agv;
      }

      const s = replay(events);
      const again = replay(events);
      assert.deepEqual(s.snapshot(), again.snapshot(), `deterministic for n=${n}`);

      for (let i = 1; i <= n; i += 1) {
        const t = s.tasks.get(`t${i}`);
        assert.equal(t.status, 'claimed');
        assert.equal(t.owner, expected[`t${i}`], `task t${i} winner mismatch for order ${order.join('')}`);
      }
      const granted = s.decisions.filter((d) => d.result === 'granted').length;
      const held = s.decisions.filter((d) => d.reason === 'held').length;
      assert.equal(granted, n);
      assert.equal(held, n);

      const report = audit(events);
      assert.equal(report.ok, true, `audit clean for order ${order.join('')}`);
    }
    assert.equal(cases, binom(2 * n, n), `case count for n=${n}`);
  }
  assert.equal(total, 1274);
});
