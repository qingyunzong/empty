import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, makePack } from '../testing/helpers.js';

test('crash between block write and commit record: no half-committed block', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 3);
  const before = runCli(['digest', pack]).json;

  // simulate crash after block file landed but before commit.json rename:
  // orphan block at index 3, plus an un-renamed commit tmp file
  const orphan = {
    index: 3, epoch: 1, prev: before.head, data: { crashed: true },
    hash: 'f'.repeat(64),
  };
  fs.writeFileSync(path.join(pack, 'blocks', '00000003.json'), JSON.stringify(orphan));
  fs.writeFileSync(path.join(pack, 'commit.json.tmp.999'), '{"length":4');

  const d = runCli(['digest', pack]);
  assert.equal(d.status, 0);
  assert.equal(d.json.length, 3, 'orphan block must not be visible');
  assert.equal(d.json.head, before.head);
  const v = runCli(['verify', pack]);
  assert.equal(v.status, 0, 'pack must verify clean after crash');

  // and the pack keeps working: next add reuses index 3
  const add = runCli(['add', pack, '--data', '{"recovered":true}']);
  assert.equal(add.status, 0);
  assert.equal(add.json.added[0].index, 3);
  assert.equal(runCli(['verify', pack]).status, 0);
});

test('crash during commit tmp write leaves old commit intact', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 2);
  const before = runCli(['digest', pack]).json;
  fs.writeFileSync(path.join(pack, 'commit.json.tmp.12345'), '{"length":3,"he');
  const d = runCli(['digest', pack]);
  assert.equal(d.json.length, before.length);
  assert.equal(d.json.head, before.head);
  assert.equal(runCli(['verify', pack]).status, 0);
});
