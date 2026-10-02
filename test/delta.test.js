'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const { scan, makeDelta, applyDelta, certify } = require('../lib');

const CHUNK = 16;

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'bytedelta-'));
}

async function write(root, rel, data, mode) {
  const abs = path.join(root, ...rel.split('/'));
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, data);
  if (mode !== undefined) await fsp.chmod(abs, mode);
}

async function snapshot(root) {
  const out = new Map();
  async function walk(abs, rel) {
    for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
      // Skip apply-internal bookkeeping; it is cleaned up on success.
      if (!rel && (e.name === '.apply-state.json' || e.name === '.delta-tmp')) continue;
      const cAbs = path.join(abs, e.name);
      const cRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) await walk(cAbs, cRel);
      else {
        out.set(cRel, {
          data: await fsp.readFile(cAbs),
          mode: (await fsp.stat(cAbs)).mode & 0o777,
        });
      }
    }
  }
  await walk(root, '');
  return out;
}

function assertSnapshotsEqual(actual, expected, msg) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort(), `${msg}: file lists differ`);
  for (const [rel, exp] of expected) {
    const act = actual.get(rel);
    assert.ok(act, `${msg}: missing ${rel}`);
    assert.ok(act.data.equals(exp.data), `${msg}: content differs for ${rel}`);
    assert.equal(act.mode, exp.mode, `${msg}: mode differs for ${rel}`);
  }
}

async function buildFixtures(base) {
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await write(src, 'a.txt', 'hello world, this is the original a.txt content!!');
  await write(src, 'sub/b.txt', Buffer.from([...Array(64).keys()]));
  await write(src, 'c.bin', crypto.randomBytes(40));
  await write(src, 'empty.txt', '');
  await write(dst, 'a.txt', 'hello world, this is the MODIFIED a.txt content!!!');
  await write(dst, 'sub/b.txt', Buffer.from([...Array(64).keys()]), 0o755);
  await write(dst, 'sub/deep/d.txt', 'brand new nested file, more than one chunk long');
  await write(dst, 'empty.txt', '');
  return { src, dst };
}

test('1. small tree: add/delete/modify round-trip matches target byte-for-byte', async () => {
  const base = await tmpdir();
  const { src, dst } = await buildFixtures(base);
  const work = path.join(base, 'work');
  await fsp.cp(src, work, { recursive: true });

  const srcM = await scan(src, { chunkSize: CHUNK });
  const dstM = await scan(dst, { chunkSize: CHUNK });
  assert.notEqual(srcM.root, dstM.root);

  const delta = await makeDelta(srcM, dstM, dst);
  assert.deepEqual(delta.delete, ['c.bin']);
  assert.deepEqual(
    delta.plan.map((f) => f.path),
    ['a.txt', 'empty.txt', 'sub/b.txt', 'sub/deep/d.txt']
  );
  assert.equal(delta.targetRoot, dstM.root);

  const result = await applyDelta(delta, work);
  assert.equal(result.applied, true);
  assert.equal(result.deleted, 1);

  assertSnapshotsEqual(await snapshot(work), await snapshot(dst), 'applied tree');

  const proof = await certify(work, delta);
  assert.equal(proof.ok, true);
  assert.equal(proof.targetRoot, dstM.root);
  assert.equal(proof.computedRoot, dstM.root);
  assert.equal(proof.totalFiles, 4);
  const dstSizes = await snapshot(dst);
  let total = 0;
  for (const { data } of dstSizes.values()) total += data.length;
  assert.equal(proof.totalCoveredBytes, total);
});

test('2. duplicate content stored once with correct reference counts', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  const X = Buffer.from('12345678'); // 8 bytes == chunk size
  const Y = Buffer.from('abcdefgh');
  await write(src, 's.bin', Y);
  await write(dst, 's.bin', Y);
  await write(dst, 'm.bin', Buffer.concat([Y, Y, Y]));
  await write(dst, 'n.bin', Buffer.concat([X, X, X, X]));

  const srcM = await scan(src, { chunkSize: 8 });
  const dstM = await scan(dst, { chunkSize: 8 });
  const delta = await makeDelta(srcM, dstM, dst);

  const hashX = crypto.createHash('sha256').update(X).digest('hex');
  const hashY = crypto.createHash('sha256').update(Y).digest('hex');

  // X is new content: stored exactly once as a literal, referenced 4 times.
  assert.equal(delta.blocks.length, 1);
  assert.equal(delta.blocks[0].hash, hashX);
  assert.equal(delta.refCounts[hashX], 4);
  // Y exists in source: never stored as literal, referenced 1 + 3 times.
  assert.equal(delta.refCounts[hashY], 4);
  assert.equal(Object.keys(delta.refCounts).length, 2);
  const mPlan = delta.plan.find((f) => f.path === 'm.bin');
  assert.ok(mPlan.chunks.every((c) => c.from.type === 'keep' && c.from.path === 's.bin'));

  const work = path.join(base, 'work');
  await fsp.cp(src, work, { recursive: true });
  await applyDelta(delta, work);
  assertSnapshotsEqual(await snapshot(work), await snapshot(dst), 'dedup applied tree');
  await certify(work, delta);
});

