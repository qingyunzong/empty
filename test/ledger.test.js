import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from '../cli.js';
import { Ledger, LedgerError } from '../src/ledger.js';

function run(args) {
  const lines = [];
  const code = runCli(args, (line) => lines.push(line));
  return { code, lines, json: () => JSON.parse(lines[0]) };
}

function fork(ledger, replica) {
  const copy = Ledger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())));
  copy.replica = replica;
  return copy;
}

test('causal correction chain resolves to the latest version', () => {
  const ledger = new Ledger('A');
  ledger.put('V1', 100, 'open');
  ledger.correct('V1', 150, 'open');
  const third = ledger.correct('V1', 200, 'closed');

  const view = ledger.get('V1');
  assert.equal(view.version, 3);
  assert.equal(view.amount, 200);
  assert.equal(view.status, 'closed');
  assert.equal(view.conflict, false);
  assert.deepEqual(view.heads, [third.hash]);

  const cert = ledger.certificate();
  assert.equal(cert.status, 'valid');
  assert.equal(cert.conflicts, 0);
  assert.equal(cert.missing, 0);
  assert.deepEqual(cert.frontier.V1, [third.hash]);
});

test('concurrent corrections of the same voucher conflict and invalidate the certificate', () => {
  const a = new Ledger('A');
  a.put('V1', 100, 'open');
  const b = fork(a, 'B');

  a.correct('V1', 200, 'open');
  b.correct('V1', 300, 'closed');
  a.merge(b);

  const view = a.get('V1');
  assert.equal(view.conflict, true);
  assert.equal(view.heads.length, 2);

  const cert = a.certificate();
  assert.equal(cert.conflicts, 1);
  assert.equal(cert.status, 'invalid');
});

test('corrections on distinct vouchers merge cleanly', () => {
  const a = new Ledger('A');
  a.put('V1', 100, 'open');
  a.put('V2', 50, 'open');
  const b = fork(a, 'B');

  a.correct('V1', 200, 'open');
  b.correct('V2', 75, 'closed');
  a.merge(b);

  assert.equal(a.get('V1').amount, 200);
  assert.equal(a.get('V2').amount, 75);
  assert.equal(a.certificate().status, 'valid');
});

test('unknown predecessor and stale clock are rejected', () => {
  const ledger = new Ledger('A');
  const first = ledger.put('V1', 100, 'open');
  ledger.correct('V1', 200, 'open');

  assert.throws(() => ledger.correct('V1', 300, 'open', 'deadbeef'), (err) => {
    assert.equal(err.code, 'unknown-predecessor');
    return true;
  });
  assert.throws(() => ledger.correct('V1', 300, 'open', first.hash), (err) => {
    assert.equal(err.code, 'stale-clock');
    return true;
  });
  assert.throws(() => ledger.correct('V9', 1, 'open'), (err) => {
    assert.equal(err.code, 'unknown-predecessor');
    return true;
  });
});

test('missing dependencies invalidate the certificate', () => {
  const a = new Ledger('A');
  a.put('V1', 100, 'open');
  const b = fork(a, 'B');
  b.correct('V1', 200, 'open');

  const orphan = new Ledger('C');
  orphan.merge(new Ledger('X', [...b.events.values()].filter((e) => e.version === 2)));

  const cert = orphan.certificate();
  assert.equal(cert.missing, 1);
  assert.equal(cert.status, 'invalid');
});

