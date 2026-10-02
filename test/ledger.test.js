import test from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ledger, clockLE, hashEvent } from '../src/ledger.js';

// ---------- Acceptance 1: settle propagates A->B, B adjusts, merge back ----------
test('acceptance 1: settle A->B, B adjusts, balances and hash chain correct', () => {
  const A = new Ledger('A');
  const settle = A.append({ type: 'settle', paymentId: 'p1', amount: 100 });

  const B = new Ledger('B');
  B.merge([settle]);
  const adjust = B.append({ type: 'adjust', paymentId: 'p1', amount: 150 });

  // hash chain: B's adjustment points at A's settlement
  assert.deepEqual(adjust.prev, [settle.hash]);
  assert.equal(adjust.clock.A, 1);
  assert.equal(adjust.clock.B, 1);

  A.merge([adjust]);

  assert.deepEqual(A.computeState().balances, { p1: 150 });
  assert.deepEqual(B.computeState().balances, { p1: 150 });

  // every prev reference resolves (hash chain intact)
  for (const e of A.events.values()) {
    for (const p of e.prev) assert.ok(A.events.has(p), `missing prev ${p}`);
  }

  const certA = A.certificate();
  const certB = B.certificate();
  assert.deepEqual(certA, certB);
  assert.deepEqual(certA.frontier, [adjust.hash]);
  assert.deepEqual(certA.balances, { p1: 150 });
  assert.match(certA.entriesHash, /^[0-9a-f]{64}$/);
});

// ---------- Acceptance 2: concurrent conflicting adjustments ----------
test('acceptance 2: concurrent different amounts -> conflict, no certificate', () => {
  const A = new Ledger('A');
  const base = A.append({ type: 'settle', paymentId: 'p1', amount: 100 });

  const B = new Ledger('B');
  B.merge([base]);

  const a1 = A.append({ type: 'adjust', paymentId: 'p1', amount: 120 });
  const b1 = B.append({ type: 'adjust', paymentId: 'p1', amount: 200 });

  A.merge([b1]);
  B.merge([a1]);

  for (const ledger of [A, B]) {
    const state = ledger.computeState();
    assert.deepEqual(state.balances, {});
    const conflict = state.conflicts.p1;
    assert.ok(conflict, 'conflict must be recorded, not silently resolved');
    assert.deepEqual(
      conflict.map((c) => c.amount).sort((x, y) => x - y),
      [120, 200],
    );
    assert.throws(() => ledger.certificate(), (e) => e.code === 'conflict');
  }
});

// ---------- Acceptance 3: unknown-predecessor and stale-clock ----------
test('acceptance 3: missing predecessor -> unknown-predecessor', () => {
  const A = new Ledger('A');
  A.append({ type: 'settle', paymentId: 'p1', amount: 100 });
  const e2 = A.append({ type: 'adjust', paymentId: 'p1', amount: 110 });

  const B = new Ledger('B');
  assert.throws(() => B.merge([e2]), (e) => e.code === 'unknown-predecessor');
  // failed merge is atomic: B stays empty
  assert.equal(B.events.size, 0);
});

test('acceptance 3: regressed vector clock -> stale-clock', () => {
  const A = new Ledger('A');
  const e1 = A.append({ type: 'settle', paymentId: 'p1', amount: 100 });
  const e2 = A.append({ type: 'adjust', paymentId: 'p1', amount: 110 });

  const B = new Ledger('B');
  B.merge([e1, e2]); // B clock is now {A: 2}

  // a forged/late event whose clock ({A:1}) is already covered by B's clock
  const stale = { type: 'adjust', paymentId: 'p1', amount: 999, clock: { A: 1 }, prev: [e1.hash] };
  stale.hash = hashEvent(stale);
  assert.throws(() => B.merge([stale]), (e) => e.code === 'stale-clock');
  assert.equal(B.events.size, 2);
});

// ---------- Exhaustive partial orders of 3 messages across 2 replicas ----------

// All strict partial orders on n labelled elements, as Sets of "i,j" (i before j).
function allPartialOrders(n) {
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) pairs.push([i, j]);
  const results = [];
  for (let mask = 0; mask < 1 << pairs.length; mask++) {
    const rel = new Set();
    for (let k = 0; k < pairs.length; k++) {
      if (mask & (1 << k)) rel.add(pairs[k][0] + ',' + pairs[k][1]);
    }
    const reach = Array.from({ length: n }, () => new Array(n).fill(false));
    for (const key of rel) {
      const [a, b] = key.split(',').map(Number);
      reach[a][b] = true;
    }
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) if (reach[i][k] && reach[k][j]) reach[i][j] = true;
    let ok = true;
    for (let i = 0; i < n && ok; i++) if (reach[i][i]) ok = false; // acyclic
    for (let i = 0; i < n && ok; i++)
      for (let j = 0; j < n && ok; j++) if (reach[i][j] && !rel.has(i + ',' + j)) ok = false; // transitive
    if (ok) results.push(rel);
  }
  return results;
}

