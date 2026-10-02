import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeDir, runCli, initLedger, appendTx, readChain } from './helpers.js';

function buildChain(dir, txs) {
  const hashes = [];
  for (const tx of txs) {
    const res = appendTx(dir, tx);
    assert.equal(res.status, 0, res.stderr);
    hashes.push(res.json.hash);
  }
  return hashes;
}

test('rewrite with unknown anchor exits 3', () => {
  const dir = makeDir();
  initLedger(dir);
  buildChain(dir, [
    { id: 't1', amount: 1, account: 'a', payloadHash: 'p1' },
    { id: 't2', amount: 2, account: 'a', payloadHash: 'p2' },
  ]);
  const missing = '0'.repeat(64);
  const res = runCli(['rewrite', '--keep-published', missing], { dir });
  assert.equal(res.status, 3);
  assert.equal(res.errJson.error.code, 'ANCHOR_NOT_FOUND');
});

test('anchored ancestors are rejected with exit 5', () => {
  const dir = makeDir();
  initLedger(dir);
  const [h1, h2] = buildChain(dir, [
    { id: 't1', amount: 1, account: 'a', payloadHash: 'p1' },
    { id: 't2', amount: 2, account: 'a', payloadHash: 'p2' },
  ]);
  const publish = runCli(['rewrite', '--keep-published', h2], { dir });
  assert.equal(publish.status, 0, publish.stderr);

  buildChain(dir, [{ id: 't3', amount: 3, account: 'a', payloadHash: 'p3' }]);

  const backwards = runCli(['rewrite', '--keep-published', h1], { dir });
  assert.equal(backwards.status, 5);
  assert.equal(backwards.errJson.error.code, 'PUBLISHED_VIOLATION');

  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 0);
  assert.equal(verify.json.height, 3);
  assert.equal(verify.json.published, h2);
});

test('rewrite compacts free NORMALs and preserves prefix bytes and totals', () => {
  const dir = makeDir();
  initLedger(dir);
  const [anchor] = buildChain(dir, [
    { id: 'anchor-tx', amount: 1000, account: 'reserve', payloadHash: 'p0' },
  ]);
  buildChain(dir, [
    { id: 'n1', amount: 5, account: 'alice', payloadHash: 'p1' },
    { id: 'n2', amount: -5, account: 'alice', payloadHash: 'p2' },
    { id: 'n3', amount: 3, account: 'bob', payloadHash: 'p3' },
    { id: 'n4', amount: 7, account: 'alice', payloadHash: 'p4' },
  ]);
  const prefixBefore = readChain(dir).slice(0, 1).map((e) => e.hash);
  const before = runCli(['verify'], { dir }).json;

  const res = runCli(['rewrite', '--keep-published', anchor], { dir });
  assert.equal(res.status, 0, res.stderr);
  // alice: +5 -5 +7 = +7 -> minimal kept set is {n4}; bob: +3 -> keep n3
  assert.deepEqual([...res.json.kept].sort(), ['n3', 'n4']);
  assert.deepEqual([...res.json.dropped].sort(), ['n1', 'n2']);

  const after = runCli(['verify'], { dir });
  assert.equal(after.status, 0);
  assert.deepEqual(after.json.accounts, before.accounts);
  assert.equal(after.json.published, anchor);

  const chainAfter = readChain(dir);
  assert.equal(chainAfter[0].hash, prefixBefore[0]);
  assert.equal(chainAfter[1].tx.parent, anchor);
  assert.equal(chainAfter.length, 3);

  const prefixFile = fs.readFileSync(path.join(dir, 'txs', `${anchor}.json`), 'utf8');
  assert.equal(JSON.parse(prefixFile).id, 'anchor-tx');
});

test('rewrite keeps REVERSALs and their targets; unsatisfiable exits 2', () => {
  const dir = makeDir();
  initLedger(dir);
  const [anchor] = buildChain(dir, [
    { id: 'anchor-tx', amount: 1, account: 'reserve', payloadHash: 'p0' },
  ]);
  buildChain(dir, [{ id: 'n1', amount: 100, account: 'alice', payloadHash: 'p1' }]);
  const rev = runCli(['reverse', 'n1'], { dir });
  assert.equal(rev.status, 0);

  const headBefore = runCli(['verify'], { dir }).json.head;
  const res = runCli(['rewrite', '--keep-published', anchor], { dir });
  assert.equal(res.status, 2);
  assert.equal(res.errJson.error.code, 'UNSATISFIABLE');

  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 0);
  assert.equal(verify.json.head, headBefore);
});

test('rewrite drops reversed NORMALs, keeps REVERSALs, preserves totals', () => {
  const dir = makeDir();
  initLedger(dir);
  const [anchor] = buildChain(dir, [
    { id: 'anchor-tx', amount: 1, account: 'reserve', payloadHash: 'p0' },
  ]);
  buildChain(dir, [
    { id: 'n1', amount: -100, account: 'alice', payloadHash: 'p1' },
    { id: 'n2', amount: 100, account: 'alice', payloadHash: 'p2' },
  ]);
  runCli(['reverse', 'n1'], { dir });

  const before = runCli(['verify'], { dir }).json;
  assert.equal(before.accounts.alice, 100);

  const res = runCli(['rewrite', '--keep-published', anchor], { dir });
  assert.equal(res.status, 0, res.stderr);
  // n1 (-100) is reversed -> dropped; REV-n1 (+100) kept as audit;
  // free NORMALs must sum to (-100 + 100) = 0 -> n2 dropped.
  assert.deepEqual(res.json.kept, ['REV-n1']);
  assert.deepEqual([...res.json.dropped].sort(), ['n1', 'n2']);
  const verify = runCli(['verify'], { dir });
  assert.equal(verify.status, 0);
  assert.deepEqual(verify.json.accounts, before.accounts);
});

test('published marker only moves forward; re-publishing same anchor is a no-op', () => {
  const dir = makeDir();
  initLedger(dir);
  const [h1, h2] = buildChain(dir, [
    { id: 't1', amount: 1, account: 'a', payloadHash: 'p1' },
    { id: 't2', amount: 2, account: 'a', payloadHash: 'p2' },
  ]);
  assert.equal(runCli(['rewrite', '--keep-published', h1], { dir }).status, 0);
  assert.equal(runCli(['rewrite', '--keep-published', h2], { dir }).status, 0);
  assert.equal(runCli(['verify'], { dir }).json.published, h2);
  const back = runCli(['rewrite', '--keep-published', h1], { dir });
  assert.equal(back.status, 5);
});
