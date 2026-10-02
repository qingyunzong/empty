import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Repo } from '../src/repo.js';
import { tmpdir } from '../testutil/util.mjs';

// Acceptance 3: a crash after the parent-pointer (version object) write must
// not lose acknowledged batches; recovery re-links branch heads on open.
test('acknowledged batches survive a crash and a plain reopen', () => {
  const dir = tmpdir();
  const repo = new Repo(dir);
  const r1 = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'a', value: 1 }] },
    { branch: 'main' }
  );
  const r2 = repo.commitBatch(
    { processId: 'p1', clock: 2, deps: [r1.batchId], ops: [{ op: 'assert', key: 'b', value: 2 }] },
    { branch: 'main' }
  );
  // process "crashes" here: no clean shutdown, just reopen the directory
  const reopened = new Repo(dir);
  assert.equal(reopened.heads.get('main'), r2.versionId);
  assert.deepEqual(reopened.viewRows('main'), { a: 1, b: 2 });
  assert.ok(reopened.batches.has(r1.batchId));
  assert.ok(reopened.batches.has(r2.batchId));
});

test('crash after parent-pointer write but before head update: recovery keeps the batch', () => {
  const dir = tmpdir();
  const repo = new Repo(dir);
  const r1 = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'a', value: 1 }] },
    { branch: 'main' }
  );
  const r2 = repo.commitBatch(
    { processId: 'p1', clock: 2, deps: [r1.batchId], ops: [{ op: 'assert', key: 'b', value: 2 }] },
    { branch: 'main' }
  );
  // simulate a crash that happened after r2's version object (parent pointer)
  // was durable but before the head pointer was updated: rewind the head file
  fs.writeFileSync(path.join(dir, 'heads', 'main'), r1.versionId + '\n');

  const recovered = new Repo(dir);
  assert.deepEqual(recovered.recovered, [{ branch: 'main', head: r2.versionId }]);
  assert.equal(recovered.heads.get('main'), r2.versionId);
  assert.deepEqual(recovered.viewRows('main'), { a: 1, b: 2 });
  // and the acknowledged earlier batch is intact as well
  assert.deepEqual(recovered.viewRows('main'), { a: 1, b: 2 });
  assert.ok(recovered.batches.has(r1.batchId));
});

test('corrupt or missing head pointer is rebuilt from the version graph', () => {
  const dir = tmpdir();
  const repo = new Repo(dir);
  const r1 = repo.commitBatch(
    { processId: 'p1', clock: 1, deps: [], ops: [{ op: 'assert', key: 'a', value: 1 }] },
    { branch: 'main' }
  );
  fs.rmSync(path.join(dir, 'heads', 'main'));
  const recovered = new Repo(dir);
  assert.equal(recovered.heads.get('main'), r1.versionId);
  assert.deepEqual(recovered.viewRows('main'), { a: 1 });

  fs.writeFileSync(path.join(dir, 'heads', 'main'), 'garbage-not-a-version\n');
  const recovered2 = new Repo(dir);
  assert.equal(recovered2.heads.get('main'), r1.versionId);
});
