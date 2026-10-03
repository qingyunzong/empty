'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  setAccountLimit,
  getAccount,
  makeFreeze,
  makeRelease,
  makeAddMember,
  makeRemoveMember,
  applyEvent,
  mergeStates,
  diffStates,
} = require('../replica');

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function baseReplica(limit = 1000) {
  const state = createState();
  setAccountLimit(state, 'acct', limit);
  assert.equal(applyEvent(state, makeAddMember(state, { id: 'cfg-add-m1', memberId: 'm1' })).ok, true);
  assert.equal(applyEvent(state, makeAddMember(state, { id: 'cfg-add-m2', memberId: 'm2' })).ok, true);
  return state;
}

function freeze(state, id, memberId, amount) {
  const event = makeFreeze(state, { id, account: 'acct', amount, memberId });
  return { event, result: applyEvent(state, event) };
}

test('acceptance 1: freeze from newly added member merges and deducts quota', () => {
  const a = createState();
  setAccountLimit(a, 'acct', 1000);
  assert.equal(applyEvent(a, makeAddMember(a, { id: 'cfg-1', memberId: 'm1' })).ok, true);

  const b = clone(a);
  assert.equal(applyEvent(b, makeAddMember(b, { id: 'cfg-2', memberId: 'm2' })).ok, true);
  const f1 = makeFreeze(b, { id: 'f1', account: 'acct', amount: 200, memberId: 'm2' });
  assert.equal(applyEvent(b, f1).ok, true);

  const result = mergeStates(a, b);
  assert.deepEqual(result.rejected, []);
  assert.ok(result.merged.includes('cfg-2'));
  assert.ok(result.merged.includes('f1'));
  assert.deepEqual(getAccount(a, 'acct'), { account: 'acct', limit: 1000, frozen: 200, available: 800 });
});

test('acceptance 2: remove-member without full observed frontier fails (remove-incomplete)', () => {
  const s = baseReplica();
  const f1 = freeze(s, 'f1', 'm1', 100).event;
  const f2 = freeze(s, 'f2', 'm1', 100).event;
  freeze(s, 'f3', 'm1', 100);

  const stale = makeRemoveMember(s, { id: 'cfg-rm-stale', memberId: 'm1', frontier: f2.hash });
  assert.equal(applyEvent(s, stale).error, 'remove-incomplete');
  assert.equal(s.members.m1.status, 'active');

  const missing = makeRemoveMember(s, { id: 'cfg-rm-missing', memberId: 'm1', frontier: '0'.repeat(64) });
  assert.equal(applyEvent(s, missing).error, 'remove-incomplete');

  const ok = makeRemoveMember(s, { id: 'cfg-rm-ok', memberId: 'm1' });
  assert.equal(applyEvent(s, ok).ok, true);
  assert.equal(s.members.m1.status, 'removed');
  assert.equal(s.members.m1.frontier, s.memberTips.m1);
  assert.ok(f1.hash !== f2.hash);
});

test('acceptance 2: merge rejects remove-member when frontier history is missing locally', () => {
  const full = baseReplica();
  freeze(full, 'f1', 'm1', 100);
  freeze(full, 'f2', 'm1', 100);
  freeze(full, 'f3', 'm1', 100);
  const rm = makeRemoveMember(full, { id: 'cfg-rm', memberId: 'm1' });
  assert.equal(applyEvent(full, rm).ok, true);

  const partial = baseReplica();
  applyEvent(partial, full.events.f1);

  const result = mergeStates(partial, full);
  assert.deepEqual(result.rejected, [{ id: 'cfg-rm', error: 'remove-incomplete' }]);
  assert.equal(partial.members.m1.status, 'active');
  assert.equal(getAccount(partial, 'acct').frozen, 300);
});

test('acceptance 3: pre-removal freezes stay valid, post-removal freezes are stale-member', () => {
  const base = baseReplica();
  freeze(base, 'f1', 'm1', 100);

  const remover = clone(base);
  assert.equal(applyEvent(remover, makeRemoveMember(remover, { id: 'cfg-rm', memberId: 'm1' })).ok, true);

  const staleReplica = clone(base);
  const f2 = makeFreeze(staleReplica, { id: 'f2', account: 'acct', amount: 100, memberId: 'm1' });
  assert.equal(applyEvent(staleReplica, f2).ok, true);

  const result = mergeStates(remover, staleReplica);
  assert.deepEqual(result.rejected, [{ id: 'f2', error: 'stale-member' }]);
  assert.equal(getAccount(remover, 'acct').frozen, 100);

  const local = makeFreeze(remover, { id: 'f3', account: 'acct', amount: 50, memberId: 'm1' });
  assert.equal(applyEvent(remover, local).error, 'stale-member');
});

test('acceptance 3: over-quota freeze is limit-exceeded, locally and on merge', () => {
  const s = baseReplica();
  const big = makeFreeze(s, { id: 'big', account: 'acct', amount: 1001, memberId: 'm1' });
  assert.equal(applyEvent(s, big).error, 'limit-exceeded');

  const a = baseReplica();
  const b = clone(a);
  freeze(a, 'fa', 'm1', 600);
  freeze(b, 'fb', 'm2', 600);
  const result = mergeStates(a, b);
  assert.deepEqual(result.rejected, [{ id: 'fb', error: 'limit-exceeded' }]);
  assert.equal(getAccount(a, 'acct').frozen, 600);
});

