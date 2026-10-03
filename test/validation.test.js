import test from 'node:test';
import assert from 'node:assert/strict';
import { Database, applyOp } from '../src/db.js';
import { BusinessError, CorruptionError } from '../src/errors.js';
import { certificateFor } from '../src/certificate.js';
import { tmpdir } from './helpers.js';

test('total output weight may not exceed effective parent weight', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 70 }] });
  assert.throws(
    () => db.split({ parents: ['A'], children: [{ id: 'C', weight: 31 }] }),
    /exceeds effective parent weight/,
  );
  db.split({ parents: ['A'], children: [{ id: 'C', weight: 30 }] }); // exact fit ok
  assert.equal(db.get('A').effective, 0);
  db.commit();
  db.close();
});

test('merge split conserves weight across multiple parents', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 60 });
  db.create({ id: 'B', weight: 40 });
  db.split({ parents: ['A', 'B'], children: [{ id: 'M', weight: 100 }] });
  assert.equal(db.get('A').consumed + db.get('B').consumed, 100);
  assert.throws(
    () => db.split({ parents: ['A', 'B'], children: [{ id: 'X', weight: 1 }] }),
    BusinessError,
  );
  db.commit();
  db.close();
});

test('child ids must be new; duplicate and unknown parents rejected', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 100 });
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 10 }] });
  assert.throws(
    () => db.split({ parents: ['A'], children: [{ id: 'B', weight: 1 }] }),
    /already exists/,
  );
  assert.throws(
    () => db.split({ parents: ['ghost'], children: [{ id: 'C', weight: 1 }] }),
    /unknown parent/,
  );
  db.abort();
  db.close();
});

test('cyclic ancestry is rejected by the split guard and detected in certificates', () => {
  // Hand-built cyclic state: certificate computation must refuse it.
  const state = {
    batches: new Map([
      ['A', { id: 'A', weight: 1, consumed: 0, status: 'pending', parents: ['B'], children: ['B'] }],
      ['B', { id: 'B', weight: 1, consumed: 0, status: 'pending', parents: ['A'], children: ['A'] }],
    ]),
  };
  assert.throws(() => certificateFor(state, 'A'), CorruptionError);

  // The split-time guard: child that is an ancestor of the parent.
  const clean = {
    batches: new Map([
      ['A', { id: 'A', weight: 10, consumed: 0, status: 'pending', parents: [], children: ['B'] }],
      ['B', { id: 'B', weight: 5, consumed: 0, status: 'pending', parents: ['A'], children: [] }],
    ]),
  };
  assert.throws(
    () => applyOp(clean, { type: 'split', parents: ['B'], children: [{ id: 'A', weight: 1 }] }),
    BusinessError,
  );
});

test('invalid status and unknown batch are business errors', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 10 });
  assert.throws(() => db.setStatus({ id: 'A', status: 'bogus' }), /invalid status/);
  assert.throws(() => db.setStatus({ id: 'ghost', status: 'passed' }), /unknown batch/);
  assert.throws(() => db.create({ id: 'A', weight: 1 }), /already exists/);
  assert.throws(() => db.create({ id: 'Z', weight: -3 }), BusinessError);
  db.abort();
  db.close();
});

test('a failed op leaves the transaction state untouched', () => {
  const db = Database.open(tmpdir());
  db.begin();
  db.create({ id: 'A', weight: 10 });
  assert.throws(() => db.split({ parents: ['A'], children: [{ id: 'B', weight: 99 }] }));
  assert.equal(db.get('A').effective, 10);
  assert.deepEqual(db.children('A'), []);
  db.split({ parents: ['A'], children: [{ id: 'B', weight: 5 }] });
  db.commit();
  assert.deepEqual(db.children('A'), ['B']);
  db.close();
});
