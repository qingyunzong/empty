'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { compileNfa, validateNfa, simulateNfa } = require('../src/nfa');
const {
  judgeEvents,
  IncrementalSession,
  chainFingerprint,
  GENESIS_FP,
} = require('../src/judge');
const { makeProof, verifyProof } = require('../src/proof');
const { CODES, ComplianceError } = require('../src/errors');

const ROLES = ['经办', '复核', '清算', '归档'];

const FLOW = {
  states: ['draft', 'reviewed', 'cleared', 'archived'],
  roles: ROLES,
  start: 'draft',
  accept: ['archived'],
  transitions: [
    { from: 'draft', role: '经办', to: 'reviewed' },
    { from: 'reviewed', role: '复核', to: 'cleared' },
    { from: 'cleared', role: '清算', to: 'archived' },
    { from: 'archived', role: '归档', to: 'archived' },
  ],
};

function ev(id, ts, role) {
  return { id, ts, role };
}

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

test('accept: shortest compliant path is returned with a verifiable proof', () => {
  const dfa = compileNfa(FLOW);
  const events = [ev('e1', 1, '经办'), ev('e2', 2, '复核'), ev('e3', 3, '清算')];
  const result = judgeEvents(dfa, events);
  assert.equal(result.verdict, 'accept');
  assert.equal(result.path.length, events.length + 1);
  assert.equal(result.path[0], dfa.start);
  assert.ok(dfa.accept.has(result.path[result.path.length - 1]));
  assert.deepEqual(result.consumed, ['e1', 'e2', 'e3']);
  const proof = makeProof(dfa, result);
  assert.equal(proof.dfaHash, dfa.hash);
  const check = verifyProof(FLOW, events, proof);
  assert.equal(check.ok, true);
});

test('A: out-of-order timestamps are rejected with TIME_REORDER', () => {
  const dfa = compileNfa(FLOW);
  const events = [ev('e1', 5, '经办'), ev('e2', 4, '复核')];
  assert.throws(() => judgeEvents(dfa, events), (err) => {
    assert.ok(err instanceof ComplianceError);
    assert.equal(err.code, CODES.TIME_REORDER);
    return true;
  });
  const session = new IncrementalSession(compileNfa(FLOW));
  session.append(ev('e1', 5, '经办'));
  assert.throws(
    () => session.append(ev('e2', 4, '复核')),
    (err) => err.code === CODES.TIME_REORDER
  );
});

test('duplicate event ids are rejected with ID_REUSE', () => {
  const dfa = compileNfa(FLOW);
  const events = [ev('e1', 1, '经办'), ev('e1', 2, '复核')];
  assert.throws(() => judgeEvents(dfa, events), (err) => {
    assert.equal(err.code, CODES.ID_REUSE);
    return true;
  });
});

test('epsilon-only NFA is rejected with NFA_EPSILON_ONLY', () => {
  const spec = {
    states: ['a', 'b'],
    start: 'a',
    accept: ['b'],
    transitions: [{ from: 'a', to: 'b', epsilon: true }],
  };
  assert.throws(() => compileNfa(spec), (err) => {
    assert.equal(err.code, CODES.NFA_EPSILON_ONLY);
    return true;
  });
});

test('C: earliest failure prefix and continuations are exact', () => {
  const flow = {
    states: ['s0', 's1', 's2'],
    roles: ROLES,
    start: 's0',
    accept: ['s2'],
    transitions: [
      { from: 's0', role: '经办', to: 's1' },
      { from: 's1', role: '复核', to: 's2' },
    ],
  };
  const dfa = compileNfa(flow);

  // Failing event: prefix includes the offending event, continuations
  // are the roles that would have been legal instead.
  let r = judgeEvents(dfa, [ev('e1', 1, '经办'), ev('e2', 2, '清算')]);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.reason, 'NO_TRANSITION');
  assert.deepEqual(r.prefix, ['e1', 'e2']);
  assert.deepEqual(r.consumed, ['e1']);
  assert.deepEqual(r.continuations, ['复核']);

  // Log exhausted outside an accept state: prefix is the whole log.
  r = judgeEvents(dfa, [ev('e1', 1, '经办')]);
  assert.equal(r.verdict, 'reject');
  assert.equal(r.reason, 'NOT_ACCEPTING');
  assert.deepEqual(r.prefix, ['e1']);
  assert.deepEqual(r.consumed, ['e1']);
  assert.deepEqual(r.continuations, ['复核']);

  // Failure at the very first event.
  r = judgeEvents(dfa, [ev('e1', 1, '复核')]);
  assert.equal(r.reason, 'NO_TRANSITION');
  assert.deepEqual(r.prefix, ['e1']);
  assert.deepEqual(r.consumed, []);
  assert.deepEqual(r.continuations, ['经办']);

  // Empty log.
  r = judgeEvents(dfa, []);
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(r.prefix, []);
  assert.deepEqual(r.continuations, ['经办']);
});

