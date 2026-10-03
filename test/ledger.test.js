import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { Ledger, LedgerError } from '../src/ledger.js';
import { main as cliMain } from '../src/cli.js';

const SEP = '\0';

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LedgerError, `expected LedgerError, got ${err}`);
    return err.code;
  }
  return null;
}

test('acceptance 1: freeze then pay succeeds; overdraw gives E_INSUFFICIENT; boundary available == 0', () => {
  const ledger = new Ledger();
  ledger.createAccount({ account: 'A', total: 100 });

  // Freeze 60 -> available 40.
  ledger.run((tx) => tx.freeze({ account: 'A', amount: 60, dueDate: '2026-01-10', holdId: 'h1' }));
  assert.equal(ledger.account('A').available, 40);

  // Pay settles the hold: total credit is actually deducted, hold released.
  ledger.run((tx) => tx.pay({ holdId: 'h1', payId: 'p1' }));
  const acct = ledger.account('A');
  assert.equal(acct.used, 60);
  assert.equal(acct.available, 40);
  assert.equal(ledger.hold('h1').status, 'SETTLED');

  // Freeze exactly the remaining available -> boundary: available hits exactly 0.
  ledger.run((tx) => tx.freeze({ account: 'A', amount: 40, dueDate: '2026-02-01', holdId: 'h2' }));
  assert.equal(ledger.account('A').available, 0);

  // Any further freeze overdraws -> E_INSUFFICIENT.
  assert.equal(
    codeOf(() => ledger.run((tx) => tx.freeze({ account: 'A', amount: 1, dueDate: '2026-03-01' }))),
    'E_INSUFFICIENT',
  );

  // Over-payment attempt in one shot (amount > available) -> E_INSUFFICIENT.
  const ledger2 = new Ledger();
  ledger2.createAccount({ account: 'B', total: 50 });
  assert.equal(
    codeOf(() => ledger2.run((tx) => tx.freeze({ account: 'B', amount: 51, dueDate: '2026-01-01' }))),
    'E_INSUFFICIENT',
  );
  // Exact-amount freeze succeeds (boundary inclusive).
  ledger2.run((tx) => tx.freeze({ account: 'B', amount: 50, dueDate: '2026-01-01', holdId: 'hb' }));
  assert.equal(ledger2.account('B').available, 0);
});

test('acceptance 2: concurrent release vs pay — enumerate commit orders, only first committer wins', () => {
  const outcomes = [];
  for (const order of [
    ['release', 'pay'],
    ['pay', 'release'],
  ]) {
    const ledger = new Ledger();
    ledger.createAccount({ account: 'A', total: 100 });
    ledger.run((tx) => tx.freeze({ account: 'A', amount: 30, dueDate: '2026-01-01', holdId: 'h1' }));

    // Both transactions start from the same snapshot.
    const txRelease = ledger.begin();
    txRelease.release({ holdId: 'h1' });
    const txPay = ledger.begin();
    txPay.pay({ holdId: 'h1', payId: 'p1' });

    const txs = { release: txRelease, pay: txPay };
    const first = txs[order[0]];
    const second = txs[order[1]];

    first.commit(); // first committer takes effect
    assert.equal(codeOf(() => second.commit()), 'E_CONFLICT'); // loser conflicts

    // The loser is retried against the post-commit state and judged there.
    const retryCode = codeOf(() =>
      ledger.run((tx) => (order[1] === 'pay' ? tx.pay({ holdId: 'h1' }) : tx.release({ holdId: 'h1' }))),
    );
    assert.equal(retryCode, 'E_HOLD_NOT_ACTIVE');

    const finalStatus = ledger.hold('h1').status;
    if (order[0] === 'release') {
      assert.equal(finalStatus, 'RELEASED');
      assert.equal(ledger.account('A').available, 100); // hold released, nothing settled
      assert.equal(ledger.account('A').used, 0);
    } else {
      assert.equal(finalStatus, 'SETTLED');
      assert.equal(ledger.account('A').available, 70); // payment settled
      assert.equal(ledger.account('A').used, 30);
      assert.equal(ledger.payment('p1').status, 'SETTLED');
    }
    outcomes.push({ order, finalStatus });
  }
  // Both orders enumerated, exactly one winner each time.
  assert.deepEqual(
    outcomes.map((o) => o.finalStatus),
    ['RELEASED', 'SETTLED'],
  );
});

