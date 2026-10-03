'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EVC = path.join(__dirname, '..', 'evc.js');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evc-test-'));
}

function run(cwd, ...args) {
  // The sandbox drops piped stdout/stderr of grandchild processes, so the
  // child writes to files that we read back instead.
  const outFile = path.join(cwd, '.test-stdout');
  const errFile = path.join(cwd, '.test-stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const result = spawnSync(process.execPath, [EVC, ...args], {
    cwd,
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: result.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function ok(result) {
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  return result;
}

function writeEvidence(root, name, content) {
  const file = path.join(root, 'evidence', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function writeClaims(root, claims) {
  fs.writeFileSync(path.join(root, 'claims.json'), JSON.stringify(claims));
}

function commitHash(result) {
  const match = /committed version ([0-9a-f]{64})/.exec(result.stdout);
  assert.ok(match, `cannot parse commit hash from: ${result.stdout}`);
  return match[1];
}

test('checkout an old version after consecutive commits', () => {
  const root = tmpdir();
  ok(run(root, 'init'));

  writeEvidence(root, 'a.txt', 'alpha');
  const v1 = commitHash(ok(run(root, 'commit', '-m', 'v1')));

  writeEvidence(root, 'a.txt', 'beta');
  writeEvidence(root, 'b.txt', 'second');
  ok(run(root, 'commit', '-m', 'v2'));

  writeEvidence(root, 'c.txt', 'third');
  const v3 = commitHash(ok(run(root, 'commit', '-m', 'v3')));

  // Corrupt the live workspace on purpose: checkout must not depend on it.
  writeEvidence(root, 'a.txt', 'workspace garbage');
  fs.rmSync(path.join(root, 'evidence', 'b.txt'));

  ok(run(root, 'checkout', v1));
  const out = path.join(root, 'checkout');
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'alpha');
  assert.ok(!fs.existsSync(path.join(out, 'b.txt')), 'b.txt must not exist in v1');
  assert.ok(!fs.existsSync(path.join(out, 'c.txt')), 'c.txt must not exist in v1');

  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, v1);
  assert.deepEqual(manifest.files, { 'a.txt': sha256('alpha') });

  // HEAD is still v3; checking out v3 rebuilds its full manifest too.
  ok(run(root, 'checkout', v3));
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'beta');
  assert.equal(fs.readFileSync(path.join(out, 'b.txt'), 'utf8'), 'second');
  assert.equal(fs.readFileSync(path.join(out, 'c.txt'), 'utf8'), 'third');
});

test('verify emits a certificate built from content hash and parent hash', () => {
  const root = tmpdir();
  ok(run(root, 'init'));
  writeEvidence(root, 'a.txt', 'alpha');
  const v1 = commitHash(ok(run(root, 'commit', '-m', 'genesis')));
  writeEvidence(root, 'a.txt', 'beta');
  const v2 = commitHash(ok(run(root, 'commit', '-m', 'second')));

  ok(run(root, 'verify', v2));
  const cert = JSON.parse(fs.readFileSync(path.join(root, '.evc', 'certificate.json'), 'utf8'));
  assert.equal(cert.contentHash, v2);
  assert.equal(cert.parentHash, v1);
  assert.equal(cert.certificateHash, sha256(`${v2}:${v1}`));

  ok(run(root, 'verify', v1));
  const genesis = JSON.parse(fs.readFileSync(path.join(root, '.evc', 'certificate.json'), 'utf8'));
  assert.equal(genesis.parentHash, null);
  assert.equal(genesis.certificateHash, sha256(`${v1}:null`));
});

test('tampered evidence blob is detected as HASH_MISMATCH', () => {
  const root = tmpdir();
  ok(run(root, 'init'));
  writeEvidence(root, 'a.txt', 'alpha');
  ok(run(root, 'commit', '-m', 'v1'));

  const object = path.join(root, '.evc', 'objects', sha256('alpha'));
  fs.writeFileSync(object, 'forged content');

  const result = run(root, 'verify');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /HASH_MISMATCH/);
});

