// Acceptance scenarios from the specification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/ledger.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-accept-'));
}

test('acceptance 1: revoking an all-OPEN tree returns every reserved budget', () => {
  const ledger = Ledger.open(tmpDir());
  ledger.createGroup({ id: 'root', amount: 1000 });
  ledger.createGroup({ id: 'a', parentId: 'root', amount: 400 });
  ledger.createGroup({ id: 'a1', parentId: 'a', amount: 150 });
  ledger.createGroup({ id: 'a2', parentId: 'a', amount: 100 });
  ledger.createGroup({ id: 'b', parentId: 'root', amount: 300 });

  const result = ledger.cancel('root');
  assert.equal(result.status, 'CANCELLED');
  assert.deepEqual(result.blocked, []);
  assert.equal(result.budgetReturned, 400 + 150 + 100 + 300);
  assert.deepEqual([...result.cancelled].sort(), ['a', 'a1', 'a2', 'b', 'root']);

  for (const id of ['root', 'a', 'a1', 'a2', 'b']) {
    const g = ledger.get(id);
    assert.equal(g.state, 'CANCELLED');
    assert.equal(g.reserved, 0, `${id}: all reservations returned`);
    assert.equal(g.spent, 0);
  }
});

test('acceptance 2: mixed OPEN/SETTLED tree -> OPEN cancelled, SETTLED kept, parent PARTIAL', () => {
  const ledger = Ledger.open(tmpDir());
  ledger.createGroup({ id: 'root', amount: 1000 });
  ledger.createGroup({ id: 'a', parentId: 'root', amount: 400 });
  ledger.createGroup({ id: 'a1', parentId: 'a', amount: 150 });
  ledger.createGroup({ id: 'a2', parentId: 'a', amount: 100 });
  ledger.createGroup({ id: 'b', parentId: 'root', amount: 300 });
  ledger.prepare('a1');
  ledger.commit('a1'); // a1 independently SETTLED

  const result = ledger.cancel('root');

  // Not an overall failure: PARTIAL with explicit blocking reasons.
  assert.equal(result.status, 'PARTIAL');
  assert.deepEqual([...result.cancelled].sort(), ['a2', 'b']);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, 'a1');
  assert.match(result.blocked[0].reason, /SETTLED/);
  assert.equal(result.budgetReturned, 100 + 300);

  assert.equal(ledger.get('a1').state, 'SETTLED'); // preserved
  assert.equal(ledger.get('a2').state, 'CANCELLED');
  assert.equal(ledger.get('b').state, 'CANCELLED');
  assert.equal(ledger.get('a').state, 'PARTIAL'); // blocked ancestor
  assert.equal(ledger.get('root').state, 'PARTIAL');

  // Budget: a1's 150 stays spent at a; a2/b reservations returned.
  assert.equal(ledger.get('a').spent, 150);
  assert.equal(ledger.get('a').reserved, 0);
  assert.equal(ledger.get('root').reserved, 400); // PARTIAL "a" keeps its reservation
});

test('acceptance 3: crash after PREPARE recovers without partial budget deduction, recommit succeeds', () => {
  const dir = tmpDir();
  let ledger = Ledger.open(dir);
  ledger.createGroup({ id: 'root', amount: 1000 });
  ledger.createGroup({ id: 'p1', parentId: 'root', amount: 400 });
  ledger.prepare('p1');

  // Crash between WAL PREPARE and WAL COMMIT.
  ledger.beginCommit('p1');
  assert.equal(ledger.get('p1').state, 'SETTLED'); // mutation applied before "crash"
  ledger = null;

  // Restart: recovery must roll the in-doubt transaction back.
  const recovered = Ledger.open(dir);
  assert.equal(recovered.recovered.length, 1);
  assert.equal(recovered.recovered[0].type, 'ROLLBACK');
  assert.equal(recovered.recovered[0].groupId, 'p1');
  assert.equal(recovered.get('p1').state, 'PREPARED'); // uncommitted
  assert.equal(recovered.get('root').reserved, 400); // no partial budget deduction
  assert.equal(recovered.get('root').spent, 0);

  // Recovery is idempotent: reopening must not roll back again.
  const again = Ledger.open(dir);
  assert.equal(again.recovered.length, 0);
  assert.equal(again.get('p1').state, 'PREPARED');

  // Resubmission succeeds.
  const committed = again.commit('p1');
  assert.equal(committed.state, 'SETTLED');
  assert.equal(again.get('root').reserved, 0);
  assert.equal(again.get('root').spent, 400);

  // WAL tells the whole story: PREPARE, ROLLBACK, PREPARE, COMMIT.
  const walTypes = again.store.readWal().map((r) => r.type);
  assert.deepEqual(walTypes, ['PREPARE', 'ROLLBACK', 'PREPARE', 'COMMIT']);
});
