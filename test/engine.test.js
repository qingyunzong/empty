import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Gateway, InputError, verifyCert } from '../src/engine.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function alarmKey(patternId, startId, endId) {
  return JSON.stringify([patternId, startId, endId]);
}

test('overlapping patterns all reported in deterministic order', () => {
  const patterns = [
    { id: 'sub-AB', type: 'substring', value: 'AB' },
    { id: 'wild-A?C', type: 'wildcard', value: 'A?C' },
    { id: 're-3sym', type: 'regex', value: '[ABC]{3}' },
  ];
  const g = new Gateway({ patterns });
  const out1 = g.apply({ upsert: { id: 'e1', ts: 1, sym: 'A' } });
  const out2 = g.apply({ upsert: { id: 'e2', ts: 2, sym: 'B' } });
  const out3 = g.apply({ upsert: { id: 'e3', ts: 3, sym: 'C' } });
  assert.deepEqual(out1.filter((o) => o.type === 'emit'), []);
  const emits = [...out2, ...out3].filter((o) => o.type === 'emit');
  assert.deepEqual(
    emits.map((o) => [o.alarm.patternId, o.alarm.startId, o.alarm.endId]),
    [
      ['sub-AB', 'e1', 'e2'],
      ['re-3sym', 'e1', 'e3'],
      ['wild-A?C', 'e1', 'e3'],
    ],
  );
  assert.equal(out3.at(-1).type, 'windowHash');
});

test('same event participates in multiple patterns and multiple matches', () => {
  const g = new Gateway({
    patterns: [
      { id: 'p-A', type: 'substring', value: 'A' },
      { id: 'p-AA', type: 'substring', value: 'AA' },
    ],
  });
  g.apply({ upsert: { id: 'x', ts: 1, sym: 'A' } });
  const outputs = g.apply({ upsert: { id: 'y', ts: 2, sym: 'A' } });
  const keys = outputs.filter((o) => o.type === 'emit').map((o) => alarmKey(o.alarm.patternId, o.alarm.startId, o.alarm.endId));
  assert.deepEqual(keys, [
    alarmKey('p-AA', 'x', 'y'),
    alarmKey('p-A', 'y', 'y'),
  ]);
});

test('window sliding evicts old matches via retractAlarm', () => {
  const g = new Gateway({
    patterns: [
      { id: 'sub-AB', type: 'substring', value: 'AB' },
      { id: 'sub-BC', type: 'substring', value: 'BC' },
    ],
  });
  g.apply({ setWindow: { n: 2 } });
  g.apply({ upsert: { id: 'a', ts: 1, sym: 'A' } });
  const out2 = g.apply({ upsert: { id: 'b', ts: 2, sym: 'B' } });
  assert.deepEqual(
    out2.filter((o) => o.type === 'emit').map((o) => o.alarm),
    [{ patternId: 'sub-AB', startId: 'a', endId: 'b' }],
  );
  const out3 = g.apply({ upsert: { id: 'c', ts: 3, sym: 'C' } });
  const changes = out3.filter((o) => o.type !== 'windowHash');
  assert.deepEqual(
    changes.map((o) => [o.type, o.alarm.patternId, o.alarm.startId, o.alarm.endId]),
    [
      ['retractAlarm', 'sub-AB', 'a', 'b'],
      ['emit', 'sub-BC', 'b', 'c'],
    ],
  );
});

test('out-of-order upsert inserts by timestamp and only outputs the delta', () => {
  const g = new Gateway({ patterns: [{ id: 'sub-AB', type: 'substring', value: 'AB' }] });
  g.apply({ upsert: { id: 'hi', ts: 10, sym: 'B' } });
  const outputs = g.apply({ upsert: { id: 'lo', ts: 5, sym: 'A' } });
  const emits = outputs.filter((o) => o.type === 'emit');
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0].alarm, { patternId: 'sub-AB', startId: 'lo', endId: 'hi' });
  const again = g.apply({ upsert: { id: 'lo', ts: 5, sym: 'A' } });
  assert.deepEqual(again.filter((o) => o.type !== 'windowHash'), []);
});

test('upsert override recomputes affected alarms incrementally', () => {
  const g = new Gateway({ patterns: [{ id: 'sub-AB', type: 'substring', value: 'AB' }] });
  g.apply({ upsert: { id: 'a', ts: 1, sym: 'A' } });
  g.apply({ upsert: { id: 'b', ts: 2, sym: 'X' } });
  const outputs = g.apply({ upsert: { id: 'b', ts: 2, sym: 'B' } });
  const emits = outputs.filter((o) => o.type === 'emit');
  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0].alarm, { patternId: 'sub-AB', startId: 'a', endId: 'b' });
});

