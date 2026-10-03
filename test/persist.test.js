import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvoiceJournal } from '../src/journal.js';

function dir() {
  return mkdtempSync(join(tmpdir(), 'fee-journal-'));
}

test('committed batches survive recovery', () => {
  const d = dir();
  const journal = new InvoiceJournal(d);
  journal.writeBatch([{ account: 'A', fee: '10.00' }, { account: 'B', fee: '5.00' }]);
  const reopened = new InvoiceJournal(d);
  const { kept, dropped } = reopened.recover();
  assert.equal(dropped, 0);
  assert.ok(kept > 0);
  assert.deepEqual(
    reopened.invoices(),
    [{ account: 'A', fee: '10.00' }, { account: 'B', fee: '5.00' }],
  );
});

test('crash mid-batch: restart discards the fragment and never double-bills', () => {
  const d = dir();
  const journal = new InvoiceJournal(d);
  journal.writeBatch([{ account: 'A', fee: '10.00' }]);
  // Simulate a crash while writing the second batch: begin + one line, no commit.
  appendFileSync(
    journal.file,
    `${JSON.stringify({ begin: 'batch-2' })}\n${JSON.stringify({ invoice: { account: 'B', fee: '7.00' } })}\n`,
  );
  // Even a torn JSON line at the very tail.
  appendFileSync(journal.file, '{"invoice":{"account":"C"');

  const reopened = new InvoiceJournal(d);
  const { dropped } = reopened.recover();
  assert.ok(dropped >= 3, `expected fragment records to be dropped, got ${dropped}`);
  assert.deepEqual(reopened.invoices(), [{ account: 'A', fee: '10.00' }]);

  // The retried batch is written exactly once: B appears a single time.
  reopened.writeBatch([{ account: 'B', fee: '7.00' }]);
  const invoices = reopened.invoices();
  assert.equal(invoices.filter((i) => i.account === 'A').length, 1);
  assert.equal(invoices.filter((i) => i.account === 'B').length, 1);

  // Recovery is idempotent once the log is clean.
  const again = new InvoiceJournal(d);
  assert.equal(again.recover().dropped, 0);
  assert.equal(again.invoices().length, 2);
});

test('batch sequence continues across restarts', () => {
  const d = dir();
  const journal = new InvoiceJournal(d);
  const first = journal.writeBatch([{ account: 'A', fee: '1.00' }]);
  const reopened = new InvoiceJournal(d);
  reopened.recover();
  const second = reopened.writeBatch([{ account: 'B', fee: '2.00' }]);
  assert.notEqual(first, second);
  const log = readFileSync(reopened.file, 'utf8');
  assert.ok(log.includes(`{"begin":"${first}"}`));
  assert.ok(log.includes(`{"commit":"${second}"}`));
});
