import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planner } from '../src/planner.js';
import { tokenize } from '../src/tokenize.js';

// Acceptance 4: after deleting a change note, the compressed index must not
// return false positives.
test('deleting a change note removes it from compressed postings', () => {
  const p = new Planner();
  const c1 = p.applyChange('换模后延迟 2 小时', {
    type: 'add',
    task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 2 },
  });
  const c2 = p.applyChange('换模后延迟已缓解', {
    type: 'add',
    task: { id: 'b', resources: ['R2'], start: 10, end: 15, due: 15, budget: 2 },
  });
  assert.deepEqual(p.query('换模 后 延迟'), [c1, c2]);

  p.applyChange(null, { type: 'deleteNote', changeId: c1 });

  // query layer: no hit for the deleted note
  assert.deepEqual(p.query('换模 后 延迟'), [c2]);
  // compressed posting layer: decoded postings contain no stale doc id
  for (const term of tokenize('换模后延迟')) {
    const posting = p.index.postingFor(term);
    assert.ok(!posting.has(c1), `term ${term} still references deleted doc`);
    assert.ok(posting.has(c2));
  }
  // delete the remaining note -> term disappears entirely, zero false positives
  p.applyChange(null, { type: 'deleteNote', changeId: c2 });
  assert.deepEqual(p.query('换模 后 延迟'), []);
  assert.equal(p.index.postingFor('换').size, 0);
});

test('undo of deleteNote restores the note and its postings', () => {
  const p = new Planner();
  const c1 = p.applyChange('换模后延迟', {
    type: 'add',
    task: { id: 'a', resources: ['R1'], start: 0, end: 5, due: 5, budget: 2 },
  });
  p.applyChange(null, { type: 'deleteNote', changeId: c1 });
  assert.deepEqual(p.query('换模 后 延迟'), []);
  p.undo();
  assert.deepEqual(p.query('换模 后 延迟'), [c1]);
});
