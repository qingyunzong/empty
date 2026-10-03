import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { replay, canonicalOrder, LedgerError } from '../src/ledger.js';
import { runCli } from '../cli.js';

// --- independent enumerator: every arrival permutation of an event set -----

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

// --- independent serial model (reference implementation) -------------------
// Written directly from the spec: sort by (ts, requestId, action), dedupe by
// idempotency key, then walk a plain per-request state machine.

function referenceModel(events, quota) {
  const rank = { FREEZE: 0, CONFIRM: 1, CANCEL: 2 };
  const seen = new Set();
  const sorted = events
    .filter((e) => (seen.has(e.idempotencyKey) ? false : (seen.add(e.idempotencyKey), true)))
    .slice()
    .sort(
      (a, b) =>
        a.ts - b.ts ||
        (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0) ||
        rank[a.action] - rank[b.action]
    );

  const stateOf = new Map();
  let reserved = 0;
  let consumed = 0;
  const accepted = [];
  const rejected = [];

  for (const e of sorted) {
    const st = stateOf.get(e.requestId) || 'NONE';
    let ok = false;
    if (e.action === 'FREEZE') {
      if ((st === 'NONE' || st === 'REJECTED') && reserved + consumed + e.amount <= quota) {
        reserved += e.amount;
        stateOf.set(e.requestId, 'FROZEN');
        ok = true;
      } else if (st === 'NONE' || st === 'REJECTED') {
        stateOf.set(e.requestId, 'REJECTED');
      }
    } else if (e.action === 'CONFIRM') {
      if (st === 'FROZEN') {
        reserved -= e.amount;
        consumed += e.amount;
        stateOf.set(e.requestId, 'CONFIRMED');
        ok = true;
      }
    } else if (e.action === 'CANCEL') {
      if (st === 'FROZEN') {
        reserved -= e.amount;
        stateOf.set(e.requestId, 'CANCELLED');
        ok = true;
      } else if (st === 'CONFIRMED') {
        consumed -= e.amount;
        stateOf.set(e.requestId, 'COMPENSATED');
        ok = true;
      }
    }
    (ok ? accepted : rejected).push(`${e.requestId}:${e.action}`);
  }

  return { accepted, rejected, reserved, consumed, available: quota - reserved - consumed };
}

// --- fixtures ---------------------------------------------------------------

function quota10Events() {
  return [
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 6, action: 'FREEZE' },
    { requestId: 'r2', idempotencyKey: 'k2', ts: 2, amount: 6, action: 'FREEZE' },
    { requestId: 'r3', idempotencyKey: 'k3', ts: 3, amount: 3, action: 'FREEZE' },
    { requestId: 'r1', idempotencyKey: 'k4', ts: 4, amount: 6, action: 'CONFIRM' },
    { requestId: 'r2', idempotencyKey: 'k5', ts: 5, amount: 6, action: 'CONFIRM' },
    { requestId: 'r3', idempotencyKey: 'k6', ts: 6, amount: 3, action: 'CONFIRM' },
  ];
}

// --- tests ------------------------------------------------------------------

test('all 720 arrival permutations of 3 concurrent requests yield one certificate', () => {
  const events = quota10Events();
  const base = replay(events, 10);
  let count = 0;
  for (const perm of permutations(events)) {
    const cert = replay(perm, 10);
    assert.deepEqual(cert.acceptedOrder, base.acceptedOrder);
    assert.equal(cert.stateHash, base.stateHash);
    count += 1;
  }
  assert.equal(count, 720);
});

test('independent serial model agrees on accepts, rejects and balances', () => {
  const events = quota10Events();
  for (const perm of permutations(events)) {
    const cert = replay(perm, 10);
    const ref = referenceModel(perm, 10);

    const accepted = cert.decisions.filter((d) => d.accepted).map((d) => `${d.requestId}:${d.action}`);
    const rejected = cert.decisions.filter((d) => !d.accepted).map((d) => `${d.requestId}:${d.action}`);
    assert.deepEqual(accepted, ref.accepted);
    assert.deepEqual(rejected, ref.rejected);
    assert.equal(cert.finalState.reserved, ref.reserved);
    assert.equal(cert.finalState.consumed, ref.consumed);
    assert.equal(cert.finalState.available, ref.available);
  }
});