test('acceptance 3: index queries match full-scan reference exactly; no stale state after cancel', () => {
  const ledger = new Ledger();
  ledger.createAccount({ account: 'A', total: 1000 });
  ledger.createAccount({ account: 'B', total: 500 });

  const seeds = [
    ['h1', 'A', 100, '2026-01-05'],
    ['h2', 'A', 100, '2026-02-10'],
    ['h3', 'A', 100, '2026-03-15'],
    ['h4', 'B', 50, '2026-01-20'],
    ['h5', 'B', 50, '2026-04-01'],
  ];
  for (const [holdId, account, amount, dueDate] of seeds) {
    ledger.run((tx) => tx.freeze({ account, amount, dueDate, holdId }));
  }
  ledger.run((tx) => tx.pay({ holdId: 'h2', payId: 'p1' })); // A/h2 -> SETTLED
  ledger.run((tx) => tx.release({ holdId: 'h4' })); // B/h4 -> RELEASED

  const filters = [
    { account: 'A' },
    { account: 'B' },
    { status: 'ACTIVE' },
    { status: 'SETTLED' },
    { status: 'RELEASED' },
    { dueBefore: '2026-03-01' },
    { account: 'A', status: 'ACTIVE' },
    { account: 'A', status: 'SETTLED' },
    { account: 'B', status: 'RELEASED' },
    { status: 'ACTIVE', dueBefore: '2026-02-01' },
    { status: 'ACTIVE', dueBefore: '2026-12-31' },
    { account: 'A', status: 'ACTIVE', dueBefore: '2026-02-01' },
    {},
  ];
  for (const filter of filters) {
    assert.deepEqual(
      ledger.query(filter),
      ledger.scanHolds(filter),
      `index query must equal full-scan for ${JSON.stringify(filter)}`,
    );
  }

  // Index internals contain exactly the live holds, nothing stale.
  const indexIds = new Set();
  for (const [, bucket] of ledger._indexes().idxAccountStatus) for (const id of bucket) indexIds.add(id);
  for (const [, bucket] of ledger._indexes().idxDueStatus) for (const id of bucket) indexIds.add(id);
  assert.deepEqual([...indexIds].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);

  // Cancel the payment -> refund; cancel remaining holds. Old states must not linger.
  ledger.run((tx) => tx.cancelPay({ payId: 'p1', refundId: 'r1' }));
  assert.equal(ledger.payment('p1').status, 'REFUNDED');
  assert.equal(ledger.account('A').used, 0); // refund restored the total
  assert.equal(ledger.hold('h2').status, 'SETTLED'); // hold stays settled after refund
  ledger.run((tx) => tx.release({ holdId: 'h1' }));
  ledger.run((tx) => tx.release({ holdId: 'h3' }));
  ledger.run((tx) => tx.release({ holdId: 'h5' }));

  // No hold remains ACTIVE anywhere: index must not return stale entries.
  assert.deepEqual(ledger.query({ status: 'ACTIVE' }), []);
  assert.deepEqual(ledger.query({ account: 'A', status: 'ACTIVE' }), []);
  assert.deepEqual(ledger.query({ status: 'ACTIVE', dueBefore: '2027-01-01' }), []);
  // SETTLED bucket only holds h2; RELEASED holds the rest.
  assert.deepEqual(ledger.query({ status: 'SETTLED' }).map((h) => h.id), ['h2']);
  assert.deepEqual(ledger.query({ status: 'RELEASED' }).map((h) => h.id), ['h1', 'h3', 'h4', 'h5']);
  // Re-verify every filter against the reference scan after the cancellations.
  for (const filter of filters) {
    assert.deepEqual(ledger.query(filter), ledger.scanHolds(filter));
  }
  // Index buckets are fully consistent with a rebuild from live state.
  const expected = new Map();
  for (const h of ledger.scanHolds()) {
    for (const left of [`a:${h.account}`, `d:${h.dueDate}`]) {
      const key = `${left}${SEP}${h.status}`;
      if (!expected.has(key)) expected.set(key, []);
      expected.get(key).push(h.id);
    }
  }
  const actual = new Map();
  const [acctIdx, dueIdx] = [ledger._indexes().idxAccountStatus, ledger._indexes().idxDueStatus];
  for (const [key, bucket] of acctIdx) {
    const [left, status] = key.split(SEP);
    actual.set(`a:${left}${SEP}${status}`, bucket);
  }
  for (const [key, bucket] of dueIdx) {
    const [left, status] = key.split(SEP);
    actual.set(`d:${left}${SEP}${status}`, bucket);
  }
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [key, ids] of expected) {
    assert.deepEqual([...actual.get(key)].sort(), [...ids].sort(), `stale index bucket ${key}`);
  }
});

