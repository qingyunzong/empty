'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ev = require('../src/evchain.js');
const cli = require('../evc.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evchain-test-'));
}

function writeEvidence(root, rel, content) {
  const file = path.join(root, 'evidence', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeClaims(root, claims) {
  fs.writeFileSync(path.join(root, 'claims.json'), JSON.stringify(claims));
}

function removeEvidence(root, rel) {
  fs.unlinkSync(path.join(root, 'evidence', rel));
}

function copyRepo(src) {
  const dest = tmpdir();
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

function runCli(cwd, args) {
  return cli.run(args, cwd);
}

function buildChain(root) {
  // genesis (v0) + 3 commits (v1..v3) => 4 versions total
  ev.initRepo(root);
  writeEvidence(root, 'a.txt', 'alpha-v1\n');
  writeEvidence(root, 'sub/b.txt', 'beta-v1\n');
  writeClaims(root, [{ id: 'c1', text: 'alpha supports c1', evidence: ['a.txt'] }]);
  const v1 = ev.commit(root, 'v1');

  writeEvidence(root, 'a.txt', 'alpha-v2\n');
  const v2 = ev.commit(root, 'v2: modify a');

  removeEvidence(root, 'sub/b.txt');
  writeEvidence(root, 'c.txt', 'gamma\n');
  writeClaims(root, [
    { id: 'c1', text: 'alpha supports c1', evidence: ['a.txt'] },
    { id: 'c2', text: 'gamma supports c2', evidence: ['c.txt'] },
  ]);
  const v3 = ev.commit(root, 'v3: remove b, add c + claim');
  return { v1, v2, v3 };
}

test('init creates a genesis version and HEAD', () => {
  const root = tmpdir();
  const genesis = ev.initRepo(root);
  assert.equal(ev.readHead(root), genesis);
  const v = ev.loadVersion(root, genesis);
  assert.equal(v.parent, null);
  assert.deepEqual(v.files, {});
  assert.deepEqual(v.claims, []);
});

test('consecutive commits then checkout of an old version rebuilds its exact state', () => {
  const root = tmpdir();
  const { v1, v2, v3 } = buildChain(root);

  // workspace now differs from every committed version
  writeEvidence(root, 'a.txt', 'uncommitted garbage\n');

  const out1 = path.join(root, 'out-v1');
  ev.checkout(root, v1, out1);
  assert.equal(fs.readFileSync(path.join(out1, 'evidence', 'a.txt'), 'utf8'), 'alpha-v1\n');
  assert.equal(fs.readFileSync(path.join(out1, 'evidence', 'sub', 'b.txt'), 'utf8'), 'beta-v1\n');
  assert.ok(!fs.existsSync(path.join(out1, 'evidence', 'c.txt')));
  const manifest1 = JSON.parse(fs.readFileSync(path.join(out1, 'MANIFEST.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest1.files).sort(), ['a.txt', 'sub/b.txt']);

  const out3 = path.join(root, 'out-v3');
  ev.checkout(root, v3, out3);
  assert.equal(fs.readFileSync(path.join(out3, 'evidence', 'a.txt'), 'utf8'), 'alpha-v2\n');
  assert.ok(!fs.existsSync(path.join(out3, 'evidence', 'sub', 'b.txt')));
  assert.equal(fs.readFileSync(path.join(out3, 'evidence', 'c.txt'), 'utf8'), 'gamma\n');
  const claims3 = JSON.parse(fs.readFileSync(path.join(out3, 'claims.json'), 'utf8'));
  assert.deepEqual(claims3.map((c) => c.id).sort(), ['c1', 'c2']);

  // v2 sits between: a modified, b still present, c absent
  const out2 = path.join(root, 'out-v2');
  ev.checkout(root, v2, out2);
  assert.equal(fs.readFileSync(path.join(out2, 'evidence', 'a.txt'), 'utf8'), 'alpha-v2\n');
  assert.equal(fs.readFileSync(path.join(out2, 'evidence', 'sub', 'b.txt'), 'utf8'), 'beta-v1\n');
  assert.ok(!fs.existsSync(path.join(out2, 'evidence', 'c.txt')));
});

test('verify issues a certificate of content hash and parent hash', () => {
  const root = tmpdir();
  const { v1, v2 } = buildChain(root);
  const { certificate } = ev.verify(root, v2);
  assert.equal(certificate.contentHash, v2);
  assert.equal(certificate.parentHash, v1);
  const onDisk = JSON.parse(
    fs.readFileSync(ev.repoPath(root, 'certs', v2 + '.json'), 'utf8')
  );
  assert.equal(onDisk.contentHash, v2);
  assert.equal(onDisk.parentHash, v1);
});

test('tampered evidence blob is detected as HASH_MISMATCH', () => {
  const root = tmpdir();
  const { v3 } = buildChain(root);
  const head = ev.loadVersion(root, v3);
  const blob = ev.repoPath(root, 'objects', head.files['a.txt']);
  fs.appendFileSync(blob, 'tampered\n');
  assert.throws(
    () => ev.verify(root, v3),
    (err) => err instanceof ev.EvchainError && err.code === ev.ERR.HASH_MISMATCH
  );
});

test('missing evidence blob is detected as MISSING_EVIDENCE', () => {
  const root = tmpdir();
  const { v3 } = buildChain(root);
  const head = ev.loadVersion(root, v3);
  fs.unlinkSync(ev.repoPath(root, 'objects', head.files['c.txt']));
  assert.throws(
    () => ev.verify(root, v3),
    (err) => err instanceof ev.EvchainError && err.code === ev.ERR.MISSING_EVIDENCE
  );
});

test('tampered version object is detected as HASH_MISMATCH', () => {
  const root = tmpdir();
  const { v1, v3 } = buildChain(root);
  const v1obj = ev.loadVersion(root, v1);
  v1obj.message = 'forged';
  fs.writeFileSync(ev.repoPath(root, 'versions', v1 + '.json'), ev.canonical(v1obj));
  assert.throws(
    () => ev.verify(root, v3),
    (err) => err instanceof ev.EvchainError && err.code === ev.ERR.HASH_MISMATCH
  );
});

test('commit of a claim referencing deleted evidence fails with DANGLING_CLAIM', () => {
  const root = tmpdir();
  ev.initRepo(root);
  writeEvidence(root, 'a.txt', 'alpha\n');
  writeClaims(root, [{ id: 'c1', text: 'uses a', evidence: ['a.txt'] }]);
  ev.commit(root, 'v1');

  removeEvidence(root, 'a.txt');
  const headBefore = ev.readHead(root);
  assert.throws(
    () => ev.commit(root, 'v2: claim now dangles'),
    (err) => err instanceof ev.EvchainError && err.code === ev.ERR.DANGLING_CLAIM
  );
  assert.equal(ev.readHead(root), headBefore, 'failed commit must not move HEAD');
});

test('checkout of a corrupt version exits 2 and keeps the previous checkout intact', () => {
  const root = tmpdir();
  const { v1, v3 } = buildChain(root);

  const ok = runCli(root, ['checkout', ev.readHead(root)]);
  assert.equal(ok.code, 0, ok.stderr);
  const kept = fs.readFileSync(path.join(root, 'checkout', 'evidence', 'a.txt'), 'utf8');
  const keptManifest = fs.readFileSync(path.join(root, 'checkout', 'MANIFEST.json'), 'utf8');

  // corrupt a blob that v1 needs
  const v1obj = ev.loadVersion(root, v1);
  fs.appendFileSync(ev.repoPath(root, 'objects', v1obj.files['a.txt']), 'tampered\n');

  const bad = runCli(root, ['checkout', v1]);
  assert.equal(bad.code, 2, `expected exit 2, got ${bad.code}: ${bad.stdout}${bad.stderr}`);
  assert.match(bad.stderr, /HASH_MISMATCH/);

  // previously checked-out directory is untouched
  assert.equal(fs.readFileSync(path.join(root, 'checkout', 'evidence', 'a.txt'), 'utf8'), kept);
  assert.equal(fs.readFileSync(path.join(root, 'checkout', 'MANIFEST.json'), 'utf8'), keptManifest);

  // and v3 (which shares the tampered lineage? no: v1 blob differs from v3's a.txt) still verifies
  const stillOk = runCli(root, ['verify', ev.readHead(root)]);
  assert.equal(stillOk.code, 1, 'v3 chain includes v1, so it must also fail');
});

test('exhaustive tamper-position enumeration over a 4-version chain', async (t) => {
  const root = tmpdir();
  const { v3 } = buildChain(root);
  const head = ev.readHead(root);
  assert.equal(head, v3);

  // collect every (version, file) tamper position across the whole chain
  const positions = [];
  let cursor = head;
  const versions = [];
  while (cursor) {
    const v = ev.loadVersion(root, cursor);
    versions.unshift({ hash: cursor, version: v });
    cursor = v.parent;
  }
  assert.ok(versions.length <= 4, 'chain must not exceed 4 versions');
  for (const { hash, version } of versions) {
    for (const [file, blobHash] of Object.entries(version.files)) {
      positions.push({ version: hash, file, blobHash });
    }
  }
  assert.ok(positions.length > 0);

  for (const pos of positions) {
    await t.test(
      `tamper ${pos.file} (${pos.blobHash.slice(0, 8)}) referenced by ${pos.version.slice(0, 8)}`,
      () => {
        const copy = copyRepo(root);
        fs.appendFileSync(ev.repoPath(copy, 'objects', pos.blobHash), 'x');
        assert.throws(
          () => ev.verify(copy, head),
          (err) => err instanceof ev.EvchainError && err.code === ev.ERR.HASH_MISMATCH,
          `tampering ${pos.file} must be detected`
        );
        const cli = runCli(copy, ['verify', head]);
        assert.equal(cli.code, 1, `CLI must exit 1 for tampered ${pos.file}`);
      }
    );
  }

  // sanity: the untouched source repo still verifies cleanly
  assert.doesNotThrow(() => ev.verify(root, head));
});
