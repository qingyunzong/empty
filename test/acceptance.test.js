import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { WindowIndex } from '../src/windows.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'gate-test-'));
}

function initEngine(rules) {
  const dir = freshDir();
  return Engine.init(dir, rules);
}

// Acceptance 1: window boundaries are open on the left by default and
// optionally closed; an observation exactly at start belongs only to closed.
test('acceptance 1: window boundary open/closed semantics', () => {
  const idx = new WindowIndex();
  idx.insert({ t: 1000, k: 'a', v: 10 });
  idx.insert({ t: 1100, k: 'b', v: 20 });
  assert.equal(idx.stats(1000, 1100, 'left-open').count, 1);
  assert.equal(idx.stats(1000, 1100, 'closed').count, 2);
  assert.equal(idx.stats(1000, 1100, 'left-open').sum, 20);
  assert.equal(idx.stats(1000, 1100, 'closed').sum, 30);

  const engine = initEngine({
    rules: [
      { id: 'open', when: { cmp: 'eq', left: { agg: 'count', window: { size: 100 }, expr: { ref: 'v' } }, right: { lit: 1 } } },
      { id: 'closed', when: { cmp: 'eq', left: { agg: 'count', window: { size: 100, bounds: 'closed' }, expr: { ref: 'v' } }, right: { lit: 2 } } },
    ],
  });
  engine.ingest([
    { key: 'a', time: 1000, v: 10 },
    { key: 'b', time: 1100, v: 20 },
  ]);
  const cert = engine.decide('b');
  assert.equal(cert.decision, 'pass');
  assert.deepEqual(cert.rules.map((r) => [r.id, r.outcome]), [['open', 'pass'], ['closed', 'pass']]);
});

// Acceptance 2: correcting a historical observation invalidates only the
// cached windows overlapping its old/new position, and incremental results
// afterwards are identical to a full replay.
test('acceptance 2: correction invalidates only overlapping windows; incremental == replay', () => {
  const engine = initEngine({
    rules: [
      { id: 'avg-lt-100', when: { cmp: 'lt', left: { agg: 'avg', window: { size: 1000 }, expr: { ref: 'v' } }, right: { lit: 100 } } },
    ],
  });
  engine.ingest([
    { key: 'k0', time: 0, v: 10 },
    { key: 'k1', time: 500, v: 20 },
    { key: 'k2', time: 1000, v: 30 },
    { key: 'k3', time: 1500, v: 40 },
    { key: 'k4', time: 2000, v: 50 },
  ]);
  assert.equal(engine.decide('k2').decision, 'pass'); // window (0,1000]: avg(20,30)=25
  assert.equal(engine.decide('k4').decision, 'pass'); // window (1000,2000]: avg(40,50)=45
  const computedBefore = engine.stats.windowsComputed;
  assert.equal(computedBefore, 2);

  engine.correct('k1', { v: 200 }); // t=500 overlaps only window (0,1000]
  assert.equal(engine.stats.windowsInvalidated, 1);

  const incremental = new Map();
  for (const key of ['k0', 'k1', 'k2', 'k3', 'k4']) {
    const cert = engine.decide(key);
    incremental.set(key, { decision: cert.decision, values: cert.rules.map((r) => r.value) });
  }
  assert.equal(incremental.get('k2').decision, 'fail'); // avg(200,30)=115 >= 100 now

  const replayed = engine.replay(0, 2000);
  assert.equal(replayed.length, 5);
  for (const cert of replayed) {
    assert.equal(cert.mode, 'replay');
    assert.deepEqual(
      { decision: cert.decision, values: cert.rules.map((r) => r.value) },
      incremental.get(cert.key),
      `incremental and replay disagree for ${cert.key}`,
    );
  }
});

