import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  emptyState,
  applyEvent,
  deriveState,
  execute,
  netBalances,
  batchStatus,
  LedgerError,
} from '../src/ledger.js';

function run(state, command, cmd) {
  const { events, result } = execute(state, command, cmd);
  for (const event of events) applyEvent(state, event);
  return { events, result };
}

function buildScenario() {
  const state = emptyState();
  const log = [];
  const track = (command, cmd) => {
    const { events, result } = run(state, command, cmd);
    log.push(...events);
    return result;
  };
  track('create-batch', {
    requestId: 'req-create',
    batchId: 'B1',
    entries: [
      { entryId: 'e1', account: 'alice', amount: 1000 },
      { entryId: 'e2', account: 'bob', amount: -300 },
      { entryId: 'e3', account: 'carol', amount: -500 },
    ],
  });
  track('apply-correction', {
    requestId: 'req-c2',
    batchId: 'B1',
    version: 2,
    corrections: [
      { type: 'adjust', entryId: 'e2', newAmount: -250 },
      { type: 'add', entryId: 'e4', account: 'dave', amount: 120 },
      { type: 'reverse', entryId: 'e3' },
    ],
  });
  track('apply-correction', {
    requestId: 'req-c3',
    batchId: 'B1',
    version: 3,
    corrections: [
      { type: 'adjust', entryId: 'e1', newAmount: 900 },
      { type: 'add', entryId: 'e5', account: 'alice', amount: -50 },
    ],
  });
  return { state, log, track };
}

test('acceptance: two consecutive corrections settle at final net amounts', () => {
  const { state, track } = buildScenario();
  const confirmed = track('confirm', { requestId: 'req-confirm', batchId: 'B1' });
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.certificate.accounts, { alice: 850, bob: -250, dave: 120 });
  assert.equal(confirmed.certificate.version, 3);
  assert.equal(confirmed.certificate.frozenTotal, 200);
  const status = batchStatus(state, 'B1');
  assert.deepEqual(status.balances, { alice: 850, bob: -250, dave: 120 });
});

test('acceptance: shuffled replay of the full history yields the same certificate', () => {
  const { log, track } = buildScenario();
  const confirmed = track('confirm', { requestId: 'req-confirm', batchId: 'B1' });
  const expectedHash = confirmed.certificate.hash;

  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 50; round += 1) {
    const shuffled = [...log];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const replayed = deriveState(shuffled);
    const status = batchStatus(replayed, 'B1');
    assert.equal(status.certificate.hash, expectedHash);
    assert.deepEqual(status.balances, { alice: 850, bob: -250, dave: 120 });
    assert.equal(status.version, 3);
    assert.equal(status.status, 'confirmed');
  }
});

test('acceptance: cancel after confirm zeroes all balances and keeps the audit chain', () => {
  const { state, log, track } = buildScenario();
  track('confirm', { requestId: 'req-confirm', batchId: 'B1' });
  const cancelled = track('cancel', { requestId: 'req-cancel', batchId: 'B1' });
  assert.equal(cancelled.mode, 'compensate');

  const status = batchStatus(state, 'B1');
  assert.deepEqual(status.balances, {});
  for (const value of netBalances(state.batches.get('B1')).values()) {
    assert.equal(value, 0);
  }

  const types = log.map((e) => e.type);
  assert.deepEqual(types, [
    'batch_created',
    'correction_applied',
    'correction_applied',
    'confirmed',
    'cancelled',
  ]);
  assert.equal(status.certificate.hash, cancelled ? status.certificate.hash : null);
  assert.notEqual(status.certificate, null);
  assert.deepEqual(status.compensation, [
    { account: 'alice', amount: -850 },
    { account: 'bob', amount: 250 },
    { account: 'dave', amount: -120 },
  ]);
});

test('cancel before confirm releases the freeze without compensation', () => {
  const { state, track } = buildScenario();
  const cancelled = track('cancel', { requestId: 'req-cancel', batchId: 'B1' });
  assert.equal(cancelled.mode, 'release');
  assert.equal(cancelled.released, 200);
  const status = batchStatus(state, 'B1');
  assert.equal(status.status, 'cancelled');
  assert.deepEqual(status.compensation, []);
});