test('2b. tied best matches break by path byte order, then offset', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  const X = Buffer.from('12345678');
  await write(src, 'b.txt', X); // X at offset 0
  await write(src, 'a.txt', Buffer.concat([Buffer.from('JUNKJUNK'), X])); // X at offset 8
  await write(dst, 'z.txt', X);

  const srcM = await scan(src, { chunkSize: 8 });
  const dstM = await scan(dst, { chunkSize: 8 });
  const delta = await makeDelta(srcM, dstM, dst);

  assert.equal(delta.blocks.length, 0);
  const zPlan = delta.plan.find((f) => f.path === 'z.txt');
  assert.equal(zPlan.chunks.length, 1);
  // 'a.txt' wins on path byte order even though its offset is larger.
  assert.deepEqual(zPlan.chunks[0].from, { type: 'keep', path: 'a.txt', offset: 8 });
});

test('3. interrupted apply leaves target clean and resumes to completion', async () => {
  const base = await tmpdir();
  const { src, dst } = await buildFixtures(base);
  const srcM = await scan(src, { chunkSize: CHUNK });
  const dstM = await scan(dst, { chunkSize: CHUNK });
  const delta = await makeDelta(srcM, dstM, dst);

  // Interrupt during assemble phase: no target file may be touched at all.
  const work1 = path.join(base, 'work1');
  await fsp.cp(src, work1, { recursive: true });
  let assembleCount = 0;
  await assert.rejects(
    applyDelta(delta, work1, {
      hook: (phase) => {
        if (phase === 'assemble' && ++assembleCount === 2) throw new Error('simulated crash');
      },
    }),
    /simulated crash/
  );
  assertSnapshotsEqual(await snapshot(work1), await snapshot(src), 'target untouched after assemble crash');
  // State file exists for resume; re-run completes and cleans up.
  await applyDelta(delta, work1);
  assertSnapshotsEqual(await snapshot(work1), await snapshot(dst), 'resumed tree');
  await assert.rejects(fsp.stat(path.join(work1, '.apply-state.json')));
  await assert.rejects(fsp.stat(path.join(work1, '.delta-tmp')));
  await certify(work1, delta);

  // Interrupt during install phase: not-yet-installed files keep source bytes.
  const work2 = path.join(base, 'work2');
  await fsp.cp(src, work2, { recursive: true });
  let installCount = 0;
  await assert.rejects(
    applyDelta(delta, work2, {
      hook: (phase) => {
        if (phase === 'install' && ++installCount === 2) throw new Error('simulated crash');
      },
    }),
    /simulated crash/
  );
  const after = await snapshot(work2);
  assert.ok(after.get('c.bin'), 'c.bin not deleted yet');
  assert.ok(after.get('sub/deep/d.txt') === undefined, 'd.txt not installed yet');
  assert.ok(after.get('empty.txt').data.equals(Buffer.from('')), 'untouched file keeps source bytes');
  await applyDelta(delta, work2);
  assertSnapshotsEqual(await snapshot(work2), await snapshot(dst), 'resumed tree 2');
  await certify(work2, delta);

  // A state file from a different delta must be rejected.
  const work3 = path.join(base, 'work3');
  await fsp.cp(src, work3, { recursive: true });
  await fsp.writeFile(
    path.join(work3, '.apply-state.json'),
    JSON.stringify({ targetRoot: '0'.repeat(64), assembled: [], installed: [], deleted: false })
  );
  await assert.rejects(applyDelta(delta, work3), (e) => e.code === 'ERR_STATE');
});

test('4. case conflicts and illegal paths are rejected with ERR_PATH', async () => {
  const base = await tmpdir();
  const conflict = path.join(base, 'conflict');
  await write(conflict, 'Foo.txt', 'one');
  await write(conflict, 'foo.txt', 'two');
  await assert.rejects(scan(conflict), (e) => e.code === 'ERR_PATH');

  const ok = path.join(base, 'ok');
  await write(ok, 'a.txt', 'fine');
  const m = await scan(ok, { chunkSize: CHUNK });
  const delta = await makeDelta(m, m, ok);

  for (const bad of ['../evil.txt', '/abs/path.txt', 'a/../../b.txt', 'C:\\\\win.txt', '']) {
    const crafted = structuredClone(delta);
    crafted.plan = [{ path: bad, mode: 0o644, size: 0, chunks: [] }];
    crafted.delete = [];
    await assert.rejects(applyDelta(crafted, ok), (e) => e.code === 'ERR_PATH', `path ${bad}`);
  }

  const craftedDelete = structuredClone(delta);
  craftedDelete.plan = [];
  craftedDelete.delete = ['../escape.txt'];
  await assert.rejects(applyDelta(craftedDelete, ok), (e) => e.code === 'ERR_PATH');

  const craftedKeep = structuredClone(delta);
  craftedKeep.plan = [
    {
      path: 'out.txt',
      mode: 0o644,
      size: 4,
      chunks: [{ offset: 0, len: 4, hash: 'x'.repeat(64), from: { type: 'keep', path: '../secret', offset: 0 } }],
    },
  ];
  craftedKeep.delete = [];
  await assert.rejects(applyDelta(craftedKeep, ok), (e) => e.code === 'ERR_PATH');
});