test('B: retract and replace restore earlier conclusions and match full replay', () => {
  const dfa = compileNfa(FLOW);
  const session = new IncrementalSession(dfa);

  const r1 = session.append(ev('e1', 1, '经办'));
  assert.equal(r1.verdict, 'reject');
  const r2 = session.append(ev('e2', 2, '复核'));
  assert.equal(r2.verdict, 'reject');
  assert.equal(r2.reason, 'NOT_ACCEPTING');
  const r3 = session.append(ev('e3', 3, '清算'));
  assert.equal(r3.verdict, 'accept');

  // Retracting the last event restores the previous conclusion exactly.
  const r4 = session.retract('e3');
  for (const key of ['verdict', 'reason', 'prefix', 'continuations', 'finalState', 'path', 'consumed']) {
    assert.deepEqual(r4[key], r2[key], `field ${key} restored after retract`);
  }
  assert.deepEqual(
    { ...r4, cache: undefined },
    { ...judgeEvents(dfa, [ev('e1', 1, '经办'), ev('e2', 2, '复核')]), cache: undefined }
  );

  // Replace with an illegal role, then replace back: conclusions track it.
  const r5 = session.replace('e2', ev('e2', 2, '清算'));
  assert.equal(r5.verdict, 'reject');
  assert.equal(r5.reason, 'NO_TRANSITION');
  assert.deepEqual(r5.prefix, ['e1', 'e2']);
  const r6 = session.replace('e2', ev('e2', 2, '复核'));
  for (const key of ['verdict', 'reason', 'prefix', 'continuations', 'finalState', 'path']) {
    assert.deepEqual(r6[key], r2[key], `field ${key} restored after replace-back`);
  }

  // Cache statistics are reported and non-trivial after incremental reuse.
  assert.ok(r6.cache.reused > 0);
  assert.ok(r6.cache.hitRate > 0 && r6.cache.hitRate <= 1);
});

test('incremental session always agrees with full replay under random corrections', () => {
  const dfa = compileNfa(FLOW);
  const rand = mulberry32(42);
  const session = new IncrementalSession(dfa);
  let counter = 0;
  for (let op = 0; op < 400; op++) {
    const pick = rand();
    if (pick < 0.5 || session.events.length === 0) {
      counter += 1;
      session.append(ev(`g${counter}`, counter, ROLES[Math.floor(rand() * 4)]));
    } else if (pick < 0.75) {
      const victim = session.events[Math.floor(rand() * session.events.length)];
      session.retract(victim.id);
    } else {
      const victim = session.events[Math.floor(rand() * session.events.length)];
      session.replace(victim.id, ev(victim.id, victim.ts, ROLES[Math.floor(rand() * 4)]));
    }
    const incremental = session.judge();
    const full = judgeEvents(dfa, session.events);
    const strip = ({ cache, ...rest }) => rest;
    assert.deepEqual(strip(incremental), strip(full), `mismatch at op ${op}`);
  }
  const stats = session.cacheStats();
  assert.ok(stats.reused > 0);
  assert.ok(stats.hitRate > 0);
});

test('cache poisoning is detected and reported as CACHE_POISON', () => {
  const dfa = compileNfa(FLOW);
  const session = new IncrementalSession(dfa);
  session.append(ev('e1', 1, '经办'));
  const e2 = ev('e2', 2, '复核');
  // Forge a cache entry whose fingerprint matches but whose state is bogus.
  const fp1 = chainFingerprint(GENESIS_FP, ev('e1', 1, '经办'));
  const fp2 = chainFingerprint(fp1, e2);
  session.cache.set(1, { fp: fp1, state: 'm0' });
  session.cache.set(2, { fp: fp2, state: 'ghost-state' });
  session.events.push(e2);
  assert.throws(() => session.judge(), (err) => {
    assert.equal(err.code, CODES.CACHE_POISON);
    return true;
  });
});

