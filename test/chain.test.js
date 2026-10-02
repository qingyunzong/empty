import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli } from '../testing/helpers.js';
import { refBlockHash, refChain, refMerkleRoot } from '../testing/reference.js';

test('acceptance 1: hash chain and root match brute-force reference over block files', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  runCli(['init', pack, '--members', 'a,b']);
  const n = 12;
  for (let i = 0; i < n; i++) {
    runCli(['add', pack, '--data', JSON.stringify({ i, nested: { v: [i, i * 2] } })]);
  }
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push(JSON.parse(fs.readFileSync(path.join(pack, 'blocks', String(i).padStart(8, '0') + '.json'), 'utf8')));
  }
  const { head, hashes } = refChain(blocks);
  const d = runCli(['digest', pack]);
  assert.equal(d.status, 0);
  assert.equal(d.json.head, head);
  assert.equal(d.json.root, refMerkleRoot(hashes));
  assert.equal(d.json.length, n);
  for (const b of blocks) assert.equal(b.hash, refBlockHash(b));
});

test('add accepts JSONL file input, one block per line', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  runCli(['init', pack]);
  const jsonl = path.join(dir, 'ev.jsonl');
  fs.writeFileSync(jsonl, '{"a":1}\n{"a":2}\n\n{"a":3}\n');
  const r = runCli(['add', pack, '--file', jsonl]);
  assert.equal(r.status, 0);
  assert.equal(r.json.added.length, 3);
  assert.equal(r.json.length, 3);
  const v = runCli(['verify', pack]);
  assert.equal(v.status, 0);
});
