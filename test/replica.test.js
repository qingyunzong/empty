import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Replica } from '../src/replica.js';

const TOTAL = 100;

function setup() {
  const replica = Replica.init({ account: 'acct', total: TOTAL, memberId: 'm1' });
  const res = replica.addMember({ member: 'm2', by: 'm1' });
  assert.equal(res.error, undefined);
  return replica;
}

function available(replica) {
  const acct = replica.state.accounts.acct;
  return acct.total - acct.frozen;
}

// Independent reference model: plain sequential replay, no shared code with Replica.
function reference(script, total = TOTAL) {
  const active = new Set(['m1', 'm2']);
  const requests = new Map();
  let frozen = 0;
  const results = [];
  for (const step of script) {
    const issuer = step.op === 'freeze' || step.op === 'release' ? step.memberId : step.by;
    if (!active.has(issuer)) {
      results.push('stale-member');
      continue;
    }
    if (step.op === 'freeze') {
      if (frozen + step.amount > total) {
        results.push('limit-exceeded');
        continue;
      }
      frozen += step.amount;
      requests.set(step.requestId, step.amount);
      results.push('ok');
    } else if (step.op === 'release') {
      frozen -= requests.get(step.requestId);
      results.push('ok');
    } else if (step.op === 'remove') {
      active.delete(step.member);
      results.push('ok');
    }
  }
  return { results, available: total - frozen };
}

function runScript(replica, script) {
  const results = [];
  for (const step of script) {
    let res;
    if (step.op === 'freeze') {
      res = replica.freeze({
        requestId: step.requestId,
        account: 'acct',
        amount: step.amount,
        memberId: step.memberId,
      });
    } else if (step.op === 'release') {
      res = replica.release({ requestId: step.requestId, memberId: step.memberId });
    } else if (step.op === 'remove') {
      res = replica.removeMember({
        member: step.member,
        by: step.by,
        frontier: { ...replica.state.frontier },
      });
    }
    results.push(res.error ?? 'ok');
  }
  return results;
}

const fz = (memberId, amount, requestId) => ({ op: 'freeze', memberId, amount, requestId });
const rl = (memberId, requestId) => ({ op: 'release', memberId, requestId });
const rm = (member, by = 'm1') => ({ op: 'remove', member, by });

test('acceptance 1: freeze by newly added member merges and deducts quota', () => {
  const a = setup();
  const b = Replica.init({ account: 'acct', total: TOTAL, memberId: 'm1' });

  const frozen = a.freeze({ requestId: 'r1', account: 'acct', amount: 40, memberId: 'm2' });
  assert.equal(frozen.error, undefined);
  assert.equal(available(a), 60);

  const diff = b.diff(a.toJSON());
  assert.equal(diff.missingFreezes.length, 1);
  assert.equal(diff.missingMembers.length, 1);

  const merged = b.merge(a.toJSON());
  assert.equal(merged.rejected.length, 0);
  assert.equal(merged.applied.length, 2);
  assert.equal(available(b), 60);
  assert.equal(b.state.epoch, 1);
});

test('acceptance 2: remove-member fails without backfilled member history', () => {
  const a = setup();
  a.freeze({ requestId: 'r1', account: 'acct', amount: 40, memberId: 'm2' });
  const removeEvent = a.createEvent('remove-member', {
    member: 'm2',
    by: 'm1',
    frontier: { ...a.state.frontier },
  });
  assert.equal(a.applyEvent(removeEvent).error, undefined);

  // Replica B saw m2 join but not m2's freeze: removal must be rejected.
  const b = Replica.init({ account: 'acct', total: TOTAL, memberId: 'm1' });
  const addEvent = Object.values(a.state.events).find((e) => e.type === 'add-member');
  assert.equal(b.applyEvent(addEvent).error, undefined);
  const merged = b.merge([removeEvent]);
  assert.deepEqual(
    merged.rejected.map((r) => r.error),
    ['remove-incomplete'],
  );
  assert.equal(b.state.members.m2.active, true);

  // After backfilling m2's history the same removal applies.
  const backfill = b.merge(a.toJSON());
  assert.equal(backfill.rejected.length, 0);
  assert.equal(b.state.members.m2.active, false);

  // Local CLI-style removal with a frontier missing the member's latest hash.
  const c = setup();
  c.freeze({ requestId: 'r1', account: 'acct', amount: 10, memberId: 'm2' });
  assert.equal(c.removeMember({ member: 'm2', by: 'm1', frontier: {} }).error, 'remove-incomplete');
  assert.equal(
    c.removeMember({ member: 'm2', by: 'm1', frontier: { m1: c.state.frontier.m1, m2: null } }).error,
    'remove-incomplete',
  );
});

