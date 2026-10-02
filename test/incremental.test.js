'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFlow, judgeEvents, Session, FlowError } = require('../lib');
const { flowLinear, flowLoop, lcg } = require('./helpers');

const ROLES = ['经办', '复核', '清算', '归档'];

function stripCache(result) {
  const { cache, ...rest } = result;
  return JSON.parse(JSON.stringify(rest));
}

test('B: retract restores the previous conclusion', () => {
  const s = new Session(flowLinear);
  s.append({ id: 'e1', ts: 1, role: '经办' });
  s.append({ id: 'e2', ts: 2, role: '复核' });
  s.append({ id: 'e3', ts: 3, role: '清算' });
  const before = s.judge();
  assert.equal(before.verdict, 'reject');
  assert.deepEqual(before.continuations, ['归档']);

  s.append({ id: 'e4', ts: 4, role: '归档' });
  const accepted = s.judge();
  assert.equal(accepted.verdict, 'accept');

  s.retract('e4');
  const after = s.judge();
  assert.deepEqual(stripCache(after), stripCache(before));
});

test('retract of a breaking event restores acceptance', () => {
  const s = new Session(flowLinear);
  s.append({ id: 'e1', ts: 1, role: '经办' });
  s.append({ id: 'bad', ts: 2, role: '归档' });
  s.append({ id: 'e2', ts: 3, role: '复核' });
  s.append({ id: 'e3', ts: 4, role: '清算' });
  s.append({ id: 'e4', ts: 5, role: '归档' });
  assert.equal(s.judge().verdict, 'reject');
  s.retract('bad');
  const r = s.judge();
  assert.equal(r.verdict, 'accept');
  assert.deepEqual(r.proofOfIds || r.prefix.map((e) => e.id), ['e1', 'e2', 'e3', 'e4']);
});

test('replace re-judges consistently with full replay', () => {
  const s = new Session(flowLinear);
  s.append({ id: 'e1', ts: 1, role: '经办' });
  s.append({ id: 'e2', ts: 2, role: '复核' });
  s.append({ id: 'e3', ts: 3, role: '归档' });
  assert.equal(s.judge().verdict, 'reject');
  s.replace('e3', { id: 'e3b', ts: 3, role: '清算' });
  const r = s.judge();
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(r.continuations, ['归档']);
  const full = judgeEvents(compileFlow(flowLinear), s.events);
  assert.deepEqual(stripCache(r), stripCache(full));
});

test('cache hit rate is reported and grows on append-only re-judges', () => {
  const s = new Session(flowLinear);
  s.append({ id: 'e1', ts: 1, role: '经办' });
  s.append({ id: 'e2', ts: 2, role: '复核' });
  const first = s.judge();
  assert.equal(first.cache.reused, 0);
  assert.equal(first.cache.hitRate, 0);
  s.append({ id: 'e3', ts: 3, role: '清算' });
  const second = s.judge();
  assert.equal(second.cache.reused, 2);
  assert.equal(second.cache.computed, 1);
  assert.ok(second.cache.hitRate > 0.5);
});

test('CACHE_POISON: tampered state cache is detected', () => {
  const s = new Session(flowLinear);
  s.append({ id: 'e1', ts: 1, role: '经办' });
  s.append({ id: 'e2', ts: 2, role: '复核' });
  s.judge();
  // poison the cached state of the longest cached prefix (the one judge() trusts)
  s.cache.set(s.lastKeys[s.lastKeys.length - 1], 999);
  assert.throws(() => s.judge(), (e) => e instanceof FlowError && e.code === 'CACHE_POISON');
});

test('correction fuzz: incremental results always equal full replay', () => {
  const rand = lcg(42);
  for (const flow of [flowLinear, flowLoop]) {
    const compiled = compileFlow(flow);
    for (let trial = 0; trial < 60; trial++) {
      const s = new Session(compiled);
      let ts = 0;
      let idc = 0;
      for (let op = 0; op < 40; op++) {
        const pick = rand();
        if (pick < 0.5 || s.events.length === 0) {
          s.append({ id: `t${trial}e${idc++}`, ts: ++ts, role: ROLES[(rand() * 4) | 0] });
        } else if (pick < 0.75) {
          const victim = s.events[(rand() * s.events.length) | 0];
          s.retract(victim.id);
        } else {
          const victim = s.events[(rand() * s.events.length) | 0];
          s.replace(victim.id, { id: `t${trial}e${idc++}`, ts: victim.ts, role: ROLES[(rand() * 4) | 0] });
        }
        const inc = s.judge();
        const full = judgeEvents(compiled, s.events);
        assert.deepEqual(stripCache(inc), stripCache(full),
          `mismatch at trial ${trial} op ${op}`);
      }
    }
  }
});
