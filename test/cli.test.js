import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function runCli(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const lines = (text) => text.trim().split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

test('CLI answers NDJSON commands with feasibility responses', async () => {
  const { code, stdout, stderr } = await runCli([
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":1,"upper":3}',
    '{"op":"add-edge","event":"e2","id":"ba","from":"B","to":"A","lower":0,"upper":3}',
    '{"op":"check"}',
    '{"op":"node-flow","id":"A"}',
    '',
  ].join('\n'));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '');
  const [r1, r2, r3, r4] = lines(stdout);
  assert.equal(r1.ok, true);
  assert.equal(r1.feasible, false);
  assert.equal(r1.certificate.deficit, 1);
  assert.equal(r2.feasible, true);
  assert.ok(r2.flow.ab >= 1);
  assert.equal(r3.feasible, true);
  assert.equal(r4.inflow, r4.outflow);
});

test('CLI undo/redo by event id over NDJSON', async () => {
  const { code, stdout } = await runCli([
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":2,"upper":3}',
    '{"op":"add-edge","event":"e2","id":"ba","from":"B","to":"A","lower":0,"upper":1}',
    '{"op":"update-edge","event":"e3","id":"ba","upper":2}',
    '{"op":"undo","id":"e3"}',
    '{"op":"redo","id":"e3"}',
    '',
  ].join('\n'));
  assert.equal(code, 0);
  const responses = lines(stdout);
  assert.equal(responses[2].feasible, true);
  assert.equal(responses[3].feasible, false);
  assert.equal(responses[4].feasible, true);
});

test('CLI reports lower>upper as JSON error and exits 1', async () => {
  const { code, stdout, stderr } = await runCli(
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":5,"upper":3}\n',
  );
  assert.equal(code, 1);
  assert.equal(stdout, '');
  const [err] = lines(stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'INVALID_BOUNDS');
});

test('CLI reports negative capacity as JSON error and exits 1', async () => {
  const { code, stderr } = await runCli(
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":-1,"upper":3}\n',
  );
  assert.equal(code, 1);
  assert.equal(lines(stderr)[0].error.code, 'NEGATIVE_CAPACITY');
});

test('CLI reports redo mismatch as JSON error and exits 1', async () => {
  const { code, stdout, stderr } = await runCli([
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":1,"upper":2}',
    '{"op":"undo","id":"e1"}',
    '{"op":"redo","id":"wrong"}',
    '',
  ].join('\n'));
  assert.equal(code, 1);
  assert.equal(lines(stdout).length, 2, 'responses emitted before the failure');
  assert.equal(lines(stderr)[0].error.code, 'REDO_MISMATCH');
});

test('CLI reports unknown node as JSON error and exits 1', async () => {
  const { code, stderr } = await runCli(
    '{"op":"add-edge","event":"e1","id":"ab","from":"A","to":"B","lower":0,"upper":1}\n{"op":"node-flow","id":"Z"}\n',
  );
  assert.equal(code, 1);
  assert.equal(lines(stderr)[0].error.code, 'UNKNOWN_NODE');
});

test('CLI reports invalid JSON as JSON error and exits 1', async () => {
  const { code, stderr } = await runCli('not json\n');
  assert.equal(code, 1);
  assert.equal(lines(stderr)[0].error.code, 'INVALID_JSON');
});
