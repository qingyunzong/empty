'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { mergeEvents, parseNdjson } = require('../src/sync');

const CLI = path.join(__dirname, '..', 'cli.js');

function post(id, amount, node, lamport) {
  return { id, kind: 'post', amount, causes: [], lamport, node };
}
function toNdjson(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

test('4) concurrent same-id different-amount: bidirectional import yields same conflict.json, balance unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-'));
  const a = [post('shared', 100, 'A', 1), post('a-only', 10, 'A', 2)];
  const b = [post('shared', 999, 'B', 1), post('b-only', 20, 'B', 2)];
  const aFile = path.join(dir, 'a.ndjson');
  const bFile = path.join(dir, 'b.ndjson');
  fs.writeFileSync(aFile, toNdjson(a));
  fs.writeFileSync(bFile, toNdjson(b));

  const outAB = path.join(dir, 'out-ab');
  const outBA = path.join(dir, 'out-ba');
  for (const [x, y, out] of [
    [aFile, bFile, outAB],
    [bFile, aFile, outBA],
  ]) {
    const res = spawnSync(process.execPath, [CLI, 'merge', x, y, '--out', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
  }

  const conflictAB = JSON.parse(fs.readFileSync(path.join(outAB, 'conflict.json'), 'utf8'));
  const conflictBA = JSON.parse(fs.readFileSync(path.join(outBA, 'conflict.json'), 'utf8'));
  assert.deepEqual(conflictAB, conflictBA, 'conflict.json must be identical for both import directions');
  assert.equal(conflictAB.length, 1);
  assert.equal(conflictAB[0].id, 'shared');
  assert.deepEqual(conflictAB[0].amounts, [100, 999]);
  assert.equal(conflictAB[0].resolution, 'excluded');

  const stateAB = JSON.parse(fs.readFileSync(path.join(outAB, 'state.json'), 'utf8'));
  const stateBA = JSON.parse(fs.readFileSync(path.join(outBA, 'state.json'), 'utf8'));
  assert.equal(stateAB.balance, 30, 'conflicting post excluded: balance = 10 + 20');
  assert.equal(stateBA.balance, 30, 'balance unchanged regardless of direction');
  assert.deepEqual(stateAB.effective, stateBA.effective);
  assert.equal(stateAB.hash, stateBA.hash, 'merged log hash identical in both directions');

  // library-level agreement
  const r = mergeEvents(parseNdjson(toNdjson(a), 'a'), parseNdjson(toNdjson(b), 'b'));
  assert.equal(r.balance, 30);
  assert.equal(r.conflicts.length, 1);
});
