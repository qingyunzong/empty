import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  put, del, query, prove, recover,
  buildSegment, writeSegmentFile, segmentHash,
} from '../lib/store.js';
import { verifyProof, verifyInclusion, verifyExclusion, verifyPriorInclusion } from '../lib/verify.js';
import { containsPhrase } from '../lib/text.js';
import { encodePostings, decodePostings } from '../lib/postings.js';

const PHRASE = '复验 合格';

const DOCS = {
  'cert-001': '产品质量证书 编号2026-001 该批钢材经复验合格 准予出厂',
  'cert-002': '产品质量证书 编号2026-002 该批水泥初检合格 复验结果待定',
  'cert-003': '检验报告 该批电缆经复验 合格 准予出厂',
  'cert-004': '检验报告 该批玻璃复验不合格 禁止出厂',
  'cert-005': '出厂证明 全部项目一次检验合格 无需复验',
};

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cert-store-'));
}

function fillStore(dir) {
  for (const [id, text] of Object.entries(DOCS)) put(dir, id, text);
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.code === code, `expected ${code}`);
}

test('varint delta postings round-trip', () => {
  const positions = [0, 1, 2, 5, 17, 300, 65536];
  assert.deepEqual(decodePostings(encodePostings(positions)), positions);
  assert.deepEqual(decodePostings(encodePostings([])), []);
});

test('1. brute-force inclusion/exclusion on small corpus', () => {
  const dir = tmpStore();
  fillStore(dir);

  const hits = query(dir, PHRASE);
  assert.deepEqual(hits, ['cert-001', 'cert-003']);

  // Every segment: index-based query must agree with brute-force scan.
  for (const [id, text] of Object.entries(DOCS)) {
    assert.equal(hits.includes(id), containsPhrase(text, PHRASE), `mismatch for ${id}`);
  }

  // Inclusion proofs verify for every hit.
  for (const id of hits) {
    const proof = prove(dir, id);
    assert.equal(proof.type, 'inclusion');
    assert.ok(verifyProof(proof), `inclusion proof for ${id}`);
  }

  // Unknown id -> E_ABSENT.
  expectCode(() => prove(dir, 'cert-999'), 'E_ABSENT');
});

test('2. fault injection: torn write, uncommitted segment, interrupted manifest replace', () => {
  const dir = tmpStore();
  fillStore(dir); // epoch 5
  const before = query(dir, PHRASE);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

  // F1: crash while writing segment data -> torn (truncated) file.
  fs.writeFileSync(path.join(dir, 'segments', 'seg-torn.json'), '{"id":"seg-torn","text":"经复验合');
  // F2: crash after segment write, before manifest write -> valid but uncommitted.
  writeSegmentFile(dir, buildSegment('cert-raw', 99, '补充证书 经复验合格'));
  // F3: crash during manifest replace -> leftover tmp, old manifest intact.
  fs.writeFileSync(path.join(dir, 'manifest.json.tmp'), '{"version":1,"epo');

  // Orphan/torn segments never count in queries, even before recover.
  assert.deepEqual(query(dir, PHRASE), before);

  const log = recover(dir);
  assert.deepEqual(log, [
    'RECOVER discard manifest.json.tmp',
    'RECOVER quarantine cert-raw.json reason=uncommitted',
    'RECOVER quarantine seg-torn.json reason=torn-write',
    `RECOVER ok epoch=5 head=${manifest.head}`,
  ]);

  // Query results unchanged after recovery.
  assert.deepEqual(query(dir, PHRASE), before);
  assert.ok(fs.existsSync(path.join(dir, 'quarantine', 'seg-torn.json')));
  assert.ok(fs.existsSync(path.join(dir, 'quarantine', 'cert-raw.json')));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'segments')).sort(),
    Object.keys(DOCS).map((id) => id + '.json').sort());

  // Recover is idempotent.
  assert.deepEqual(recover(dir), [`RECOVER ok epoch=5 head=${manifest.head}`]);

  // Proving a quarantined id reports E_TORN.
  expectCode(() => prove(dir, 'cert-raw'), 'E_TORN');
});