test('input validation errors raise InputError with exitCode 3', () => {
  const g = new Gateway({});
  const bad = [
    { upsert: { id: 'a', ts: 1.5, sym: 'A' } },
    { upsert: { id: 'a', ts: '1', sym: 'A' } },
    { upsert: { id: 'a', ts: 1, sym: '' } },
    { upsert: { id: '', ts: 1, sym: 'A' } },
    { setWindow: { n: 0 } },
    { setWindow: { n: -2 } },
    { setWindow: { n: 1.5 } },
    { retract: { id: 'ghost' } },
    { noop: {} },
    { upsert: { id: 'a', ts: 1, sym: 'A' }, retract: { id: 'a' } },
    'not-an-object',
  ];
  for (const record of bad) {
    assert.throws(() => g.apply(record), (err) => err instanceof InputError && err.exitCode === 3);
  }
  g.apply({ upsert: { id: 'a', ts: 1, sym: 'A' } });
  g.apply({ retract: { id: 'a' } });
  assert.throws(() => g.apply({ retract: { id: 'a' } }), InputError);
});

test('certificates verify independently and reject tampering', () => {
  const patterns = [
    { id: 'sub-AB', type: 'substring', value: 'AB' },
    { id: 'wild', type: 'wildcard', value: 'A?' },
  ];
  const g = new Gateway({ patterns });
  g.apply({ upsert: { id: 'a', ts: 1, sym: 'A' } });
  const outputs = g.apply({ upsert: { id: 'b', ts: 2, sym: 'B' } });
  const certs = outputs.filter((o) => o.type === 'emit').map((o) => o.cert);
  assert.equal(certs.length, 2);
  const windowEvents = g.getWindowEvents();
  for (const cert of certs) {
    assert.equal(verifyCert(cert, windowEvents, patterns), true);
    assert.equal(g.verify(cert), true);
    assert.equal(verifyCert({ ...cert, fingerprint: '0'.repeat(64) }, windowEvents, patterns), false);
    assert.equal(verifyCert({ ...cert, patternId: 'nope' }, windowEvents, patterns), false);
    assert.equal(verifyCert({ ...cert, text: 'XX' }, windowEvents, patterns), false);
    assert.equal(verifyCert(cert, windowEvents.slice(0, 1), patterns), false);
  }
});

