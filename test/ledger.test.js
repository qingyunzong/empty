import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ledger, LedgerError } from '../src/ledger.js';
import { canonical } from '../src/json.js';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function setup() {
  const ledger = new Ledger();
  ledger.applyEvent({ type: 'add_institution', id: 'A' });
  ledger.applyEvent({ type: 'add_institution', id: 'B' });
  return ledger;
}

test('revoke after commit books a reversal keeping the original hash, resubmit restores nets', () => {
  const ledger = setup();
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 });
  assert.deepEqual(ledger.nets, { A: -100, B: 100 });
  ledger.applyEvent({ type: 'commit' });

  ledger.applyEvent({ type: 'revoke', id: 'i1' });
  assert.deepEqual(ledger.nets, { A: 0, B: 0 });

  const expectedHash = sha256(canonical({ id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 }));
  assert.equal(ledger.audit.length, 1);
  assert.equal(ledger.audit[0].kind, 'reversal');
  assert.equal(ledger.audit[0].of, 'i1');
  assert.equal(ledger.audit[0].originalHash, expectedHash);
  assert.equal(ledger.audit[0].amount, -100);

  // Restore with a higher version: nets return to the pre-revoke state.
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 2, from: 'A', to: 'B', amount: 100 });
  assert.deepEqual(ledger.nets, { A: -100, B: 100 });
});

test('revoke of an uncommitted instruction books no reversal', () => {
  const ledger = setup();
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 });
  ledger.applyEvent({ type: 'revoke', id: 'i1' });
  assert.deepEqual(ledger.nets, { A: 0, B: 0 });
  assert.equal(ledger.audit.length, 0);
});

test('duplicate submissions are idempotent by version', () => {
  const ledger = setup();
  const event = { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 };
  ledger.applyEvent(event);
  const netsAfterFirst = ledger.nets;
  ledger.applyEvent(event); // exact duplicate: no-op
  assert.deepEqual(ledger.nets, netsAfterFirst);
  assert.throws(
    () => ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 999 }),
    (err) => err.code === 'VERSION_CONFLICT'
  );
});

test('version conflict on same version with different payload', () => {
  const ledger = setup();
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 });
  assert.throws(
    () => ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 999 }),
    (err) => err instanceof LedgerError && err.code === 'VERSION_CONFLICT'
  );
});

test('stale versions are ignored, higher versions replace', () => {
  const ledger = setup();
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 3, from: 'A', to: 'B', amount: 300 });
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 2, from: 'A', to: 'B', amount: 200 });
  assert.deepEqual(ledger.nets, { A: -300, B: 300 });
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 4, from: 'A', to: 'B', amount: 400 });
  assert.deepEqual(ledger.nets, { A: -400, B: 400 });
});

test('amounts are integer cents; overflow is an error and rolls back', () => {
  const ledger = setup();
  const MAX = Number.MAX_SAFE_INTEGER;
  ledger.applyEvent({ type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: MAX });
  assert.deepEqual(ledger.nets, { A: -MAX, B: MAX });
  const before = ledger.nets;
  const seqBefore = ledger.seq;
  assert.throws(
    () => ledger.applyEvent({ type: 'submit', id: 'i2', version: 1, from: 'A', to: 'B', amount: 1 }),
    (err) => err instanceof LedgerError && err.code === 'OVERFLOW'
  );
  // Failed event must not corrupt state.
  assert.deepEqual(ledger.nets, before);
  assert.equal(ledger.seq, seqBefore);
  assert.deepEqual(ledger.nets, ledger.naiveNets());
  // Ledger keeps working afterwards.
  ledger.applyEvent({ type: 'submit', id: 'i3', version: 1, from: 'B', to: 'A', amount: 5 });
  assert.deepEqual(ledger.nets, ledger.naiveNets());
});

test('non-integer and non-positive amounts are rejected', () => {
  const ledger = setup();
  for (const amount of [1.5, -10, 0, Number.MAX_SAFE_INTEGER + 1, '100']) {
    assert.throws(
      () => ledger.applyEvent({ type: 'submit', id: 'x', version: 1, from: 'A', to: 'B', amount }),
      (err) => err instanceof LedgerError && err.code === 'BAD_AMOUNT'
    );
  }
});

test('dependency cycles between institutions are rejected', () => {
  const ledger = new Ledger();
  for (const id of ['A', 'B', 'C']) ledger.applyEvent({ type: 'add_institution', id });
  ledger.applyEvent({ type: 'depends', from: 'A', to: 'B' });
  ledger.applyEvent({ type: 'depends', from: 'B', to: 'C' });
  assert.throws(
    () => ledger.applyEvent({ type: 'depends', from: 'C', to: 'A' }),
    (err) => err instanceof LedgerError && err.code === 'CYCLE'
  );
  // Edge removal restores the ability to add the reverse edge.
  ledger.applyEvent({ type: 'undepends', from: 'B', to: 'C' });
  ledger.applyEvent({ type: 'depends', from: 'C', to: 'A' });
});

test('incremental state matches deterministic full replay', () => {
  const events = [
    { type: 'add_institution', id: 'A' },
    { type: 'add_institution', id: 'B' },
    { type: 'add_institution', id: 'C' },
    { type: 'submit', id: 'i1', version: 1, from: 'A', to: 'B', amount: 100 },
    { type: 'submit', id: 'i2', version: 1, from: 'B', to: 'C', amount: 40 },
    { type: 'commit' },
    { type: 'revoke', id: 'i1' },
    { type: 'submit', id: 'i3', version: 1, from: 'C', to: 'A', amount: 7 },
    { type: 'submit', id: 'i2', version: 2, from: 'B', to: 'C', amount: 55 },
    { type: 'commit' },
  ];
  const incremental = Ledger.replay(events);
  const fresh = Ledger.replay(events);
  assert.equal(incremental.certTip, fresh.certTip);
  assert.deepEqual(incremental.nets, fresh.nets);
  assert.deepEqual(incremental.nets, incremental.naiveNets());
  // Reversal for revoked committed i1, and for replaced committed i2.
  assert.equal(incremental.audit.length, 2);
  assert.deepEqual(incremental.audit.map((a) => a.of), ['i1', 'i2']);
});
