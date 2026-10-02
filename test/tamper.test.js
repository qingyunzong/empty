import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, runCli, makePack } from '../testing/helpers.js';

function blockPath(pack, i) {
  return path.join(pack, 'blocks', String(i).padStart(8, '0') + '.json');
}

test('acceptance 2: flipping 1 byte is located by verify with exit 2 + stderr JSON', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 6);
  const file = blockPath(pack, 2);
  const raw = fs.readFileSync(file, 'utf8');
  // flip one hex char inside the stored "hash" field (JSON stays parseable)
  const m = raw.match(/"hash": "([0-9a-f]+)"/);
  assert.ok(m, 'hash field found');
  const pos = m.index + m[0].indexOf(m[1][0]);
  const flipped = raw.slice(0, pos) + (raw[pos] === 'a' ? 'b' : 'a') + raw.slice(pos + 1);
  fs.writeFileSync(file, flipped);

  const r = runCli(['verify', pack]);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
  assert.equal(r.errJson.ok, false);
  assert.equal(r.errJson.error.code, 'TAMPER_DETECTED');
  assert.equal(r.errJson.error.index, 2);
});

test('tampered block data is detected at the right index', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 5);
  const file = blockPath(pack, 3);
  const block = JSON.parse(fs.readFileSync(file, 'utf8'));
  block.data.tag = 'forged';
  fs.writeFileSync(file, JSON.stringify(block, null, 2));
  const r = runCli(['verify', pack]);
  assert.equal(r.status, 2);
  assert.equal(r.errJson.error.code, 'TAMPER_DETECTED');
  assert.equal(r.errJson.error.index, 3);
});

test('missing block exits 3 with MISSING_BLOCK and index', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 5);
  fs.rmSync(blockPath(pack, 1));
  const r = runCli(['verify', pack]);
  assert.equal(r.status, 3);
  assert.equal(r.errJson.error.code, 'MISSING_BLOCK');
  assert.equal(r.errJson.error.index, 1);
});

test('invalid inclusion proof exits 4 with INVALID_PROOF', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 7);
  const proofFile = path.join(dir, 'proof.json');
  const p = runCli(['prove', pack, '--index', '4', '--out', proofFile]);
  assert.equal(p.status, 0);
  const doc = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  doc.proof[0].hash = doc.proof[0].hash.replace(/^../, 'ff'); // corrupt sibling
  fs.writeFileSync(proofFile, JSON.stringify(doc));
  const r = runCli(['verify', pack, '--proof', proofFile]);
  assert.equal(r.status, 4);
  assert.equal(r.errJson.error.code, 'INVALID_PROOF');
});

test('valid inclusion proof verifies with exit 0', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 9);
  const proofFile = path.join(dir, 'proof.json');
  runCli(['prove', pack, '--index', '5', '--out', proofFile]);
  const r = runCli(['verify', pack, '--proof', proofFile]);
  assert.equal(r.status, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.index, 5);
});

test('proof for index out of range is rejected', () => {
  const dir = tmpdir();
  const pack = path.join(dir, 'p');
  makePack(pack, 3);
  const r = runCli(['prove', pack, '--index', '3']);
  assert.notEqual(r.status, 0);
});
