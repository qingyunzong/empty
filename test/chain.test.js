import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { initPack, openPack, PackError } from '../src/pack.js';
import { rng, randomPayload, refWalkChain, tmpdir } from './helpers.js';

function buildRandomPack(seed, blocks) {
  const dir = tmpdir();
  const rand = rng(seed);
  const pack = initPack(dir, { members: ['alice', 'bob'] });
  const members = ['alice', 'bob'];
  for (let i = 0; i < blocks; i += 1) {
    pack.add(randomPayload(rand), { member: members[Math.floor(rand() * 2)] });
  }
  return { dir, pack };
}

test('random small logs match brute-force chain + Merkle recomputation', () => {
  for (const [seed, blocks] of [[1, 3], [2, 8], [3, 21], [4, 1], [5, 64]]) {
    const { dir, pack } = buildRandomPack(seed, blocks);
    const ref = refWalkChain(dir);
    assert.equal(pack.digest, ref.root, `digest mismatch (seed=${seed})`);
    assert.equal(pack.tip, ref.manifest.tip);
    assert.equal(ref.manifest.count, blocks);
    assert.deepEqual(pack.verify().ok, true);
  }
});

test('flipping 1 byte in any block file is located by verify()', () => {
  const { dir } = buildRandomPack(42, 12);
  for (const target of [0, 5, 11]) {
    // fresh copy per target so each tamper is isolated
    const copy = tmpdir();
    fs.cpSync(dir, copy, { recursive: true });
    const file = path.join(copy, 'blocks', String(target).padStart(6, '0') + '.json');
    const bytes = Buffer.from(fs.readFileSync(file, 'utf8'), 'utf8');
    // flip a byte in the middle of the file (inside payload/hash material)
    const pos = Math.floor(bytes.length / 2);
    bytes[pos] = bytes[pos] === 0x61 ? 0x62 : 0x61;
    fs.writeFileSync(file, bytes);
    try {
      openPack(copy).verify();
      assert.fail(`verify should have rejected tampered block ${target}`);
    } catch (err) {
      assert.ok(err instanceof PackError);
      assert.equal(err.code, 'TAMPER_DETECTED');
      // the first corrupted index must be at or before the tampered block
      assert.ok(err.details.index !== null && err.details.index <= target,
        `reported index ${err.details.index} should locate tamper at ${target}`);
    }
  }
});

test('deleting a block file is reported as MISSING_BLOCK', () => {
  const { dir } = buildRandomPack(43, 6);
  fs.rmSync(path.join(dir, 'blocks', '000003.json'));
  assert.throws(() => openPack(dir).verify(),
    (err) => err.code === 'MISSING_BLOCK' && err.details.index === 3);
});

test('tampering with the manifest digest is detected', () => {
  const { dir } = buildRandomPack(44, 4);
  const manifestPath = path.join(dir, 'pack.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.digest = '0'.repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  assert.throws(() => openPack(dir).verify(), (err) => err.code === 'TAMPER_DETECTED');
});