function oracleMatcher(spec) {
  if (spec.type === 'substring') return (text) => text === spec.value;
  if (spec.type === 'wildcard') {
    let body = '';
    for (const ch of spec.value) {
      if (ch === '*') body += '[\\s\\S]*';
      else if (ch === '?') body += '[\\s\\S]';
      else body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    const re = new RegExp(`^${body}$`);
    return (text) => re.test(text);
  }
  if (spec.type === 'regex') {
    const re = new RegExp(`^(?:${spec.value})$`);
    return (text) => re.test(text);
  }
  throw new Error(`unknown pattern type ${spec.type}`);
}

function oracleState(live, windowSize, specs, matchers) {
  const sorted = [...live.values()].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const win = windowSize === Infinity ? sorted : sorted.slice(Math.max(0, sorted.length - windowSize));
  const keys = new Set();
  for (let i = 0; i < win.length; i += 1) {
    let text = '';
    for (let j = i; j < win.length; j += 1) {
      text += win[j].sym;
      for (let p = 0; p < specs.length; p += 1) {
        if (matchers[p](text)) keys.add(alarmKey(specs[p].id, win[i].id, win[j].id));
      }
    }
  }
  const hash = createHash('sha256')
    .update(JSON.stringify(win.map((e) => [e.id, e.ts, e.sym])))
    .digest('hex');
  return { win, keys, hash };
}

const PATTERN_POOL = [
  { id: 'p0', type: 'substring', value: 'AB' },
  { id: 'p1', type: 'substring', value: 'C' },
  { id: 'p2', type: 'wildcard', value: 'A?C' },
  { id: 'p3', type: 'wildcard', value: 'B*' },
  { id: 'p4', type: 'regex', value: '[ABC]{2}' },
  { id: 'p5', type: 'regex', value: 'B+' },
];

function randomPatterns(rand) {
  const count = 1 + Math.floor(rand() * PATTERN_POOL.length);
  const shuffled = [...PATTERN_POOL].sort(() => rand() - 0.5);
  return shuffled.slice(0, count);
}

function randomLog(rand, length, { withSetWindow = true } = {}) {
  const ops = [];
  const liveIds = new Set();
  for (let k = 0; k < length; k += 1) {
    const r = rand();
    if (r < 0.6 || liveIds.size === 0) {
      const id = `e${Math.floor(rand() * 6)}`;
      ops.push({ upsert: { id, ts: Math.floor(rand() * 16), sym: 'ABC'[Math.floor(rand() * 3)] } });
      liveIds.add(id);
    } else if (r < 0.85 || !withSetWindow) {
      const ids = [...liveIds];
      const id = ids[Math.floor(rand() * ids.length)];
      ops.push({ retract: { id } });
      liveIds.delete(id);
    } else {
      ops.push({ setWindow: { n: 1 + Math.floor(rand() * 6) } });
    }
  }
  return ops;
}

test('random small logs (n<=12) match brute-force enumeration of all subsequences', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rand = mulberry32(seed);
    const patterns = randomPatterns(rand);
    const matchers = patterns.map(oracleMatcher);
    const log = randomLog(rand, 1 + Math.floor(rand() * 12));
    const g = new Gateway({ patterns });
    const live = new Map();
    let windowSize = Infinity;
    const shadow = new Set();
    for (const record of log) {
      const outputs = g.apply(record);
      if ('upsert' in record) live.set(record.upsert.id, { ...record.upsert });
      else if ('retract' in record) live.delete(record.retract.id);
      else windowSize = record.setWindow.n;
      for (const o of outputs) {
        if (o.type === 'emit') shadow.add(alarmKey(o.alarm.patternId, o.alarm.startId, o.alarm.endId));
        else if (o.type === 'retractAlarm') shadow.delete(alarmKey(o.alarm.patternId, o.alarm.startId, o.alarm.endId));
      }
      const oracle = oracleState(live, windowSize, patterns, matchers);
      assert.deepEqual([...g.getAlarms().keys()].sort(), [...oracle.keys].sort(), `seed ${seed} alarms`);
      assert.deepEqual([...shadow].sort(), [...oracle.keys].sort(), `seed ${seed} shadow`);
      assert.equal(g.getWindowHash(), oracle.hash, `seed ${seed} hash`);
      for (const [key, alarm] of g.getAlarms()) {
        const i = oracle.win.findIndex((e) => e.id === alarm.cert.startId);
        const j = oracle.win.findIndex((e) => e.id === alarm.cert.endId);
        assert.ok(i >= 0 && j >= i, `seed ${seed} cert span ${key}`);
        const span = oracle.win.slice(i, j + 1);
        const fp = createHash('sha256')
          .update(JSON.stringify(span.map((e) => [e.id, e.ts, e.sym])))
          .digest('hex');
        assert.equal(alarm.cert.fingerprint, fp, `seed ${seed} fingerprint ${key}`);
        assert.equal(alarm.cert.text, span.map((e) => e.sym).join(''), `seed ${seed} text ${key}`);
      }
    }
  }
});

test('interleaved upsert/retract hash equals replay of final effective set', () => {
  for (let seed = 501; seed <= 600; seed += 1) {
    const rand = mulberry32(seed);
    const patterns = randomPatterns(rand);
    const windowSize = rand() < 0.5 ? Infinity : 1 + Math.floor(rand() * 6);
    const log = randomLog(rand, 1 + Math.floor(rand() * 12), { withSetWindow: false });
    const g = new Gateway({ patterns, windowSize });
    for (const record of log) g.apply(record);

    const finalEvents = [...g.live.values()];
    const sorted = [...finalEvents].sort((a, b) => (a.ts - b.ts) || (a.id < b.id ? -1 : 1));
    const shuffled = [...finalEvents].sort(() => rand() - 0.5);

    for (const order of [sorted, shuffled]) {
      const replay = new Gateway({ patterns, windowSize });
      for (const e of order) replay.apply({ upsert: { id: e.id, ts: e.ts, sym: e.sym } });
      assert.equal(replay.getWindowHash(), g.getWindowHash(), `seed ${seed} replay hash`);
      assert.deepEqual(
        [...replay.getAlarms().keys()].sort(),
        [...g.getAlarms().keys()].sort(),
        `seed ${seed} replay alarms`,
      );
    }
  }
});