function topologicalOrders(poset, n) {
  const before = (i, j) => poset.has(i + ',' + j);
  const orders = [];
  const perm = (prefix, rest) => {
    if (rest.length === 0) {
      orders.push(prefix);
      return;
    }
    for (const x of rest) {
      if (rest.every((y) => y === x || !before(y, x))) {
        perm([...prefix, x], rest.filter((y) => y !== x));
      }
    }
  };
  perm([], [...Array(n).keys()]);
  return orders;
}

// Independent reference: derives causality, conflict and balance straight
// from the partial order, never touching vector clocks or the ledger.
function referenceFromPoset(poset, amounts, n) {
  const before = (i, j) => poset.has(i + ',' + j);
  let conflict = false;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (!before(i, j) && !before(j, i) && amounts[i] !== amounts[j]) conflict = true;
  let balance = null;
  if (!conflict) {
    const maximal = [...Array(n).keys()].filter((i) => ![...Array(n).keys()].some((j) => before(i, j)));
    balance = amounts[maximal[0]];
  }
  return { conflict, balance };
}

test('exhaustive: every partial order of 3 messages over 2 replicas', () => {
  const n = 3;
  const posets = allPartialOrders(n);
  assert.equal(posets.length, 19, 'there are 19 partial orders on 3 labelled elements');
  const replicaIds = ['A', 'B'];
  let scenarios = 0;

  for (const poset of posets) {
    const before = (i, j) => poset.has(i + ',' + j);
    for (let mask = 0; mask < 1 << n; mask++) {
      const authors = [...Array(n).keys()].map((i) => replicaIds[(mask >> i) & 1]);
      // a replica's own messages are always causally ordered
      let valid = true;
      for (let i = 0; i < n && valid; i++)
        for (let j = i + 1; j < n && valid; j++)
          if (authors[i] === authors[j] && !before(i, j) && !before(j, i)) valid = false;
      if (!valid) continue;

      for (const amounts of [
        [100, 100, 100],
        [100, 200, 300],
      ]) {
        scenarios++;
        // vector clock of message i = per-replica size of its causal history (incl. self)
        const clocks = [...Array(n).keys()].map((i) => {
          const hist = [i, ...[...Array(n).keys()].filter((k) => before(k, i))];
          const clock = {};
          for (const h of hist) clock[authors[h]] = (clock[authors[h]] ?? 0) + 1;
          return clock;
        });
        // prev = cover relations (maximal strict ancestors)
        const covers = (i) =>
          [...Array(n).keys()].filter(
            (j) =>
              before(j, i) &&
              ![...Array(n).keys()].some((k) => k !== i && k !== j && before(j, k) && before(k, i)),
          );
        const orders = topologicalOrders(poset, n);
        const byIndex = new Array(n);
        for (const i of orders[0]) {
          const e = {
            type: i === 0 ? 'settle' : 'adjust',
            paymentId: 'p',
            amount: amounts[i],
            clock: clocks[i],
            prev: covers(i).map((j) => byIndex[j].hash).sort(),
          };
          e.hash = hashEvent(e);
          byIndex[i] = e;
        }

        const ref = referenceFromPoset(poset, amounts, n);
        const entryHashes = new Set();

        // deliver the 3 events to a fresh replica in every topological order
        for (const order of orders) {
          const ledger = new Ledger('T');
          for (const i of order) ledger.merge([byIndex[i]]);
          assert.equal(ledger.events.size, n);

          // causality from vector clocks must match the partial order exactly
          for (let i = 0; i < n; i++)
            for (let j = 0; j < n; j++) {
              if (i === j) continue;
              assert.equal(
                clockLE(byIndex[i].clock, byIndex[j].clock),
                before(i, j),
                `causality mismatch for ${i}->${j}`,
              );
            }

          const state = ledger.computeState();
          if (ref.conflict) {
            assert.ok(state.conflicts.p, 'expected conflict');
            assert.deepEqual(state.balances, {});
            assert.throws(() => ledger.certificate(), (e) => e.code === 'conflict');
          } else {
            assert.deepEqual(state.conflicts, {});
            assert.equal(state.balances.p, ref.balance);
            const cert = ledger.certificate();
            assert.equal(cert.balances.p, ref.balance);
            entryHashes.add(cert.entriesHash);
          }
        }
        // certificate content is delivery-order independent
        assert.ok(entryHashes.size <= 1);
      }
    }
  }
  assert.ok(scenarios > 0);
});

