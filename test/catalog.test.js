import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, CatalogError } from '../src/catalog.js';

const LIMITS = { coords: 4, mags: 3, creds: 2, capacity: 3 };

function makeCatalog() {
  return new Catalog(LIMITS);
}

test('add_obs narrows star domains incrementally', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 1, mag: 0, cred: 0 });
  assert.deepEqual([...cat.starDomains.get('A').coord], [1]);
  const out = cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'A', night: 1, coord: 1, mag: 0, cred: 0 });
  assert.equal(out.ok, true);
  assert.deepEqual([...cat.starDomains.get('A').coord], [1]);
});

test('retract_obs widens domains again (star-local, no full recompute)', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 1, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'A', night: 1, coord: 2, mag: 0, cred: 0 });
  assert.deepEqual([...cat.starDomains.get('A').coord], []);
  cat.applyEvent({ type: 'retract_obs', id: 'o2' });
  assert.deepEqual([...cat.starDomains.get('A').coord], [1]);
  cat.applyEvent({ type: 'retract_obs', id: 'o1' });
  assert.equal(cat.starDomains.has('A'), false);
});

test('correct_obs moves attribution and recomputes only the touched stars', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'B', night: 0, coord: 2, mag: 1, cred: 1 });
  const out = cat.applyEvent({ type: 'correct_obs', id: 'o2', star: 'A' });
  assert.equal(cat.starDomains.has('B'), false, 'empty star B is removed');
  assert.deepEqual([...cat.starDomains.get('A').coord], [], 'A now hosts disagreeing observations');
  const changed = out.effects.changes.map((c) => c.star);
  assert.ok(changed.includes('A'));
  assert.ok(!changed.includes('C'), 'untouched stars are not recomputed');
  assert.equal(out.effects.conflicts[0].constraint, 'attribution_consistency');
});

test('correct_obs of a value re-derives the domain instead of intersecting blindly', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 1, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'correct_obs', id: 'o1', coord: 3 });
  assert.deepEqual([...cat.starDomains.get('A').coord], [3]);
});

test('retract and correct of unknown ids are rejected', () => {
  const cat = makeCatalog();
  assert.throws(() => cat.applyEvent({ type: 'retract_obs', id: 'nope' }), /unknown observation id/);
  assert.throws(() => cat.applyEvent({ type: 'correct_obs', id: 'nope', coord: 1 }), /unknown observation id/);
});

test('invalid events raise CatalogError with INVALID_EVENT', () => {
  const cat = makeCatalog();
  assert.throws(() => cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 99, mag: 0, cred: 0 }),
    (e) => e instanceof CatalogError && e.code === 'INVALID_EVENT');
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  assert.throws(() => cat.applyEvent({ type: 'correct_obs', id: 'o1' }), /at least one/);
  assert.throws(() => cat.applyEvent({ type: 'bogus' }), (e) => e.code === 'UNKNOWN_TYPE');
  assert.throws(() => cat.applyEvent(42), (e) => e.code === 'INVALID_EVENT');
});

test('duplicate id add is kept and flagged as a unique_pk conflict', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  const out = cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'B', night: 1, coord: 1, mag: 1, cred: 1 });
  assert.equal(out.effects.conflicts[0].constraint, 'unique_pk');
  assert.equal(cat.activeObs().length, 2);
  // LIFO retract removes the newest incarnation.
  cat.applyEvent({ type: 'retract_obs', id: 'o1' });
  assert.equal(cat.activeObs().length, 1);
  assert.equal(cat.activeObs()[0].star, 'A');
});

test('checkpoint stack: undo_to restores the innermost checkpoint only', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'checkpoint', name: 'cp1' });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'B', night: 1, coord: 1, mag: 1, cred: 1 });
  cat.applyEvent({ type: 'checkpoint', name: 'cp2' });
  cat.applyEvent({ type: 'add_obs', id: 'o3', star: 'C', night: 2, coord: 2, mag: 2, cred: 0 });

  // 越级回滚 is forbidden: cp1 is not the innermost checkpoint.
  assert.throws(() => cat.applyEvent({ type: 'undo_to', name: 'cp1' }),
    (e) => e.code === 'UNDO_SKIP_FORBIDDEN');
  // Unknown checkpoints are rejected; the state stays at the nearest consistent point.
  assert.throws(() => cat.applyEvent({ type: 'undo_to', name: 'nope' }),
    (e) => e.code === 'UNDO_UNKNOWN_CHECKPOINT');
  assert.equal(cat.activeObs().length, 3, 'failed undo leaves the state untouched');

  cat.applyEvent({ type: 'undo_to', name: 'cp2' });
  assert.deepEqual(cat.activeObs().map((o) => o.id).sort(), ['o1', 'o2']);
  cat.applyEvent({ type: 'undo_to', name: 'cp1' });
  assert.deepEqual(cat.activeObs().map((o) => o.id), ['o1']);
  assert.throws(() => cat.applyEvent({ type: 'undo_to', name: 'cp1' }),
    (e) => e.code === 'UNDO_EMPTY');
});

test('undo truncates the effective event log so indices stay replay-consistent', () => {
  const cat = makeCatalog();
  cat.applyEvent({ type: 'add_obs', id: 'o1', star: 'A', night: 0, coord: 0, mag: 0, cred: 0 });
  cat.applyEvent({ type: 'checkpoint', name: 'cp' });
  cat.applyEvent({ type: 'add_obs', id: 'o2', star: 'B', night: 1, coord: 1, mag: 1, cred: 1 });
  cat.applyEvent({ type: 'undo_to', name: 'cp' });
  assert.equal(cat.eventLog.length, 1);
  const out = cat.applyEvent({ type: 'add_obs', id: 'o3', star: 'C', night: 1, coord: 2, mag: 2, cred: 0 });
  assert.equal(out.log_index, 1, 'new events reuse the truncated log position');
});