test('acceptance: stale version resubmission returns VERSION_CONFLICT and does not mutate state', () => {
  const { state, track } = buildScenario();
  const before = batchStatus(state, 'B1');
  assert.throws(
    () =>
      run(state, 'apply-correction', {
        requestId: 'req-stale',
        batchId: 'B1',
        version: 2,
        corrections: [{ type: 'add', entryId: 'e9', account: 'x', amount: 1 }],
      }),
    (err) => err instanceof LedgerError && err.code === 'VERSION_CONFLICT',
  );
  assert.throws(
    () =>
      run(state, 'apply-correction', {
        requestId: 'req-gap',
        batchId: 'B1',
        version: 5,
        corrections: [{ type: 'add', entryId: 'e9', account: 'x', amount: 1 }],
      }),
    (err) => err.code === 'VERSION_CONFLICT',
  );
  assert.deepEqual(batchStatus(state, 'B1'), before);
  track('confirm', { requestId: 'req-confirm', batchId: 'B1' });
});

test('acceptance: duplicate submission of the same request returns the original result', () => {
  const { state, log, track } = buildScenario();
  const logSize = log.length;
  const correction = {
    requestId: 'req-c4',
    batchId: 'B1',
    version: 4,
    corrections: [{ type: 'adjust', entryId: 'e1', newAmount: 880 }],
  };
  const first = run(state, 'apply-correction', correction);
  const second = run(state, 'apply-correction', correction);
  assert.deepEqual(second.result, first.result);
  assert.equal(second.events.length, 0);
  assert.equal(log.length, logSize);
  assert.equal(batchStatus(state, 'B1').version, 4);

  const confirmCmd = { requestId: 'req-confirm', batchId: 'B1' };
  const c1 = run(state, 'confirm', confirmCmd);
  const c2 = run(state, 'confirm', confirmCmd);
  assert.deepEqual(c2.result, c1.result);
  assert.equal(c2.events.length, 0);
});

// Independent brute-force oracle: plain signed summation + its own canonical hash.
function bfCanonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(bfCanonical).join(',') + ']';
  return (
    '{' +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + bfCanonical(value[k]))
      .join(',') +
    '}'
  );
}

function bfHash(value) {
  return createHash('sha256').update(bfCanonical(value), 'utf8').digest('hex');
}

test('brute force: all correction sign combinations for <=8 entries and 3 versions', () => {
  let scenarios = 0;
  for (let n = 1; n <= 8; n += 1) {
    const accounts = Array.from({ length: n }, (_, i) => `acct${i % 3}`);
    const initials = Array.from({ length: n }, (_, i) => (i + 1) * 100 * (i % 2 === 0 ? 1 : -1));
    const combos = 1 << n; // sign vectors per correction version
    for (let s2 = 0; s2 < combos; s2 += 1) {
      for (let s3 = 0; s3 < combos; s3 += 1) {
        const sign = (mask, i) => ((mask >> i) & 1 === 1 ? 1 : -1);
        const batchId = `BF-${n}-${s2}-${s3}`;

        // Brute-force net per account: initial + signed deltas from v2 and v3.
        const bfAccounts = {};
        for (let i = 0; i < n; i += 1) {
          const net = initials[i] + sign(s2, i) * (10 + i) + sign(s3, i) * (5 + i);
          bfAccounts[accounts[i]] = (bfAccounts[accounts[i]] ?? 0) + net;
        }
        const bfSorted = {};
        for (const key of Object.keys(bfAccounts).sort()) {
          if (bfAccounts[key] !== 0) bfSorted[key] = bfAccounts[key];
        }
        const bfBody = {
          batchId,
          version: 3,
          frozenTotal: initials.reduce((a, b) => a + b, 0),
          accounts: bfSorted,
        };
        const expectedHash = bfHash(bfBody);

        // System under test: same scenario through the real command pipeline.
        const state = emptyState();
        run(state, 'create-batch', {
          requestId: 'r1',
          batchId,
          entries: initials.map((amount, i) => ({ entryId: `e${i}`, account: accounts[i], amount })),
        });
        run(state, 'apply-correction', {
          requestId: 'r2',
          batchId,
          version: 2,
          corrections: initials.map((amount, i) => ({
            type: 'adjust',
            entryId: `e${i}`,
            newAmount: amount + sign(s2, i) * (10 + i),
          })),
        });
        run(state, 'apply-correction', {
          requestId: 'r3',
          batchId,
          version: 3,
          corrections: initials.map((amount, i) => ({
            type: 'adjust',
            entryId: `e${i}`,
            newAmount: amount + sign(s2, i) * (10 + i) + sign(s3, i) * (5 + i),
          })),
        });
        const { result } = run(state, 'confirm', { requestId: 'r4', batchId });

        assert.deepEqual(result.certificate.accounts, bfSorted, `accounts mismatch: ${batchId}`);
        assert.equal(result.certificate.hash, expectedHash, `hash mismatch: ${batchId}`);
        scenarios += 1;
      }
    }
  }
  assert.equal(scenarios, 87380); // sum of 4^n for n = 1..8
});