// ---------- CLI integration ----------
const cliPath = new URL('../src/cli.js', import.meta.url).pathname;

// Note: nested node processes lose piped stdout in this sandbox, so the
// child's stdout/stderr are captured via file descriptors instead.
function runCli(args, dir) {
  const outFile = join(dir, 'stdout.txt');
  const errFile = join(dir, 'stderr.txt');
  const outFd = openSync(outFile, 'w');
  const errFd = openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [cliPath, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status: r.status,
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
  };
}

test('cli: append/dump/merge/cert happy path and error codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const dbA = join(dir, 'a.json');
  const dbB = join(dir, 'b.json');

  let r = runCli(['append', '--db', dbA, '--replica', 'A', '--type', 'settle', '--payment', 'p1', '--amount', '100'], dir);
  assert.equal(r.status, 0, r.stderr);
  const settle = JSON.parse(r.stdout);

  r = runCli(['dump', '--db', dbA], dir);
  assert.equal(r.status, 0, r.stderr);
  const dumpA = JSON.parse(r.stdout);
  assert.deepEqual(dumpA.balances, { p1: 100 });
  writeFileSync(join(dir, 'events.json'), r.stdout);

  r = runCli(['merge', '--db', dbB, '--replica', 'B', '--file', join(dir, 'events.json')], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).merged, 1);

  r = runCli(['append', '--db', dbB, '--type', 'adjust', '--payment', 'p1', '--amount', '150'], dir);
  assert.equal(r.status, 0, r.stderr);
  const adjust = JSON.parse(r.stdout);
  assert.deepEqual(adjust.prev, [settle.hash]);

  r = runCli(['dump', '--db', dbB], dir);
  writeFileSync(join(dir, 'events2.json'), r.stdout);
  r = runCli(['merge', '--db', dbA, '--file', join(dir, 'events2.json')], dir);
  assert.equal(r.status, 0, r.stderr);

  r = runCli(['cert', '--db', dbA], dir);
  assert.equal(r.status, 0, r.stderr);
  const cert = JSON.parse(r.stdout);
  assert.deepEqual(cert.balances, { p1: 150 });
  assert.deepEqual(cert.frontier, [adjust.hash]);

  // concurrent conflict via CLI: cert fails with {"error":"conflict"} and exit 1
  const dbC = join(dir, 'c.json');
  const dbD = join(dir, 'd.json');
  runCli(['merge', '--db', dbC, '--replica', 'C', '--file', join(dir, 'events2.json')], dir);
  runCli(['merge', '--db', dbD, '--replica', 'D', '--file', join(dir, 'events2.json')], dir);
  runCli(['append', '--db', dbC, '--type', 'adjust', '--payment', 'p1', '--amount', '111'], dir);
  runCli(['append', '--db', dbD, '--type', 'adjust', '--payment', 'p1', '--amount', '222'], dir);
  writeFileSync(join(dir, 'c.json.dump'), runCli(['dump', '--db', dbC], dir).stdout);
  writeFileSync(join(dir, 'd.json.dump'), runCli(['dump', '--db', dbD], dir).stdout);
  runCli(['merge', '--db', dbC, '--file', join(dir, 'd.json.dump')], dir);
  runCli(['merge', '--db', dbD, '--file', join(dir, 'c.json.dump')], dir);
  r = runCli(['cert', '--db', dbC], dir);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'conflict' });
  assert.equal(r.stdout, '');

  // unknown-predecessor via CLI
  const e1 = JSON.parse(readFileSync(dbA, 'utf8')).events;
  const skipped = e1[e1.length - 1]; // event whose parent may be missing
  const orphanDb = join(dir, 'orphan.json');
  writeFileSync(join(dir, 'orphan-events.json'), JSON.stringify([skipped]));
  const fresh = new Ledger('Z');
  const child = fresh.append({ type: 'settle', paymentId: 'q', amount: 1 });
  const grand = fresh.append({ type: 'adjust', paymentId: 'q', amount: 2 });
  writeFileSync(join(dir, 'orphan-events.json'), JSON.stringify([grand]));
  r = runCli(['merge', '--db', orphanDb, '--replica', 'Z', '--file', join(dir, 'orphan-events.json')], dir);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stderr), { error: 'unknown-predecessor' });
  assert.ok(child.hash !== grand.hash);
});