test('quota 10 with 6/6/3: second 6 is rejected, never oversells', () => {
  const cert = replay(quota10Events(), 10);
  const byKey = new Map(cert.decisions.map((d) => [d.idempotencyKey, d.status]));
  assert.equal(byKey.get('k1'), 'FROZEN');
  assert.equal(byKey.get('k2'), 'REJECTED_INSUFFICIENT_QUOTA');
  assert.equal(byKey.get('k3'), 'FROZEN');
  assert.equal(byKey.get('k4'), 'CONFIRMED');
  assert.equal(byKey.get('k5'), 'CONFIRM_WITHOUT_FREEZE');
  assert.equal(byKey.get('k6'), 'CONFIRMED');
  assert.deepEqual(
    cert.acceptedOrder.map((d) => `${d.requestId}:${d.action}:${d.status}`),
    ['r1:FREEZE:FROZEN', 'r3:FREEZE:FROZEN', 'r1:CONFIRM:CONFIRMED', 'r3:CONFIRM:CONFIRMED']
  );
  assert.deepEqual(cert.finalState, {
    quota: 10,
    reserved: 0,
    consumed: 9,
    available: 1,
    requests: { r1: 'CONFIRMED', r2: 'REJECTED', r3: 'CONFIRMED' },
  });
});

test('duplicate messages never double-reserve', () => {
  const freeze = { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 4, action: 'FREEZE' };
  // Same key retried, plus same payload under a new key, plus a late retry.
  const events = [
    freeze,
    { ...freeze },
    { ...freeze, idempotencyKey: 'k2' },
    { requestId: 'r1', idempotencyKey: 'k3', ts: 2, amount: 4, action: 'FREEZE' },
  ];
  const cert = replay(events, 10);
  assert.equal(cert.finalState.reserved, 4);
  const statuses = cert.decisions.map((d) => d.status);
  assert.deepEqual(statuses, ['FROZEN', 'DUPLICATE', 'DUPLICATE']);
  assert.equal(cert.acceptedOrder.length, 1);
});

test('idempotency key reused with a different payload is an error', () => {
  const events = [
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 4, action: 'FREEZE' },
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 5, action: 'FREEZE' },
  ];
  assert.throws(() => replay(events, 10), (err) => err instanceof LedgerError && err.code === 'IDEMPOTENCY_CONFLICT');
});

test('late cancel after confirm emits a compensating release', () => {
  const events = [
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 6, action: 'FREEZE' },
    { requestId: 'r1', idempotencyKey: 'k2', ts: 2, amount: 6, action: 'CONFIRM' },
    { requestId: 'r1', idempotencyKey: 'k3', ts: 3, amount: 6, action: 'CANCEL' },
  ];
  const cert = replay(events, 10);
  const cancel = cert.decisions.find((d) => d.action === 'CANCEL');
  assert.equal(cancel.status, 'COMPENSATED');
  assert.equal(cancel.accepted, true);
  assert.equal(cert.finalState.consumed, 0);
  assert.equal(cert.finalState.available, 10);
  assert.equal(cert.finalState.requests.r1, 'COMPENSATED');
});

test('confirm after cancel reports an explicit conflict status', () => {
  const events = [
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 6, action: 'FREEZE' },
    { requestId: 'r1', idempotencyKey: 'k2', ts: 2, amount: 6, action: 'CANCEL' },
    { requestId: 'r1', idempotencyKey: 'k3', ts: 3, amount: 6, action: 'CONFIRM' },
  ];
  const cert = replay(events, 10);
  const confirm = cert.decisions.find((d) => d.action === 'CONFIRM');
  assert.equal(confirm.status, 'CONFLICT_ALREADY_CANCELLED');
  assert.equal(confirm.accepted, false);
  assert.equal(cert.finalState.available, 10);
});