test('missing evidence blob is detected as MISSING_EVIDENCE', () => {
  const root = tmpdir();
  ok(run(root, 'init'));
  writeEvidence(root, 'a.txt', 'alpha');
  ok(run(root, 'commit', '-m', 'v1'));

  fs.rmSync(path.join(root, '.evc', 'objects', sha256('alpha')));

  const result = run(root, 'verify');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MISSING_EVIDENCE/);
});

test('commit deleting claim-referenced evidence fails and keeps HEAD', () => {
  const root = tmpdir();
  ok(run(root, 'init'));
  writeEvidence(root, 'a.txt', 'alpha');
  writeClaims(root, [{ id: 'c1', text: 'a proves the claim', evidence: ['a.txt'] }]);
  const v1 = commitHash(ok(run(root, 'commit', '-m', 'v1')));

  fs.rmSync(path.join(root, 'evidence', 'a.txt'));
  const result = run(root, 'commit', '-m', 'delete referenced evidence');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DANGLING_CLAIM/);

  // HEAD still points at v1 and the chain still verifies.
  assert.equal(fs.readFileSync(path.join(root, '.evc', 'HEAD'), 'utf8').trim(), v1);
  ok(run(root, 'verify'));
});

test('checkout of a corrupted version exits 2 and keeps the previous checkout', () => {
  const root = tmpdir();
  ok(run(root, 'init'));
  writeEvidence(root, 'a.txt', 'alpha');
  const v1 = commitHash(ok(run(root, 'commit', '-m', 'v1')));

  ok(run(root, 'checkout', v1));
  const out = path.join(root, 'checkout');
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'alpha');

  writeEvidence(root, 'b.txt', 'second');
  const v2 = commitHash(ok(run(root, 'commit', '-m', 'v2')));

  // Corrupt the blob introduced by v2.
  fs.writeFileSync(path.join(root, '.evc', 'objects', sha256('second')), 'forged');

  const result = run(root, 'checkout', v2);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /HASH_MISMATCH/);

  // The previously checked-out directory is untouched.
  assert.equal(fs.readFileSync(path.join(out, 'a.txt'), 'utf8'), 'alpha');
  assert.ok(!fs.existsSync(path.join(out, 'b.txt')));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, v1);
});

test('enumerate every tamper position independently across 4 versions', () => {
  const base = tmpdir();
  ok(run(base, 'init'));
  const versions = [];
  const introduced = [];
  for (let i = 1; i <= 4; i += 1) {
    const content = `evidence-payload-${i}`;
    writeEvidence(base, `f${i}.txt`, content);
    introduced.push({ name: `f${i}.txt`, hash: sha256(content) });
    versions.push(commitHash(ok(run(base, 'commit', '-m', `v${i}`))));
  }
  const head = versions[3];
  ok(run(base, 'verify', head));

  assert.ok(versions.length <= 4, 'enumeration bounded to at most 4 versions');
  for (let i = 0; i < versions.length; i += 1) {
    // Each tamper position gets its own pristine copy of the repository.
    const copy = tmpdir();
    fs.cpSync(base, copy, { recursive: true });

    const target = introduced[i];
    const object = path.join(copy, '.evc', 'objects', target.hash);
    fs.writeFileSync(object, `tampered-at-version-${i + 1}`);

    const result = run(copy, 'verify', head);
    assert.equal(result.status, 2, `tamper at version ${i + 1} must fail verification`);
    assert.match(result.stderr, /HASH_MISMATCH/);
    assert.match(result.stderr, new RegExp(target.name));

    // The same corruption also blocks checkout of any descendant version.
    const checkout = run(copy, 'checkout', head);
    assert.equal(checkout.status, 2, `tamper at version ${i + 1} must fail checkout`);
    assert.ok(!fs.existsSync(path.join(copy, 'checkout')));
  }
});