test('two members, three events, removal boundary checked against reference table', () => {
  const amounts = { e1: 100, e2: 200, e3: 300 };
  const ids = ['e1', 'e2', 'e3'];

  // Independent reference table: expected frozen amount after m1 is removed
  // with a frontier covering only m1's first event, per author combo (e1e2e3).
  const REFERENCE_FROZEN = {
    111: 100,
    112: 400,
    121: 300,
    122: 600,
    211: 300,
    212: 600,
    221: 600,
    222: 600,
  };
  const REFERENCE_STALE = { 111: 2, 112: 1, 121: 1, 122: 0, 211: 1, 212: 0, 221: 0, 222: 0 };

  for (const combo of Object.keys(REFERENCE_FROZEN)) {
    const authors = combo.split('').map((c) => 'm' + c);

    const source = baseReplica();
    const events = {};
    ids.forEach((id, i) => {
      events[id] = makeFreeze(source, { id, account: 'acct', amount: amounts[id], memberId: authors[i] });
      assert.equal(applyEvent(source, events[id]).ok, true, `combo ${combo} source ${id}`);
    });

    // Observer only sees events up to and including m1's first event, then removes m1.
    const observer = baseReplica();
    const firstM1 = ids.find((id, i) => authors[i] === 'm1');
    if (firstM1) {
      const cutoff = ids.indexOf(firstM1);
      for (const id of ids.slice(0, cutoff + 1)) {
        assert.equal(applyEvent(observer, events[id]).ok, true, `combo ${combo} observer ${id}`);
      }
    }
    const rm = makeRemoveMember(observer, { id: 'cfg-rm-' + combo, memberId: 'm1' });
    assert.equal(applyEvent(observer, rm).ok, true, `combo ${combo} remove`);

    const result = mergeStates(observer, source);
    const staleCount = result.rejected.filter((r) => r.error === 'stale-member').length;
    assert.equal(staleCount, REFERENCE_STALE[combo], `combo ${combo} stale count`);
    assert.equal(getAccount(observer, 'acct').frozen, REFERENCE_FROZEN[combo], `combo ${combo} frozen`);
    assert.equal(
      getAccount(observer, 'acct').available,
      1000 - REFERENCE_FROZEN[combo],
      `combo ${combo} available`,
    );

    // Boundary: removal with the full tip as frontier keeps every event valid.
    const fullObserver = clone(source);
    const rmFull = makeRemoveMember(fullObserver, { id: 'cfg-rm-full-' + combo, memberId: 'm1' });
    assert.equal(applyEvent(fullObserver, rmFull).ok, true, `combo ${combo} full remove`);
    const fullResult = mergeStates(fullObserver, source);
    assert.deepEqual(fullResult.rejected, [], `combo ${combo} full rejected`);
    assert.equal(getAccount(fullObserver, 'acct').frozen, 600, `combo ${combo} full frozen`);
  }
});

test('release returns quota, rejects double and unknown releases, and merges', () => {
  const a = baseReplica();
  freeze(a, 'f1', 'm1', 100);
  assert.equal(getAccount(a, 'acct').frozen, 100);

  const r1 = makeRelease(a, { id: 'r1', memberId: 'm2', target: 'f1' });
  assert.equal(applyEvent(a, r1).ok, true);
  assert.equal(getAccount(a, 'acct').frozen, 0);

  const r2 = makeRelease(a, { id: 'r2', memberId: 'm2', target: 'f1' });
  assert.equal(applyEvent(a, r2).error, 'already-released');

  const r3 = makeRelease(a, { id: 'r3', memberId: 'm2', target: 'nope' });
  assert.equal(applyEvent(a, r3).error, 'unknown-freeze');

  const b = baseReplica();
  const result = mergeStates(b, a);
  assert.deepEqual(result.rejected, [
    { id: 'r2', error: 'already-released' },
    { id: 'r3', error: 'unknown-freeze' },
  ]);
  assert.equal(getAccount(b, 'acct').frozen, 0);
});

test('diff reports missing freeze, release and member event ids; merge converges', () => {
  const a = baseReplica();
  const b = clone(a);

  freeze(a, 'fa', 'm1', 100);
  const ra = makeRelease(a, { id: 'ra', memberId: 'm1', target: 'fa' });
  assert.equal(applyEvent(a, ra).ok, true);
  assert.equal(applyEvent(a, makeAddMember(a, { id: 'cfg-3', memberId: 'm3' })).ok, true);

  freeze(b, 'fb', 'm2', 50);

  assert.deepEqual(diffStates(a, b), { missingFreezes: ['fb'], missingReleases: [], missingMembers: [] });
  assert.deepEqual(diffStates(b, a), {
    missingFreezes: ['fa'],
    missingReleases: ['ra'],
    missingMembers: ['cfg-3'],
  });

  mergeStates(a, b);
  mergeStates(b, a);
  assert.deepEqual(diffStates(a, b), { missingFreezes: [], missingReleases: [], missingMembers: [] });
  assert.deepEqual(diffStates(b, a), { missingFreezes: [], missingReleases: [], missingMembers: [] });
  assert.equal(getAccount(a, 'acct').frozen, 50);
  assert.equal(getAccount(b, 'acct').frozen, 50);
});
