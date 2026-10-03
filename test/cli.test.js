import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const tmp = mkdtempSync(join(tmpdir(), 'starcats-'));

// Child stdout/stderr are captured through files (not pipes) so the tests also
// work in sandboxes that block pipe creation for spawned processes.
function runCli(lines, args = []) {
  const tag = Math.random().toString(36).slice(2);
  const file = join(tmp, `case-${tag}.jsonl`);
  const stdoutPath = join(tmp, `out-${tag}.txt`);
  const stderrPath = join(tmp, `err-${tag}.txt`);
  writeFileSync(file, lines.join('\n') + '\n');
  const stdoutFd = openSync(stdoutPath, 'w');
  const stderrFd = openSync(stderrPath, 'w');
  const res = spawnSync(process.execPath, [CLI, file, ...args], {
    stdio: ['ignore', stdoutFd, stderrFd],
  });
  closeSync(stdoutFd);
  closeSync(stderrFd);
  const stdout = readFileSync(stdoutPath, 'utf8');
  const stderr = readFileSync(stderrPath, 'utf8');
  const out = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: res.status, out, stderr };
}

test('SAT stream exits 0 and prints acks plus a model', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o2","star":"B","night":0,"coord":1,"mag":1,"cred":1}',
    '{"type":"solve"}',
  ]);
  assert.equal(status, 0);
  assert.equal(out[2].type, 'solve_result');
  assert.equal(out[2].status, 'SAT');
  assert.equal(out[2].model.A.coord, 0);
});

test('invalid JSON exits 2 with a JSON error', () => {
  const { status, out } = runCli(['{"type":"add_obs"', 'not json at all']);
  assert.equal(status, 2);
  assert.equal(out[0].type, 'error');
  assert.equal(out[0].error.code, 'INVALID_JSON');
});

test('unknown event type exits 2', () => {
  const { status, out } = runCli(['{"type":"explode"}']);
  assert.equal(status, 2);
  assert.equal(out[0].error.code, 'UNKNOWN_TYPE');
});

test('invalid field values exit 2', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":99,"mag":0,"cred":0}',
  ]);
  assert.equal(status, 2);
  assert.equal(out[0].error.code, 'INVALID_EVENT');
});

test('retract of an unknown id exits 2', () => {
  const { status, out } = runCli(['{"type":"retract_obs","id":"ghost"}']);
  assert.equal(status, 2);
  assert.equal(out[0].error.code, 'UNKNOWN_ID');
});

test('skipping checkpoint levels exits 2 and state stays consistent', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"checkpoint","name":"outer"}',
    '{"type":"checkpoint","name":"inner"}',
    '{"type":"undo_to","name":"outer"}',
  ]);
  assert.equal(status, 2);
  assert.equal(out[3].error.code, 'UNDO_SKIP_FORBIDDEN');
});

test('UNSAT exits 3 with a named core', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o1","star":"B","night":1,"coord":1,"mag":1,"cred":1}',
    '{"type":"solve"}',
  ]);
  assert.equal(status, 3);
  const solved = out[2];
  assert.equal(solved.status, 'UNSAT');
  assert.deepEqual(solved.core.constraints, ['unique_pk']);
  assert.deepEqual(solved.core.events, [0, 1]);
});

test('PENDING exits 4 with BUDGET_EXCEEDED and preserved facts', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":[0,1],"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o2","star":"B","night":0,"coord":[0,1],"mag":1,"cred":1}',
    '{"type":"solve","prop_budget":100,"back_budget":0}',
  ]);
  assert.equal(status, 4);
  const solved = out[2];
  assert.equal(solved.status, 'PENDING');
  assert.equal(solved.reason, 'BUDGET_EXCEEDED');
  assert.equal(solved.exhausted, 'backtracking');
  assert.ok(solved.facts.A, 'propagated facts are kept');
});

test('PENDING outranks UNSAT for the exit code', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o1","star":"B","night":1,"coord":1,"mag":1,"cred":1}',
    '{"type":"solve"}',
    '{"type":"retract_obs","id":"o1"}',
    '{"type":"add_obs","id":"o2","star":"C","night":2,"coord":[1,2],"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o3","star":"D","night":3,"coord":[1,2],"mag":1,"cred":1}',
    '{"type":"solve","back_budget":0}',
  ]);
  assert.equal(out[2].status, 'UNSAT');
  assert.equal(out[6].status, 'PENDING');
  assert.equal(status, 4);
});

test('CLI flags size the finite domains', () => {
  const { status, out } = runCli([
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"add_obs","id":"o2","star":"B","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"solve"}',
  ], ['--coords', '1']);
  assert.equal(status, 3, 'one coord bin for two stars is UNSAT');
  assert.deepEqual(out[2].core.constraints, ['exclusive_attribution']);
});

test('undo then continue via CLI matches a fresh replay', () => {
  const events = [
    '{"type":"add_obs","id":"o1","star":"A","night":0,"coord":0,"mag":0,"cred":0}',
    '{"type":"checkpoint","name":"cp"}',
    '{"type":"add_obs","id":"o2","star":"B","night":1,"coord":0,"mag":1,"cred":1}',
    '{"type":"undo_to","name":"cp"}',
    '{"type":"add_obs","id":"o3","star":"B","night":1,"coord":1,"mag":1,"cred":1}',
    '{"type":"solve"}',
  ];
  const continued = runCli(events);
  assert.equal(continued.status, 0);
  const fresh = runCli([
    events[0],
    '{"type":"add_obs","id":"o3","star":"B","night":1,"coord":1,"mag":1,"cred":1}',
    '{"type":"solve"}',
  ]);
  assert.equal(fresh.status, 0);
  assert.deepEqual(
    continued.out[continued.out.length - 1].model,
    fresh.out[fresh.out.length - 1].model,
  );
});
