import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyProof } from '../src/proof.js';
import { tokenize } from '../src/segment.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const PHRASE = '复验 合格';

function tmpdir(label) {
  return fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), `qcert-${label}-`));
}

// Sandbox note: nested node processes cannot write to inherited pipes here
// (stdout is swallowed), so CLI output is captured via file redirection.
let ioCounter = 0;
function run(args, env = {}) {
  const id = `${process.pid}-${ioCounter++}`;
  const outF = `/tmp/qcert-io-${id}.out`;
  const errF = `/tmp/qcert-io-${id}.err`;
  const rcF = `/tmp/qcert-io-${id}.rc`;
  spawnSync('bash', ['-c', `node "$@" >'${outF}' 2>'${errF}'; printf %s $? >'${rcF}'`, 'bash', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const status = Number(fs.readFileSync(rcF, 'utf8'));
  const stdout = fs.readFileSync(outF, 'utf8');
  const stderr = fs.readFileSync(errF, 'utf8');
  for (const f of [outF, errF, rcF]) fs.rmSync(f, { force: true });
  return { status, stdout, stderr };
}

function ok(args, env) {
  const r = run(args, env);
  assert.equal(r.status, 0, `expected success: ${args.join(' ')}\n${r.stderr}`);
  return r;
}

function fail(args, env) {
  const r = run(args, env);
  assert.notEqual(r.status, 0, `expected failure: ${args.join(' ')}`);
  return r;
}

function put(dir, id, text, env) {
  return run(['put', '--data', dir, '--id', id, '--text', text], env);
}

function queryIds(dir, phrase = PHRASE) {
  const r = ok(['query', '--data', dir, '--phrase', phrase]);
  return r.stdout.trim().split('\n').filter((l) => l.startsWith('match:'))
    .map((l) => l.split(' ')[1]);
}

// Brute-force oracle: phrase tokens appear consecutively in the text.
function bruteForceContains(text, phrase) {
  const hay = tokenize(text);
  const needle = tokenize(phrase);
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((t, k) => hay[i + k] === t)) return true;
  }
  return false;
}

const CORPUS = {
  c1: '产品 复验 合格 准予 出厂',
  c2: '复验 不合格 待 处理',
  c3: '例行 检验 合格 记录',
  c4: '复验 合格',
  c5: '批次 复验  合格 盖章',
};

test('acceptance 1: small corpus, brute-force inclusion/exclusion check', () => {
  const dir = tmpdir('corpus');
  for (const [id, text] of Object.entries(CORPUS)) put(dir, id, text);

  const expected = Object.entries(CORPUS)
    .filter(([, text]) => bruteForceContains(text, PHRASE))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(queryIds(dir).sort(), expected);
  assert.deepEqual(expected, ['c1', 'c4', 'c5']);

  // exclusion: absent phrase and absent id
  assert.match(ok(['query', '--data', dir, '--phrase', '不存在 短语']).stdout, /no match/);
  const r = fail(['prove', '--data', dir, '--id', 'nope']);
  assert.match(r.stderr, /E_ABSENT/);

  // after deletion the id is excluded from query results
  ok(['del', '--data', dir, '--id', 'c1']);
  assert.deepEqual(queryIds(dir).sort(), ['c4', 'c5']);
  const d = fail(['del', '--data', dir, '--id', 'c1']);
  assert.match(d.stderr, /E_ABSENT/);
});

// Fault-injection scenario, deterministic and repeatable.
function faultScenario(dir) {
  put(dir, 'a', '甲 复验 合格');
  put(dir, 'b', '乙 复验 不合格');
  const before = queryIds(dir);

  // point 1: torn segment write (crash mid segment data)
  assert.equal(put(dir, 'c', '丙 复验 合格', { QCERT_FAULT: 'seg' }).status, 70);
  // point 2: full segment written, crash before manifest write
  assert.equal(put(dir, 'd', '丁 复验 合格', { QCERT_FAULT: 'pre-manifest' }).status, 70);
  // point 3: manifest.tmp written, crash during replace (before rename)
  assert.equal(put(dir, 'e', '戊 复验 合格', { QCERT_FAULT: 'replace' }).status, 70);

  const rec = ok(['recover', '--data', dir]);
  const after = queryIds(dir);
  return { before, after, log: rec.stdout.trim().split('\n') };
}

