import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processHistory, HistoryError } from '../src/engine.js';
import { run } from '../cli.js';

const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));

function ev(requestId, key, ts, amount, action) {
  return { requestId, idempotencyKey: key, ts, amount, action };
}

// ---------------------------------------------------------------------------
// Independent serial model: deliberately written separately from the engine.
// It keeps per-request queues, repeatedly drains the logically earliest event,
// and applies the transition rules with plain conditionals.
// ---------------------------------------------------------------------------
function serialModel(quota, events) {
  const seen = new Set();
  const queues = new Map();
  for (const e of events) {
    if (seen.has(e.idempotencyKey)) continue;
    seen.add(e.idempotencyKey);
    if (!queues.has(e.requestId)) queues.set(e.requestId, []);
    queues.get(e.requestId).push(e);
  }
  const rank = { FREEZE: 0, CONFIRM: 1, CANCEL: 2 };
  for (const q of queues.values()) {
    q.sort((x, y) => x.ts - y.ts || rank[x.action] - rank[y.action]
      || (x.idempotencyKey < y.idempotencyKey ? -1 : 1));
  }

  let balance = quota;
  const state = new Map();
  const held = new Map();
  const accepted = [];
  const statusByKey = new Map();

  for (;;) {
    let bestId = null;
    let bestHead = null;
    for (const [id, q] of queues) {
      if (q.length === 0) continue;
      const head = q[0];
      if (bestHead === null
        || head.ts < bestHead.ts
        || (head.ts === bestHead.ts && id < bestId)) {
        bestId = id;
        bestHead = head;
      }
    }
    if (bestHead === null) break;
    queues.get(bestId).shift();

    const s = state.get(bestId) ?? 'none';
    const e = bestHead;
    let status;
    if (e.action === 'FREEZE') {
      if (s === 'none' && e.amount <= balance) {
        balance -= e.amount;
        state.set(bestId, 'frozen');
        held.set(bestId, e.amount);
        status = 'accepted';
      } else if (s === 'none') {
        state.set(bestId, 'rejected');
        status = 'rejected';
      } else {
        status = 'invalid';
      }
    } else if (e.action === 'CONFIRM') {
      if (s === 'frozen') {
        state.set(bestId, 'confirmed');
        status = 'accepted';
      } else {
        status = 'invalid';
      }
    } else {
      if (s === 'frozen' || s === 'confirmed') {
        balance += held.get(bestId);
        held.set(bestId, 0);
        state.set(bestId, s === 'frozen' ? 'released' : 'compensated');
        status = 'accepted';
      } else {
        status = 'invalid';
      }
    }
    statusByKey.set(e.idempotencyKey, status);
    if (status === 'accepted') accepted.push(e.idempotencyKey);
  }
  return { accepted, statusByKey, balance };
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

function scenarioEvents() {
  return [
    ev('req-a', 'k-a-freeze', 1, 6, 'FREEZE'),
    ev('req-b', 'k-b-freeze', 2, 6, 'FREEZE'),
    ev('req-c', 'k-c-freeze', 3, 3, 'FREEZE'),
    ev('req-a', 'k-a-confirm', 4, 6, 'CONFIRM'),
    ev('req-b', 'k-b-confirm', 5, 6, 'CONFIRM'),
    ev('req-c', 'k-c-confirm', 6, 3, 'CONFIRM'),
  ];
}

test('quota 10 with requests 6/6/3: every arrival permutation yields the same certificate', () => {
  const events = scenarioEvents();
  const baseline = processHistory({ quota: 10, events });

  assert.deepEqual(
    baseline.acceptedOrder.map((r) => r.idempotencyKey),
    ['k-a-freeze', 'k-c-freeze', 'k-a-confirm', 'k-c-confirm'],
  );
  assert.equal(baseline.finalState.available, 1);
  assert.equal(baseline.results.find((r) => r.idempotencyKey === 'k-b-freeze').status, 'rejected');
  assert.equal(
    baseline.results.find((r) => r.idempotencyKey === 'k-b-confirm').reason,
    'CONFIRM_AFTER_REJECTED_FREEZE',
  );

  let count = 0;
  for (const perm of permutations(events)) {
    const outcome = processHistory({ quota: 10, events: perm });
    assert.deepEqual(outcome.acceptedOrder, baseline.acceptedOrder);
    assert.equal(outcome.stateHash, baseline.stateHash);
    assert.equal(outcome.finalState.available, 1);
    count += 1;
  }
  assert.equal(count, 720);
});

test('independent serial model agrees with engine on accept/reject/balance for all permutations', () => {
  const events = scenarioEvents();
  for (const perm of permutations(events)) {
    const engine = processHistory({ quota: 10, events: perm });
    const model = serialModel(10, perm);

    assert.deepEqual(
      engine.acceptedOrder.map((r) => r.idempotencyKey),
      model.accepted,
    );
    for (const record of engine.results) {
      assert.equal(record.status, model.statusByKey.get(record.idempotencyKey));
    }
    assert.equal(engine.finalState.available, model.balance);
  }
});

test('duplicate messages are deduplicated and never occupy quota twice', () => {
  const events = scenarioEvents();
  const doubled = [...events, ...events.map((e) => ({ ...e }))];
  const withDupes = processHistory({ quota: 10, events: doubled });
  const baseline = processHistory({ quota: 10, events });

  assert.deepEqual(withDupes.acceptedOrder, baseline.acceptedOrder);
  assert.equal(withDupes.stateHash, baseline.stateHash);
  assert.equal(withDupes.finalState.available, 1);
  assert.equal(withDupes.duplicates.length, events.length);
});

test('idempotency key reused with a different payload is a hard error', () => {
  const events = [
    ev('req-a', 'k-dup', 1, 6, 'FREEZE'),
    ev('req-a', 'k-dup', 2, 6, 'FREEZE'),
  ];
  assert.throws(
    () => processHistory({ quota: 10, events }),
    (err) => err instanceof HistoryError && err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('late-arriving CANCEL that logically precedes CONFIRM wins; CONFIRM reports a clear status', () => {
  const physicalArrival = [
    ev('req-a', 'k-a-freeze', 1, 6, 'FREEZE'),
    ev('req-a', 'k-a-confirm', 5, 6, 'CONFIRM'),
    ev('req-a', 'k-a-cancel', 3, 6, 'CANCEL'),
  ];
  const outcome = processHistory({ quota: 10, events: physicalArrival });

  const cancel = outcome.results.find((r) => r.idempotencyKey === 'k-a-cancel');
  const confirm = outcome.results.find((r) => r.idempotencyKey === 'k-a-confirm');
  assert.equal(cancel.status, 'accepted');
  assert.equal(confirm.status, 'invalid');
  assert.equal(confirm.reason, 'CONFIRM_NOT_ALLOWED_FROM_RELEASED');
  assert.equal(outcome.finalState.available, 10);
  assert.equal(outcome.finalState.requests['req-a'].state, 'released');
});

test('CANCEL after CONFIRM produces a compensating release', () => {
  const events = [
    ev('req-a', 'k-a-freeze', 1, 6, 'FREEZE'),
    ev('req-a', 'k-a-confirm', 2, 6, 'CONFIRM'),
    ev('req-a', 'k-a-cancel', 3, 6, 'CANCEL'),
  ];
  const outcome = processHistory({ quota: 10, events });

  const cancel = outcome.results.find((r) => r.idempotencyKey === 'k-a-cancel');
  assert.equal(cancel.status, 'accepted');
  assert.equal(cancel.reason, 'COMPENSATING_RELEASE');
  assert.equal(outcome.finalState.available, 10);
  assert.equal(outcome.finalState.requests['req-a'].state, 'compensated');
});

test('CONFIRM after a rejected FREEZE is invalid and holds no quota', () => {
  const events = [
    ev('req-a', 'k-a-freeze', 1, 6, 'FREEZE'),
    ev('req-b', 'k-b-freeze', 2, 6, 'FREEZE'),
    ev('req-b', 'k-b-confirm', 3, 6, 'CONFIRM'),
  ];
  const outcome = processHistory({ quota: 10, events });

  const confirm = outcome.results.find((r) => r.idempotencyKey === 'k-b-confirm');
  assert.equal(confirm.status, 'invalid');
  assert.equal(confirm.reason, 'CONFIRM_AFTER_REJECTED_FREEZE');
  assert.equal(outcome.finalState.available, 4);
});

test('replaying the same history always yields the identical state hash', () => {
  const events = scenarioEvents();
  const first = processHistory({ quota: 10, events });
  const second = processHistory({ quota: 10, events: [...events].reverse() });
  const third = processHistory({ quota: 10, events });
  assert.equal(first.stateHash, second.stateHash);
  assert.equal(first.stateHash, third.stateHash);
  assert.match(first.stateHash, /^[0-9a-f]{64}$/);
});

test('concurrent competition is ordered by logical timestamp then requestId', () => {
  const events = [
    ev('req-b', 'k-b-freeze', 1, 6, 'FREEZE'),
    ev('req-a', 'k-a-freeze', 1, 6, 'FREEZE'),
  ];
  const outcome = processHistory({ quota: 10, events });
  assert.deepEqual(
    outcome.acceptedOrder.map((r) => r.idempotencyKey),
    ['k-a-freeze'],
  );
  assert.equal(outcome.results.find((r) => r.idempotencyKey === 'k-b-freeze').status, 'rejected');
});

async function runCliInProcess(args) {
  const out = [];
  const err = [];
  const status = await run(args, {
    stdout: (chunk) => out.push(chunk),
    stderr: (chunk) => err.push(chunk),
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

test('cli emits a certificate with acceptedOrder and stateHash on stdout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-cli-'));
  const file = join(dir, 'history.json');
  writeFileSync(file, JSON.stringify({ quota: 10, events: scenarioEvents() }));

  const proc = await runCliInProcess([file]);
  assert.equal(proc.status, 0, proc.stderr);
  const certificate = JSON.parse(proc.stdout);
  assert.ok(Array.isArray(certificate.acceptedOrder));
  assert.match(certificate.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(certificate.finalState.available, 1);
});

test('cli exits 1 with standard error JSON on invalid input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-cli-'));

  const missing = await runCliInProcess([join(dir, 'nope.json')]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'INPUT_ERROR');

  const badFile = join(dir, 'bad.json');
  writeFileSync(badFile, JSON.stringify({ quota: 10, events: [{ requestId: 'x' }] }));
  const invalid = await runCliInProcess([badFile]);
  assert.equal(invalid.status, 1);
  const payload = JSON.parse(invalid.stderr);
  assert.equal(payload.error.code, 'INVALID_EVENT');
  assert.ok(typeof payload.error.message === 'string');

  const noArgs = await runCliInProcess([]);
  assert.equal(noArgs.status, 1);
  assert.equal(JSON.parse(noArgs.stderr).error.code, 'USAGE');
});

test('cli works end to end as a real process', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-cli-'));
  const file = join(dir, 'history.json');
  writeFileSync(file, JSON.stringify({ quota: 10, events: scenarioEvents() }));

  const ok = spawnSync(process.execPath, [CLI_PATH, file], { encoding: 'utf8' });
  if (ok.error && ok.error.code === 'EPERM') {
    t.skip('spawning child processes is not permitted in this environment');
    return;
  }
  assert.equal(ok.status, 0, ok.stderr);
  const certificate = JSON.parse(ok.stdout);
  assert.ok(Array.isArray(certificate.acceptedOrder));
  assert.match(certificate.stateHash, /^[0-9a-f]{64}$/);

  const bad = spawnSync(process.execPath, [CLI_PATH, join(dir, 'nope.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, 'INPUT_ERROR');
});
