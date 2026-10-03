import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'budget-cli-'));
  return { dir, db: join(dir, 'budget.json') };
}

function run(db, args) {
  return runCli([...args, '--db', db], {});
}

test('cli: settle/cancel/available round trip with JSON output', () => {
  const { dir, db } = makeDb();
  try {
    let r = run(db, ['setbudget', '--category', 'food', '--cap', '100']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, command: 'setbudget', category: 'food', cap: 100 });

    r = run(db, ['settle', '--category', 'food', '--amount', '60']);
    assert.equal(r.status, 0, r.stderr);
    const settled = JSON.parse(r.stdout);
    assert.equal(settled.ok, true);
    assert.equal(settled.status, 'settled');
    assert.ok(settled.id);

    r = run(db, ['available', 'food']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), {
      ok: true, command: 'available', category: 'food', cap: 100, used: 60, available: 40,
    });

    r = run(db, ['cancel', '--id', settled.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'cancelled');

    r = run(db, ['available', 'food']);
    assert.equal(JSON.parse(r.stdout).available, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: exceeding the budget exits non-zero with E_BUDGET JSON', () => {
  const { dir, db } = makeDb();
  try {
    assert.equal(run(db, ['setbudget', '--category', 'food', '--cap', '100']).status, 0);
    assert.equal(run(db, ['settle', '--category', 'food', '--amount', '50']).status, 0);
    assert.equal(run(db, ['settle', '--category', 'food', '--amount', '50']).status, 0);

    const r = run(db, ['settle', '--category', 'food', '--amount', '1']);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).error.code, 'E_BUDGET');

    const avail = JSON.parse(run(db, ['available', 'food']).stdout);
    assert.equal(avail.available, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cli: error cases produce JSON on stderr and non-zero exit', () => {
  const { dir, db } = makeDb();
  try {
    let r = run(db, ['settle', '--category', 'ghost', '--amount', '10']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_NO_BUDGET');

    r = run(db, ['cancel', '--id', '999']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_NOT_FOUND');

    r = run(db, ['setbudget', '--category', 'food', '--cap', 'abc']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_INVALID');

    r = run(db, ['settle', '--category', 'food', '--amount', '0']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_INVALID');

    r = run(db, ['bogus-command']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_USAGE');

    r = run(db, ['settle', '--category', 'food']);
    assert.notEqual(r.status, 0);
    assert.equal(JSON.parse(r.stderr).error.code, 'E_INVALID');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