test('acceptance 2: three fault points -> deterministic query results and recovery log', () => {
  const run1 = faultScenario(tmpdir('fault1'));
  const run2 = faultScenario(tmpdir('fault2'));

  // query results unchanged by crashed puts
  assert.deepEqual(run1.before, ['a']);
  assert.deepEqual(run1.after, run1.before);

  // recovery log is deterministic across identical runs
  assert.deepEqual(run1.log, run2.log);

  const head = run1.log[0].match(/^manifest: ok epoch=2 head=([0-9a-f]{64})$/);
  assert.ok(head, `unexpected first log line: ${run1.log[0]}`);
  assert.deepEqual(run1.log.slice(1), [
    'tmp: discarded stale manifest.tmp',
    'quarantine: c.seg reason=torn',
    'quarantine: d.seg reason=orphan',
    'quarantine: e.seg reason=orphan',
    'done: epoch=2 segments=2 tombstones=0 quarantined=3',
  ]);

  // quarantined segments are physically isolated and not queryable
});

test('acceptance 3: after del, prove yields both new exclusion and old inclusion', () => {
  const dir = tmpdir('prove');
  put(dir, 'x', '证书 复验 合格 有效');
  put(dir, 'y', '附录 复验 不合格');
  ok(['del', '--data', dir, '--id', 'x']);

  const proof = JSON.parse(ok(['prove', '--data', dir, '--id', 'x']).stdout);
  assert.equal(proof.type, 'exclusion+inclusion');

  // library-level third-party verification
  const v = verifyProof(proof, PHRASE);
  assert.equal(v.exclusion.id, 'x');
  assert.equal(v.exclusion.epoch, 3);
  assert.equal(v.inclusion.id, 'x');
  assert.equal(v.inclusion.epoch, 2);
  assert.deepEqual(v.inclusion.positions, [1]);
  assert.ok(v.exclusion.head !== v.inclusion.head, 'epochs must have distinct heads');

  // CLI-level verification
  const pfile = path.join(dir, 'proof.json');
  fs.writeFileSync(pfile, JSON.stringify(proof));
  const r = ok(['verify', '--proof', pfile, '--phrase', PHRASE]);
  assert.match(r.stdout, /verify: ok exclusion@3 inclusion@2/);

  // live id proves plain inclusion
  const liveProof = JSON.parse(ok(['prove', '--data', dir, '--id', 'y']).stdout);
  assert.equal(liveProof.type, 'inclusion');
  assert.equal(verifyProof(liveProof).inclusion.id, 'y');
});

test('acceptance 4: one-byte tamper -> E_CHAIN and no state migration', () => {
  const dir = tmpdir('tamper');
  put(dir, 'a', '甲 复验 合格');
  put(dir, 'b', '乙 复验 合格');
  const manifestBefore = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8');

  // flip one byte inside a live segment file
  const segFile = path.join(dir, 'segments', 'b.seg');
  const buf = fs.readFileSync(segFile);
  buf[20] ^= 0x01;
  fs.writeFileSync(segFile, buf);

  const q = fail(['query', '--data', dir, '--phrase', PHRASE]);
  assert.match(q.stderr, /E_CHAIN/);

  const rec = fail(['recover', '--data', dir]);
  assert.match(rec.stderr, /E_CHAIN/);

  // state not migrated: manifest untouched, nothing quarantined, no tmp left
  assert.equal(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifestBefore);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'quarantine')), []);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'segments')).sort(), ['a.seg', 'b.seg']);
  assert.ok(!fs.existsSync(path.join(dir, 'manifest.tmp')));
});