test('3. after deletion, prove yields new exclusion and old inclusion', () => {
  const dir = tmpStore();
  put(dir, 'cert-a', '证书甲 该批产品经复验合格');
  put(dir, 'cert-b', '证书乙 该批产品经复验合格');
  put(dir, 'cert-c', '证书丙 抽检合格');

  del(dir, 'cert-b');

  // The deleted segment no longer answers queries.
  assert.deepEqual(query(dir, PHRASE), ['cert-a']);

  const proof = prove(dir, 'cert-b');
  assert.equal(proof.type, 'exclusion');

  // New exclusion: tombstone with predecessor, successor, epoch.
  assert.equal(proof.tombstone.pred, 'cert-a');
  assert.equal(proof.tombstone.succ, 'cert-c');
  assert.equal(proof.tombstone.epoch, 4);
  assert.ok(verifyExclusion(proof));

  // Old inclusion: the pre-deletion chain still commits to cert-b's hash.
  assert.ok(verifyPriorInclusion(proof.priorInclusion));
  const rebuilt = buildSegment('cert-b', 2, '证书乙 该批产品经复验合格');
  assert.equal(rebuilt.hash, proof.tombstone.segHash);
  assert.ok(proof.priorInclusion.before.segments.some(
    (s) => s.id === 'cert-b' && s.hash === rebuilt.hash));

  // Whole proof verifies; live neighbour still proves inclusion.
  assert.ok(verifyProof(proof));
  assert.ok(verifyInclusion(prove(dir, 'cert-a')));

  // Deleting again reports E_ABSENT.
  expectCode(() => del(dir, 'cert-b'), 'E_ABSENT');
});

test('4. one-byte tamper -> E_CHAIN and state does not migrate', () => {
  const dir = tmpStore();
  put(dir, 'cert-001', DOCS['cert-001']);
  put(dir, 'cert-002', DOCS['cert-002']);

  const manifestBefore = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

  // Flip a single character inside the segment text (JSON stays valid).
  const segPath = path.join(dir, 'segments', 'cert-001.json');
  const tampered = fs.readFileSync(segPath, 'utf8').replace('格', '劣');
  assert.notEqual(tampered, fs.readFileSync(segPath, 'utf8'));
  fs.writeFileSync(segPath, tampered);

  expectCode(() => query(dir, PHRASE), 'E_CHAIN');
  expectCode(() => put(dir, 'cert-003', '新证书 复验合格'), 'E_CHAIN');
  expectCode(() => del(dir, 'cert-002'), 'E_CHAIN');
  expectCode(() => prove(dir, 'cert-001'), 'E_CHAIN');
  expectCode(() => recover(dir), 'E_CHAIN');

  // State did not migrate: manifest untouched, nothing quarantined.
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifestBefore);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'quarantine')), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'segments')).sort(),
    ['cert-001.json', 'cert-002.json']);
});

test('5. CLI end-to-end: put/query/prove/del/recover', () => {
  const dir = tmpStore();
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  // Sandboxed environments may drop piped stdio; capture via files instead.
  const run = (...args) => {
    const outPath = path.join(dir, '.out');
    const errPath = path.join(dir, '.err');
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');
    const r = spawnSync(process.execPath, [cli, '--dir', dir, ...args],
      { stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    return {
      status: r.status,
      stdout: fs.readFileSync(outPath, 'utf8'),
      stderr: fs.readFileSync(errPath, 'utf8'),
    };
  };

  let r = run('put', 'cert-001', '--text', DOCS['cert-001']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok put cert-001 epoch=1 hash=sha256:/);

  r = run('query', '复验 合格');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'cert-001');

  r = run('prove', 'cert-001');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(verifyProof(JSON.parse(r.stdout)));

  r = run('del', 'cert-001');
  assert.equal(r.status, 0, r.stderr);
  r = run('prove', 'cert-001');
  assert.equal(JSON.parse(r.stdout).type, 'exclusion');
  assert.ok(verifyProof(JSON.parse(r.stdout)));

  r = run('del', 'cert-001');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^E_ABSENT/);

  r = run('recover');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RECOVER ok epoch=2 head=sha256:/m);
});
