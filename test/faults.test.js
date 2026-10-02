import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mktmp, runCli, seedDir, readJson } from '../support/helpers.js';

function pair(root) {
  const A = seedDir(root, 'A');
  const B = seedDir(root, 'B');
  fs.cpSync(path.join(A, 'seed.json'), path.join(B, 'seed.json'));
  fs.cpSync(path.join(A, 'constraints.json'), path.join(B, 'constraints.json'));
  return { A, B };
}

test('fault 1: crash before log append recovers to last consistent point', () => {
  const root = mktmp();
  const A = seedDir(root, 'A');
  let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  assert.equal(r.code, 0, r.stderr);

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":1}'],
    { env: { PLAN_SYNC_FAIL_AT: 'before-append' } });
  assert.equal(r.code, 70, 'injected crash exit code');
  assert.equal(r.errJson.error.type, 'crash');
  assert.equal(r.errJson.error.point, 'before-append');

  r = runCli(['resume', '--dir', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.logLen, 1, 'crashed change was never appended');
  assert.equal(r.json.replayed, 0);
  assert.equal(r.json.truncated, false);

  const cert = runCli(['export-cert', '--dir', A]).json.cert;
  assert.equal(cert.logLen, 1);
  const v = runCli(['verify', '--dir', A]);
  assert.equal(v.code, 0);
});

test('fault 2: crash after append without fsync replays log and discards torn tail', () => {
  const root = mktmp();
  const A = seedDir(root, 'A');
  let r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  assert.equal(r.code, 0, r.stderr);

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":1}'],
    { env: { PLAN_SYNC_FAIL_AT: 'after-append' } });
  assert.equal(r.code, 70);
  assert.equal(r.errJson.error.point, 'after-append');

  const raw = fs.readFileSync(path.join(A, 'log.jsonl'), 'utf8');
  assert.ok(!raw.endsWith('\n'), 'torn tail: un-fsynced partial line present before recovery');

  r = runCli(['resume', '--dir', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.truncated, true, 'torn tail truncated during replay');
  assert.equal(r.json.logLen, 1, 'un-fsynced change is gone after replay');

  const rawAfter = fs.readFileSync(path.join(A, 'log.jsonl'), 'utf8');
  assert.ok(rawAfter.endsWith('\n'), 'log repaired to clean newline-terminated entries');

  r = runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":1}']);
  assert.equal(r.code, 0, 'replica usable after recovery');
  assert.equal(r.json.changeId, 'A:2');
  assert.equal(r.json.logLen, 2);
});

test('fault 3: crash before snapshot rename discards half snapshot and replays log', () => {
  const root = mktmp();
  const { A, B } = pair(root);
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","machine":"M3","start":0}']);

  let r = runCli(['sync', '--dir', A, '--peer', B], { env: { PLAN_SYNC_FAIL_AT: 'before-rename' } });
  assert.equal(r.code, 70);
  assert.equal(r.errJson.error.point, 'before-rename');
  assert.ok(fs.existsSync(path.join(A, 'snapshot.json.tmp')), 'half-written snapshot temp left behind');

  r = runCli(['resume', '--dir', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.discardedTmpSnapshot, true, 'half snapshot discarded');
  assert.ok(!fs.existsSync(path.join(A, 'snapshot.json.tmp')), 'temp snapshot removed');
  assert.equal(r.json.logLen, 2, 'merged log replayed');
  assert.ok(r.json.replayed >= 1, 'recovery replayed log entries past the stale snapshot');

  r = runCli(['resume', '--dir', B]);
  assert.equal(r.code, 0);
  assert.equal(r.json.logLen, 2);

  r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 0, 're-sync converges after recovery');
  const certA = runCli(['export-cert', '--dir', A]).json.certHash;
  const certB = runCli(['export-cert', '--dir', B]).json.certHash;
  assert.equal(certA, certB);
});

test('fault 4: crash after manifest commit reports committed state on resume', () => {
  const root = mktmp();
  const { A, B } = pair(root);
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  runCli(['apply', '--dir', B, '--node', 'B', '--type', 'move', '--data', '{"id":"o3","machine":"M3","start":0}']);

  let r = runCli(['sync', '--dir', A, '--peer', B], { env: { PLAN_SYNC_FAIL_AT: 'after-manifest' } });
  assert.equal(r.code, 70);
  assert.equal(r.errJson.error.point, 'after-manifest');

  const manifest = readJson(path.join(A, 'manifest.json'));
  assert.equal(manifest.snapshotLogLen, 2, 'manifest committed with merged log length');

  r = runCli(['resume', '--dir', A]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.json.committed, { logLen: 2, clock: { A: 1, B: 1 } },
    'resume reports the committed state from the manifest');
  assert.equal(r.json.recoveredFrom, 'snapshot+log');
  assert.equal(r.json.logLen, 2);

  r = runCli(['resume', '--dir', B]);
  assert.equal(r.code, 0);
  assert.equal(r.json.logLen, 2);

  r = runCli(['sync', '--dir', A, '--peer', B]);
  assert.equal(r.code, 0);
  const certA = runCli(['export-cert', '--dir', A]).json.certHash;
  const certB = runCli(['export-cert', '--dir', B]).json.certHash;
  assert.equal(certA, certB);
});

test('corrupt log in the middle is unrecoverable: exit 4 with JSON error', () => {
  const root = mktmp();
  const A = seedDir(root, 'A');
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o2","start":4}']);
  runCli(['apply', '--dir', A, '--node', 'A', '--type', 'move', '--data', '{"id":"o3","start":1}']);
  const log = path.join(A, 'log.jsonl');
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  fs.writeFileSync(log, lines[0] + '\n' + '{"broken":' + '\n' + lines[1] + '\n');

  const r = runCli(['resume', '--dir', A]);
  assert.equal(r.code, 4, 'recovery failure exit code');
  assert.equal(r.errJson.error.code, 4);
  assert.equal(r.errJson.error.type, 'recovery');

  const v = runCli(['verify', '--dir', A]);
  assert.equal(v.code, 4, 'all commands fail with 4 when recovery is impossible');
});