// Acceptance 3: exemption conflicts resolve by priority; a tie at the top
// priority is an E_EXEMPT error.
test('acceptance 3: exemption priority wins, ties raise E_EXEMPT', () => {
  const rules = (exemptions) => ({
    rules: [{ id: 'r1', when: { cmp: 'lt', left: { ref: 'v' }, right: { lit: 10 } } }],
    exemptions,
  });

  const engine = initEngine(rules([
    { id: 'x-low', priority: 5 },
    { id: 'x-high', priority: 10 },
  ]));
  engine.ingest([{ key: 'o1', time: 1, v: 50 }]);
  const cert = engine.decide('o1');
  assert.equal(cert.decision, 'pass');
  assert.equal(cert.rules[0].outcome, 'exempt');
  assert.deepEqual(cert.exemptionChain, [{ ruleId: 'r1', exemptionId: 'x-high', priority: 10 }]);

  const tied = initEngine(rules([
    { id: 'x-a', priority: 10 },
    { id: 'x-b', priority: 10 },
  ]));
  tied.ingest([{ key: 'o1', time: 1, v: 50 }]);
  assert.throws(() => tied.decide('o1'), (e) => e.code === 'E_EXEMPT');

  const noMatch = initEngine(rules([
    { id: 'x-cond', priority: 10, match: { cmp: 'eq', left: { ref: 'site' }, right: { lit: 'lab' } } },
  ]));
  noMatch.ingest([{ key: 'o1', time: 1, v: 50, site: 'field' }]);
  assert.equal(noMatch.decide('o1').decision, 'fail');
});

// Acceptance 4: unknown (NULL) is undecided, never fail: it blocks automatic
// admission but is not counted as a violation.
test('acceptance 4: unknown is undecided, not fail', () => {
  const engine = initEngine({
    rules: [
      { id: 'needs-temp', when: { cmp: 'gt', left: { ref: 'temp' }, right: { lit: 0 } } },
      { id: 'needs-hum', when: { cmp: 'lt', left: { ref: 'hum' }, right: { lit: 90 } } },
    ],
  });
  engine.ingest([
    { key: 'missing', time: 1, temp: 20 }, // hum absent -> NULL
    { key: 'bad', time: 2, temp: 20, hum: 99 },
    { key: 'good', time: 3, temp: 20, hum: 50 },
  ]);
  const undecided = engine.decide('missing');
  assert.equal(undecided.decision, 'undecided');
  assert.equal(undecided.admissible, false); // blocks automatic admission
  assert.equal(undecided.violation, false); // but is not a violation
  assert.equal(undecided.rules[1].value, null);

  const failed = engine.decide('bad');
  assert.equal(failed.decision, 'fail');
  assert.equal(failed.violation, true);

  assert.equal(engine.decide('good').decision, 'pass');
  assert.notEqual(undecided.decision, failed.decision);
});

test('certificate carries AST hash, window keys and exemption chain', () => {
  const engine = initEngine({
    rules: [{ id: 'r1', when: { cmp: 'lt', left: { agg: 'max', window: { size: 500 }, expr: { ref: 'v' } }, right: { lit: 10 } } }],
    exemptions: [{ id: 'x1', priority: 1, reason: 'calibration' }],
  });
  engine.ingest([{ key: 'o1', time: 10_000, v: 42 }]);
  const cert = engine.decide('o1');
  assert.equal(cert.rules[0].outcome, 'exempt');
  assert.match(cert.rules[0].astHash, /^[0-9a-f]{16}$/);
  assert.match(cert.rules[0].windowKeys[0], /^w:[0-9a-f]{16}:\(9500,10000\]$/);
  assert.equal(cert.windowKeys.length, 1);
  assert.equal(cert.exemptionChain[0].exemptionId, 'x1');
  assert.equal(cert.certVersion, 1);
});

test('derived metrics participate in rules and corrections', () => {
  const engine = initEngine({
    derived: {
      ratio: { div: [{ ref: 'a' }, { ref: 'b' }] },
      doubled: { mul: [{ ref: 'ratio' }, { lit: 2 }] },
    },
    rules: [{ id: 'r1', when: { cmp: 'lt', left: { ref: 'doubled' }, right: { lit: 4 } } }],
  });
  engine.ingest([{ key: 'o1', time: 1, a: 3, b: 2 }]); // doubled = 3 -> pass
  assert.equal(engine.decide('o1').decision, 'pass');
  engine.correct('o1', { a: 10 }); // doubled = 10 -> fail
  assert.equal(engine.decide('o1').decision, 'fail');
});