test('partial order of two replicas and three events matches a reference algorithm', () => {
  const a = new Ledger('A');
  const e1 = a.put('V1', 100, 'open');
  const b = fork(a, 'B');
  const e2 = a.correct('V1', 200, 'open');
  const e3 = b.correct('V1', 300, 'closed');
  a.merge(b);

  const events = [e1, e2, e3];
  const byHash = new Map(events.map((e) => [e.hash, e]));

  // Independent reference: DFS over the predecessor adjacency built from scratch.
  function refAncestors(hash) {
    const seen = new Set();
    const stack = [hash];
    while (stack.length > 0) {
      const pred = byHash.get(stack.pop())?.predecessor;
      if (pred && byHash.has(pred) && !seen.has(pred)) {
        seen.add(pred);
        stack.push(pred);
      }
    }
    return seen;
  }

  // Enumerate every ordered pair of the partial order and compare reachability.
  for (const x of events) {
    assert.deepEqual([...a.ancestors(x.hash)].sort(), [...refAncestors(x.hash)].sort());
    for (const y of events) {
      assert.equal(a.ancestors(y.hash).has(x.hash), refAncestors(y.hash).has(x.hash));
    }
  }
  assert.ok(a.ancestors(e2.hash).has(e1.hash));
  assert.ok(a.ancestors(e3.hash).has(e1.hash));
  assert.ok(!a.ancestors(e2.hash).has(e3.hash));
  assert.ok(!a.ancestors(e3.hash).has(e2.hash));

  // Reference frontier: events never referenced as a predecessor.
  const referenced = new Set(events.map((e) => e.predecessor).filter(Boolean));
  const refHeads = events
    .filter((e) => !referenced.has(e.hash))
    .map((e) => e.hash)
    .sort();
  assert.deepEqual(a.heads('V1'), refHeads);

  // Reference conflict: multiple heads whose amount or status diverge.
  const headEvents = refHeads.map((h) => byHash.get(h));
  let refConflict = false;
  for (let i = 0; i < headEvents.length; i++) {
    for (let j = i + 1; j < headEvents.length; j++) {
      if (headEvents[i].amount !== headEvents[j].amount || headEvents[i].status !== headEvents[j].status) {
        refConflict = true;
      }
    }
  }
  assert.equal(a.conflicts().has('V1'), refHeads.length > 1 && refConflict);
  assert.equal(a.certificate().status, 'invalid');
});

test('CLI: put/correct/get/audit round-trip and JSON error codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const state = join(dir, 'state.json');
  const cli = (args) => run(['--state', state, ...args]);

  const put = cli(['put', 'V1', '100', 'open']);
  assert.equal(put.code, 0);
  const first = put.json();
  assert.equal(first.version, 1);

  const corrected = cli(['correct', 'V1', '250', 'closed']);
  assert.equal(corrected.code, 0);
  assert.equal(corrected.json().version, 2);

  const got = cli(['get', 'V1']);
  assert.equal(got.json().amount, 250);

  const audit = cli(['audit']);
  assert.equal(audit.json().status, 'valid');

  const unknown = cli(['correct', 'V1', '1', 'open', '--predecessor', 'deadbeef']);
  assert.equal(unknown.code, 1);
  assert.deepEqual(unknown.json(), { error: 'unknown-predecessor' });

  const stale = cli(['correct', 'V1', '1', 'open', '--predecessor', first.hash]);
  assert.equal(stale.code, 1);
  assert.deepEqual(stale.json(), { error: 'stale-clock' });
});

test('CLI: merge of a conflicting replica yields an invalid audit certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const stateA = join(dir, 'a.json');
  const stateB = join(dir, 'b.json');
  const cli = (state, args) => run(['--state', state, ...args]);

  cli(stateA, ['--replica', 'A', 'put', 'V1', '100', 'open']);
  copyFileSync(stateA, stateB);

  cli(stateA, ['--replica', 'A', 'correct', 'V1', '200', 'open']);
  cli(stateB, ['--replica', 'B', 'correct', 'V1', '300', 'closed']);

  const merged = cli(stateA, ['merge', stateB]);
  assert.equal(merged.code, 0);

  const view = cli(stateA, ['get', 'V1']).json();
  assert.equal(view.conflict, true);

  const cert = cli(stateA, ['audit']).json();
  assert.equal(cert.status, 'invalid');
  assert.equal(cert.conflicts, 1);
});
