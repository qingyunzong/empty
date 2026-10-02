import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { run } from '../bin/cli.js';
const DAY = 86_400_000;
const BASE = Date.parse('2026-10-01T00:00:00Z');
const iso = (offsetDays) => new Date(BASE + offsetDays * DAY).toISOString().slice(0, 10);

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'batch-alloc-'));
  const statePath = join(dir, 'state.json');
  const state = {
    batches: [
      { id: 'B1', material: 'M', quantity: 3, expiry: iso(10), quality: 'ok', location: 'A' },
      { id: 'B2', material: 'M', quantity: 4, expiry: iso(5), quality: 'ok', location: 'B' },
      { id: 'B3', material: 'M', quantity: 2, expiry: iso(20), quality: 'ok', location: 'A' },
    ],
    orders: [],
    allocations: [],
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const orderPath = join(dir, 'order.json');
  writeFileSync(
    orderPath,
    JSON.stringify({ id: 'O1', material: 'M', quantity: 5, location: 'A', transferCostPerUnit: 7, date: iso(0) }),
  );
  return { dir, statePath, orderPath };
}

// The sandbox forbids child processes, so the CLI is driven in-process via
// run(), which returns the same exit code the bin wrapper assigns to
// process.exitCode (verified manually: 0/2/3/4 in a real shell).
function runCli(args) {
  const io = {
    stdout: { buf: '', write(s) { this.buf += s; } },
    stderr: { buf: '', write(s) { this.buf += s; } },
  };
  const status = run(args, io);
  return { status, stdout: io.stdout.buf, stderr: io.stderr.buf };
}

describe('acceptance 3: injected write failure keeps state.json intact and retry succeeds', () => {
  it('exit 3 on --fail-before-rename, hash unchanged, retry commits full result', () => {
    const { dir, statePath, orderPath } = fixture();
    const before = sha256(statePath);

    const failed = runCli(['allocate', '--state', statePath, '--order-file', orderPath, '--fail-before-rename']);
    assert.equal(failed.status, 3, `stderr: ${failed.stderr}`);
    assert.match(failed.stderr, /commit failed/);
    assert.equal(sha256(statePath), before, 'state.json hash must be unchanged');
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.tmp-')),
      [],
      'no temp files left behind',
    );
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(persisted.orders.length, 0, 'no partial order recorded');
    assert.equal(persisted.allocations.length, 0, 'no partial allocation recorded');
    assert.deepEqual(persisted.batches.map((b) => b.quantity), [3, 4, 2]);

    const retried = runCli(['allocate', '--state', statePath, '--order-file', orderPath]);
    assert.equal(retried.status, 0, `stderr: ${retried.stderr}`);
    const receipt = JSON.parse(retried.stdout);
    assert.equal(receipt.status, 'allocated');
    assert.equal(receipt.orderId, 'O1');
    assert.equal(receipt.allocation.reduce((s, l) => s + l.quantity, 0), 5);

    assert.notEqual(sha256(statePath), before, 'state.json must change after successful retry');
    const committed = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(committed.orders.length, 1);
    assert.equal(committed.allocations.length, 1);
    const deducted = new Map(receipt.allocation.map((l) => [l.batchId, l.quantity]));
    for (const batch of committed.batches) {
      const original = 3 + (batch.id === 'B2' ? 1 : 0) - (batch.id === 'B3' ? 1 : 0); // B1:3 B2:4 B3:2
      assert.equal(batch.quantity, original - (deducted.get(batch.id) ?? 0));
    }
    const totalRemaining = committed.batches.reduce((s, b) => s + b.quantity, 0);
    assert.equal(totalRemaining, 9 - 5);
  });

  it('budget exhaustion reports unknown (exit 4) and leaves state untouched', () => {
    const { statePath, orderPath } = fixture();
    const before = sha256(statePath);
    const run = runCli(['allocate', '--state', statePath, '--order-file', orderPath, '--budget', '1']);
    assert.equal(run.status, 4, `stdout: ${run.stdout}`);
    assert.equal(JSON.parse(run.stdout).status, 'unknown');
    assert.equal(sha256(statePath), before);
  });

  it('infeasible order exits 2 with order/batch conflicts and no state change', () => {
    const { statePath } = fixture();
    const before = sha256(statePath);
    const order = JSON.stringify({ id: 'O2', material: 'M', quantity: 50, location: 'A', transferCostPerUnit: 7, date: iso(0) });
    const run = runCli(['allocate', '--state', statePath, '--order', order]);
    assert.equal(run.status, 2);
    const report = JSON.parse(run.stdout);
    assert.equal(report.status, 'infeasible');
    assert.equal(report.orderId, 'O2');
    assert.ok(report.conflicts.some((c) => c.reason === 'insufficient-quantity'));
    assert.equal(sha256(statePath), before);
  });
});