test('rejected freeze makes a later confirm invalid', () => {
  const events = [
    { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 8, action: 'FREEZE' },
    { requestId: 'r2', idempotencyKey: 'k2', ts: 2, amount: 8, action: 'FREEZE' },
    { requestId: 'r2', idempotencyKey: 'k3', ts: 3, amount: 8, action: 'CONFIRM' },
  ];
  const cert = replay(events, 10);
  const confirm = cert.decisions.find((d) => d.idempotencyKey === 'k3');
  assert.equal(confirm.status, 'CONFIRM_WITHOUT_FREEZE');
  assert.equal(cert.finalState.consumed, 0);
  assert.equal(cert.finalState.reserved, 8);
});

test('replaying the same history always yields the same hash', () => {
  const events = quota10Events();
  const a = replay(events, 10);
  const b = replay(events.slice().reverse(), 10);
  const shuffled = replay([events[3], events[0], events[5], events[1], events[4], events[2]], 10);
  assert.equal(a.stateHash, b.stateHash);
  assert.equal(a.stateHash, shuffled.stateHash);
  assert.match(a.stateHash, /^[0-9a-f]{64}$/);
});

test('canonicalOrder sorts by logical timestamp then requestId', () => {
  const ordered = canonicalOrder([
    { requestId: 'b', idempotencyKey: 'k2', ts: 1, amount: 1, action: 'FREEZE' },
    { requestId: 'a', idempotencyKey: 'k1', ts: 1, amount: 1, action: 'FREEZE' },
    { requestId: 'a', idempotencyKey: 'k3', ts: 0, amount: 1, action: 'FREEZE' },
  ]);
  assert.deepEqual(
    ordered.map((e) => e.idempotencyKey),
    ['k3', 'k1', 'k2']
  );
});

// --- CLI --------------------------------------------------------------------

// Drives the real CLI entry in-process, capturing streams and the exit code.
async function execCli(args) {
  const out = [];
  const err = [];
  const io = {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  };
  const status = await runCli(args, io);
  return { status, stdout: out.join(''), stderr: err.join('') };
}

test('cli prints a certificate with acceptedOrder and stateHash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'history.json');
  writeFileSync(file, JSON.stringify({ quota: 10, events: quota10Events() }));

  const res = await execCli([file]);
  assert.equal(res.status, 0, res.stderr);
  const cert = JSON.parse(res.stdout);
  assert.ok(Array.isArray(cert.acceptedOrder));
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(cert.finalState.available, 1);

  // Same certificate regardless of arrival order in the file.
  const file2 = join(dir, 'history-reversed.json');
  writeFileSync(file2, JSON.stringify({ quota: 10, events: quota10Events().reverse() }));
  const res2 = await execCli([file2]);
  assert.equal(JSON.parse(res2.stdout).stateHash, cert.stateHash);
});

test('cli supports --quota override and bare event arrays', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'events.json');
  writeFileSync(file, JSON.stringify(quota10Events()));
  const res = await execCli([file, '--quota', '10']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).quota, 10);
});

test('cli exits 1 with standard error JSON on bad input', async () => {
  const missing = await execCli([join(tmpdir(), 'no-such-file.json')]);
  assert.equal(missing.status, 1);
  const errMissing = JSON.parse(missing.stderr);
  assert.equal(errMissing.error.code, 'READ_ERROR');

  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{not json');
  const resBad = await execCli([badJson]);
  assert.equal(resBad.status, 1);
  assert.equal(JSON.parse(resBad.stderr).error.code, 'INVALID_JSON');

  const badEvent = join(dir, 'bad-event.json');
  writeFileSync(badEvent, JSON.stringify({ quota: 10, events: [{ requestId: 'r1' }] }));
  const resEvent = await execCli([badEvent]);
  assert.equal(resEvent.status, 1);
  assert.equal(JSON.parse(resEvent.stderr).error.code, 'INVALID_EVENT');

  const conflict = join(dir, 'conflict.json');
  writeFileSync(
    conflict,
    JSON.stringify({
      quota: 10,
      events: [
        { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 4, action: 'FREEZE' },
        { requestId: 'r1', idempotencyKey: 'k1', ts: 1, amount: 5, action: 'FREEZE' },
      ],
    })
  );
  const resConflict = await execCli([conflict]);
  assert.equal(resConflict.status, 1);
  assert.equal(JSON.parse(resConflict.stderr).error.code, 'IDEMPOTENCY_CONFLICT');
});