test('acceptance 3: stale freeze from removed member and over-limit freeze rejected', () => {
  const replica = setup();
  replica.freeze({ requestId: 'r1', account: 'acct', amount: 40, memberId: 'm2' });
  assert.equal(replica.removeMember({ member: 'm2', by: 'm1' }).error, undefined);

  assert.equal(
    replica.freeze({ requestId: 'r2', account: 'acct', amount: 5, memberId: 'm2' }).error,
    'stale-member',
  );
  assert.equal(
    replica.freeze({ requestId: 'r3', account: 'acct', amount: 61, memberId: 'm1' }).error,
    'limit-exceeded',
  );
  // Confirmed freeze from before the removal is still effective.
  assert.equal(replica.state.accounts.acct.frozen, 40);
});

test('reference table: two members, three events, removal boundary', () => {
  const cases = [
    { script: [fz('m1', 40, 'r1'), fz('m2', 40, 'r2'), fz('m1', 40, 'r3')], expect: ['ok', 'ok', 'limit-exceeded'], available: 20 },
    { script: [fz('m2', 40, 'r1'), fz('m2', 40, 'r2'), fz('m2', 40, 'r3')], expect: ['ok', 'ok', 'limit-exceeded'], available: 20 },
    { script: [fz('m1', 30, 'r1'), rl('m1', 'r1'), fz('m2', 50, 'r2')], expect: ['ok', 'ok', 'ok'], available: 50 },
    { script: [fz('m2', 40, 'r1'), rm('m2'), fz('m1', 40, 'r2')], expect: ['ok', 'ok', 'ok'], available: 20 },
    { script: [fz('m2', 40, 'r1'), rm('m2'), fz('m2', 10, 'r2')], expect: ['ok', 'ok', 'stale-member'], available: 60 },
    { script: [fz('m2', 40, 'r1'), rm('m2'), rl('m1', 'r1')], expect: ['ok', 'ok', 'ok'], available: 100 },
    { script: [fz('m1', 40, 'r1'), rm('m2'), fz('m2', 10, 'r2')], expect: ['ok', 'ok', 'stale-member'], available: 60 },
    { script: [fz('m2', 40, 'r1'), fz('m1', 40, 'r2'), rm('m2')], expect: ['ok', 'ok', 'ok'], available: 20 },
  ];
  for (const [index, { script, expect, available: expectedAvailable }] of cases.entries()) {
    const replica = setup();
    const results = runScript(replica, script);
    const ref = reference(script);
    assert.deepEqual(results, expect, `case ${index} results`);
    assert.deepEqual(results, ref.results, `case ${index} matches reference`);
    assert.equal(available(replica), expectedAvailable, `case ${index} available`);
    assert.equal(available(replica), ref.available, `case ${index} available matches reference`);
  }
});

test('enumeration: all 2-member issuer sequences of 3 freezes match reference', () => {
  for (const amount of [30, 40, 60]) {
    for (let mask = 0; mask < 8; mask += 1) {
      const issuers = [0, 1, 2].map((bit) => (mask & (1 << bit) ? 'm2' : 'm1'));
      const script = issuers.map((memberId, i) => fz(memberId, amount, `r${i}`));
      const replica = setup();
      const results = runScript(replica, script);
      const ref = reference(script);
      assert.deepEqual(results, ref.results, `mask=${mask} amount=${amount}`);
      assert.equal(available(replica), ref.available, `mask=${mask} amount=${amount}`);
    }
  }
});

test('merge rejects events from removed member and keeps confirmed freezes', () => {
  const a = setup();
  a.freeze({ requestId: 'r1', account: 'acct', amount: 40, memberId: 'm2' });
  a.removeMember({ member: 'm2', by: 'm1' });

  // m2 keeps issuing events on a forked replica that never saw the removal.
  const fork = Replica.init({ account: 'acct', total: TOTAL, memberId: 'm1' });
  fork.merge(a.toJSON());
  const staleFreeze = fork.createEvent('freeze', {
    requestId: 'r9',
    account: 'acct',
    amount: 5,
    memberId: 'm2',
  });
  assert.equal(fork.applyEvent(staleFreeze).error, 'stale-member');
  assert.equal(a.applyEvent(staleFreeze).error, 'stale-member');
  assert.equal(a.state.accounts.acct.frozen, 40);
});

test('release of unknown or mismatched request is rejected', () => {
  const replica = setup();
  replica.freeze({ requestId: 'r1', account: 'acct', amount: 30, memberId: 'm1' });
  assert.equal(replica.release({ requestId: 'nope', memberId: 'm1' }).error, 'unknown-request');
  assert.equal(replica.release({ requestId: 'r1', memberId: 'm1', amount: 31 }).error, 'amount-mismatch');
  assert.equal(replica.release({ requestId: 'r1', memberId: 'm1' }).error, undefined);
  assert.equal(available(replica), 100);
});
