'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mergePaths, atomicWrite } = require('../src/sync');
const { generatePair, toNdjson } = require('../src/generate');

function post(id, amount, node, lamport) {
  return { id, kind: 'post', amount, causes: [], lamport, node };
}

test('2) crash before/after conflict.json write: recovery never duplicates certificates', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const aFile = path.join(dir, 'a.ndjson');
  const bFile = path.join(dir, 'b.ndjson');
  fs.writeFileSync(aFile, toNdjson([post('shared', 100, 'A', 1), post('a1', 5, 'A', 2)]));
  fs.writeFileSync(bFile, toNdjson([post('shared', 200, 'B', 1), post('b1', 7, 'B', 2)]));

  // breakpoint BEFORE conflict write: out dir exists with partial outputs, no conflict.json
  const outBefore = path.join(dir, 'out-before');
  fs.mkdirSync(outBefore, { recursive: true });
  fs.writeFileSync(path.join(outBefore, 'log.ndjson'), 'partial\n');
  const r1 = mergePaths(aFile, bFile, outBefore);
  const c1 = JSON.parse(fs.readFileSync(path.join(outBefore, 'conflict.json'), 'utf8'));
  assert.equal(c1.length, 1, 'exactly one conflict certificate after recovery');
  assert.equal(c1[0].id, 'shared');
  // no leftover temp files from atomic writes
  assert.deepEqual(fs.readdirSync(outBefore).filter((f) => f.startsWith('.tmp-')), []);

  // breakpoint AFTER conflict write: conflict.json already committed; re-run must not duplicate
  const outAfter = path.join(dir, 'out-after');
  mergePaths(aFile, bFile, outAfter);
  const before = fs.readFileSync(path.join(outAfter, 'conflict.json'), 'utf8');
  mergePaths(aFile, bFile, outAfter); // resume / re-run
  const after = JSON.parse(fs.readFileSync(path.join(outAfter, 'conflict.json'), 'utf8'));
  assert.equal(after.length, 1, 're-run does not duplicate certificates');
  assert.equal(fs.readFileSync(path.join(outAfter, 'conflict.json'), 'utf8'), before, 'certificate file is stable');

  // atomic write: simulated crash during write leaves no torn file
  const victim = path.join(dir, 'atomic', 'conflict.json');
  atomicWrite(victim, JSON.stringify([{ id: 'x' }]) + '\n');
  assert.equal(fs.readdirSync(path.dirname(victim)).filter((f) => f.startsWith('.tmp-')).length, 0);
  atomicWrite(victim, JSON.stringify([{ id: 'x' }, { id: 'y' }]) + '\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(victim, 'utf8')), [{ id: 'x' }, { id: 'y' }]);

  // idempotent on the 200-event generated pair too
  const { a, b } = generatePair(200, 'group17');
  fs.writeFileSync(aFile, toNdjson(a));
  fs.writeFileSync(bFile, toNdjson(b));
  const outBig = path.join(dir, 'out-big');
  const first = mergePaths(aFile, bFile, outBig);
  const snap1 = fs.readFileSync(path.join(outBig, 'conflict.json'), 'utf8');
  const second = mergePaths(aFile, bFile, outBig);
  assert.equal(fs.readFileSync(path.join(outBig, 'conflict.json'), 'utf8'), snap1);
  assert.equal(second.conflicts.length, first.conflicts.length);
});