test('acceptance 4: unknown account returns E_NO_ACCOUNT', () => {
  const ledger = new Ledger();
  assert.equal(
    codeOf(() => ledger.run((tx) => tx.freeze({ account: 'NOPE', amount: 1, dueDate: '2026-01-01' }))),
    'E_NO_ACCOUNT',
  );
  assert.equal(codeOf(() => ledger.account('NOPE')), 'E_NO_ACCOUNT');
  assert.equal(codeOf(() => ledger.query({ account: 'NOPE' })), 'E_NO_ACCOUNT');
  // Hold on a missing account cannot exist, so pay/release surface E_NO_HOLD.
  assert.equal(codeOf(() => ledger.run((tx) => tx.pay({ holdId: 'ghost' }))), 'E_NO_HOLD');
  assert.equal(codeOf(() => ledger.run((tx) => tx.release({ holdId: 'ghost' }))), 'E_NO_HOLD');
});

test('transaction isolation: snapshot reads and failed commits leave no trace', () => {
  const ledger = new Ledger();
  ledger.createAccount({ account: 'A', total: 100 });
  ledger.run((tx) => tx.freeze({ account: 'A', amount: 10, dueDate: '2026-01-01', holdId: 'h1' }));

  // A transaction that throws mid-way rolls back: no hold, no index entry.
  assert.equal(
    codeOf(() =>
      ledger.run((tx) => {
        tx.freeze({ account: 'A', amount: 20, dueDate: '2026-02-01', holdId: 'h2' });
        tx.freeze({ account: 'A', amount: 500, dueDate: '2026-03-01' }); // exceeds -> throws
      }),
    ),
    'E_INSUFFICIENT',
  );
  assert.equal(codeOf(() => ledger.hold('h2')), 'E_NO_HOLD');
  assert.deepEqual(ledger.query({ account: 'A', status: 'ACTIVE' }).map((h) => h.id), ['h1']);
  assert.equal(ledger.account('A').available, 90);

  // Snapshot reads: a concurrent commit is invisible to an open transaction,
  // but the stale transaction is rejected at commit time.
  const tx = ledger.begin();
  ledger.run((t) => t.release({ holdId: 'h1' }));
  assert.equal(codeOf(() => tx.release({ holdId: 'h1' })), null); // prepared from snapshot
  assert.equal(codeOf(() => tx.commit()), 'E_CONFLICT'); // commit detects the change
});

test('CLI: JSON commands end-to-end including query flags and error codes', () => {
  const batch = JSON.stringify([
    { cmd: 'createAccount', account: 'A', total: 200 },
    { cmd: 'freeze', account: 'A', amount: 80, dueDate: '2026-05-01', holdId: 'h1' },
    { cmd: 'freeze', account: 'A', amount: 20, dueDate: '2026-06-01', holdId: 'h2' },
    { cmd: 'pay', holdId: 'h1', payId: 'p1' },
    { cmd: 'cancelPay', payId: 'p1', refundId: 'r1' },
    { cmd: 'query', account: 'A', status: 'ACTIVE', 'due-before': '2026-07-01' },
    { cmd: 'freeze', account: 'GHOST', amount: 1, dueDate: '2026-01-01' },
  ]);
  const lines = [];
  const exitCode = cliMain([batch], { stdout: (line) => lines.push(JSON.parse(line)) });
  assert.equal(exitCode, 1); // last command fails
  assert.equal(lines.length, 7);
  assert.ok(lines.slice(0, 6).every((l) => l.ok));
  assert.deepEqual(
    lines[5].result.map((h) => h.id),
    ['h2'],
  );
  assert.equal(lines[6].ok, false);
  assert.equal(lines[6].error.code, 'E_NO_ACCOUNT');

  // --state persists across invocations.
  const stateFile = new URL('./cli-state.tmp.json', import.meta.url).pathname;
  try {
    assert.equal(cliMain(['--state', stateFile, '{"cmd":"createAccount","account":"S","total":10}'], { stdout: () => {} }), 0);
    const out = [];
    assert.equal(
      cliMain(['--state', stateFile, '{"cmd":"freeze","account":"S","amount":4,"dueDate":"2026-01-01","holdId":"hs"}'], { stdout: (l) => out.push(JSON.parse(l)) }),
      0,
    );
    assert.equal(out[0].ok, true);
  } finally {
    rmSync(stateFile, { force: true });
  }
});