test('E: tampering any proof event id (or any other field) fails verification', () => {
  const dfa = compileNfa(FLOW);
  const events = [
    ev('e1', 1, '经办'),
    ev('e2', 2, '复核'),
    ev('e3', 3, '清算'),
    ev('e4', 4, '归档'),
  ];
  const result = judgeEvents(dfa, events);
  const proof = makeProof(dfa, result);
  assert.equal(verifyProof(FLOW, events, proof).ok, true);

  for (let i = 0; i < proof.eventIds.length; i++) {
    const tampered = { ...proof, eventIds: proof.eventIds.slice() };
    tampered.eventIds[i] = `forged-${i}`;
    const check = verifyProof(FLOW, events, tampered);
    assert.equal(check.ok, false, `tampered event id at ${i} must fail`);
    assert.equal(check.reason, 'EVENT_SEQUENCE_MISMATCH');
  }
  assert.equal(verifyProof(FLOW, events, { ...proof, finalState: 'm999' }).ok, false);
  assert.equal(verifyProof(FLOW, events, { ...proof, verdict: 'reject' }).ok, false);
  assert.equal(verifyProof(FLOW, events, { ...proof, dfaHash: 'sha256:00' }).ok, false);
  // Dropping an event from the claimed sequence is also caught.
  const shortened = { ...proof, eventIds: proof.eventIds.slice(0, -1) };
  assert.equal(verifyProof(FLOW, events, shortened).ok, false);
});

test('reject proofs verify independently as well', () => {
  const dfa = compileNfa(FLOW);
  const events = [ev('e1', 1, '经办'), ev('e2', 2, '清算')];
  const result = judgeEvents(dfa, events);
  assert.equal(result.verdict, 'reject');
  const proof = makeProof(dfa, result);
  const check = verifyProof(FLOW, events, proof);
  assert.equal(check.ok, true);
  assert.equal(check.verdict, 'reject');
  // Claiming accept for a rejected log is caught.
  assert.equal(verifyProof(FLOW, events, { ...proof, verdict: 'accept' }).ok, false);
});

test('minimized DFA hash is canonical and independent of state naming', () => {
  const renamed = {
    states: ['alpha', 'beta', 'gamma', 'delta'],
    roles: ROLES,
    start: 'alpha',
    accept: ['delta'],
    transitions: [
      { from: 'alpha', role: '经办', to: 'beta' },
      { from: 'beta', role: '复核', to: 'gamma' },
      { from: 'gamma', role: '清算', to: 'delta' },
      { from: 'delta', role: '归档', to: 'delta' },
    ],
  };
  assert.equal(compileNfa(FLOW).hash, compileNfa(renamed).hash);

  // A flow with a redundant (mergeable) state minimizes to the same DFA.
  const redundant = {
    states: ['a', 'b1', 'b2', 'c'],
    roles: ROLES,
    start: 'a',
    accept: ['c'],
    transitions: [
      { from: 'a', role: '经办', to: 'b1' },
      { from: 'a', role: '复核', to: 'b2' },
      { from: 'b1', role: '清算', to: 'c' },
      { from: 'b2', role: '清算', to: 'c' },
    ],
  };
  const dfa = compileNfa(redundant);
  assert.equal(dfa.states.length, 3);
});

test('nondeterministic NFA with epsilon transitions compiles correctly', () => {
  const spec = {
    states: ['a', 'b', 'c', 'd'],
    roles: ROLES,
    start: 'a',
    accept: ['d'],
    transitions: [
      { from: 'a', role: '经办', to: 'b' },
      { from: 'a', role: '经办', to: 'c' },
      { from: 'b', to: 'c', epsilon: true },
      { from: 'b', role: '复核', to: 'd' },
      { from: 'c', role: '清算', to: 'd' },
      { from: 'd', role: '归档', to: 'd' },
    ],
  };
  const dfa = compileNfa(spec);
  const nfa = validateNfa(spec);
  for (const roles of [[], ['经办'], ['经办', '复核'], ['经办', '清算'], ['清算'], ['经办', '归档']]) {
    const events = roles.map((role, i) => ev(`e${i}`, i, role));
    const result = judgeEvents(dfa, events);
    const sim = simulateNfa(nfa, roles);
    assert.equal(result.verdict === 'accept', sim.accepted, `roles ${roles}`);
    assert.equal(result.consumed.length, sim.consumed, `roles ${roles}`);
    assert.deepEqual(result.continuations, sim.continuations, `roles ${roles}`);
  }
});