test('5. empty-to-empty delta has a deterministic root', async () => {
  const base = await tmpdir();
  const src = path.join(base, 'src');
  const dst = path.join(base, 'dst');
  await fsp.mkdir(src);
  await fsp.mkdir(dst);

  const srcM = await scan(src, { chunkSize: CHUNK });
  const dstM = await scan(dst, { chunkSize: CHUNK });
  assert.match(srcM.root, /^[0-9a-f]{64}$/);
  assert.equal(srcM.root, dstM.root);

  const delta1 = await makeDelta(srcM, dstM, dst);
  const delta2 = await makeDelta(srcM, dstM, dst);
  assert.deepEqual(delta1, delta2);
  assert.equal(delta1.targetRoot, dstM.root);
  assert.deepEqual(delta1.plan, []);
  assert.deepEqual(delta1.delete, []);
  assert.deepEqual(delta1.blocks, []);

  const work = path.join(base, 'work');
  await fsp.mkdir(work);
  await applyDelta(delta1, work);
  const proof = await certify(work, delta1);
  assert.equal(prook(proof).ok, true);
  assert.equal(proof.totalCoveredBytes, 0);
  assert.equal(proof.computedRoot, delta1.targetRoot);
});

function prook(p) {
  return p;
}

test('certify reports ERR_GAP for uncovered bytes and ERR_HASH for corruption', async () => {
  const base = await tmpdir();
  const { src, dst } = await buildFixtures(base);
  const srcM = await scan(src, { chunkSize: CHUNK });
  const dstM = await scan(dst, { chunkSize: CHUNK });
  const delta = await makeDelta(srcM, dstM, dst);
  const work = path.join(base, 'work');
  await fsp.cp(src, work, { recursive: true });
  await applyDelta(delta, work);

  // Corrupt one byte -> ERR_HASH.
  const aPath = path.join(work, 'a.txt');
  const buf = await fsp.readFile(aPath);
  buf[3] ^= 0xff;
  await fsp.writeFile(aPath, buf);
  await assert.rejects(certify(work, delta), (e) => e.code === 'ERR_HASH');
  await fsp.cp(path.join(dst, 'a.txt'), aPath);

  // Craft a delta whose plan leaves a gap -> ERR_GAP.
  const gapped = structuredClone(delta);
  const aPlan = gapped.plan.find((f) => f.path === 'a.txt');
  assert.ok(aPlan.chunks.length >= 2);
  aPlan.chunks.splice(1, 1); // remove a middle chunk, leaving bytes uncovered
  await assert.rejects(certify(work, gapped), (e) => e.code === 'ERR_GAP');

  // Extra file in target -> root mismatch -> ERR_HASH.
  await write(work, 'stray.txt', 'not in delta');
  await assert.rejects(certify(work, delta), (e) => e.code === 'ERR_HASH');
});

test('CLI: scan/makedelta/applydelta/certify round-trip and JSON stderr errors', async (t) => {
  try {
    execFileSync(process.execPath, ['-e', '']);
  } catch (e) {
    if (e.code === 'EPERM') return t.skip('child_process spawn not permitted in this environment');
    throw e;
  }
  const base = await tmpdir();
  const { src, dst } = await buildFixtures(base);
  const work = path.join(base, 'work');
  await fsp.cp(src, work, { recursive: true });
  const cli = path.join(__dirname, '..', 'cli.js');

  const srcMFile = path.join(base, 'src.json');
  const dstMFile = path.join(base, 'dst.json');
  const deltaFile = path.join(base, 'delta.json');
  await fsp.writeFile(srcMFile, execFileSync(process.execPath, [cli, 'scan', src, '--chunk-size', String(CHUNK)]));
  await fsp.writeFile(dstMFile, execFileSync(process.execPath, [cli, 'scan', dst, '--chunk-size', String(CHUNK)]));
  await fsp.writeFile(deltaFile, execFileSync(process.execPath, [cli, 'makedelta', srcMFile, dstMFile, dst]));

  execFileSync(process.execPath, [cli, 'applydelta', deltaFile, work]);
  assertSnapshotsEqual(await snapshot(work), await snapshot(dst), 'cli applied tree');

  const out = execFileSync(process.execPath, [cli, 'certify', work, deltaFile]);
  const proof = JSON.parse(out.toString());
  assert.equal(proof.ok, true);
  assert.equal(proof.targetRoot, JSON.parse(await fsp.readFile(dstMFile, 'utf8')).root);

  // Error path: corrupted target -> non-zero exit, JSON on stderr.
  const aPath = path.join(work, 'a.txt');
  const buf = await fsp.readFile(aPath);
  buf[0] ^= 0xff;
  await fsp.writeFile(aPath, buf);
  const res = spawnSync(process.execPath, [cli, 'certify', work, deltaFile], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  const errObj = JSON.parse(res.stderr.trim());
  assert.equal(errObj.error, 'ERR_HASH');
  assert.equal(typeof errObj.message, 'string');
});
