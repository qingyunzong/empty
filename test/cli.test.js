// CLI contract: JSONL in, JSONL out, exit codes 0 / 2 / 3 / 4.
// (Child stdio is redirected through temp files because piped stdio is not
// reliable in every sandboxed environment.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function runCli(input, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'starcatsolve-'));
  const inFile = join(dir, 'events.jsonl');
  const outFile = join(dir, 'out.jsonl');
  writeFileSync(inFile, input.endsWith('\n') ? input : input + '\n');
  const outFd = openSync(outFile, 'w');
  const r = spawnSync(process.execPath, [CLI, inFile, ...args], { stdio: ['ignore', outFd, 'inherit'] });
  closeSync(outFd);
  const text = readFileSync(outFile, 'utf8');
  const lines = text.trim().length ? text.trim().split('\n').map((l) => JSON.parse(l)) : [];
  return { status: r.status, lines };
}

test('SAT input exits 0 with acks and a SAT solve_result', () => {
  const { status, lines } = runCli([
    '{"type":"config","coordBins":4,"magBins":2,"capacity":2}',
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":0.9}',
    '{"type":"checkpoint","name":"cp"}',
    '{"type":"solve"}',
  ].join('\n'));
  assert.equal(status, 0);
  assert.equal(lines.at(-1).type, 'solve_result');
  assert.equal(lines.at(-1).status, 'SAT');
  assert.equal(lines.at(-1).line, 4);
});

test('invalid JSON exits 2 with a JSON error object', () => {
  const { status, lines } = runCli('{"type":"add_obs",}');
  assert.equal(status, 2);
  assert.equal(lines.at(-1).type, 'error');
  assert.equal(lines.at(-1).code, 'INVALID_INPUT');
  assert.equal(lines.at(-1).line, 1);
});

test('semantic errors exit 2 (duplicate id, unknown type, bad undo)', () => {
  const dup = runCli([
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"add_obs","id":"o1","star":"s2","night":0,"ts":1,"coord":1,"mag":0,"conf":1}',
  ].join('\n'));
  assert.equal(dup.status, 2);
  assert.match(dup.lines.at(-1).message, /duplicate observation id/);

  const unknown = runCli('{"type":"explode"}');
  assert.equal(unknown.status, 2);
  assert.match(unknown.lines.at(-1).message, /unknown event type/);

  const badUndo = runCli('{"type":"undo_to","name":"ghost"}');
  assert.equal(badUndo.status, 2);
});

test('UNSAT exits 3 and reports a minimal core', () => {
  const { status, lines } = runCli([
    '{"type":"config","coordBins":1,"magBins":1,"capacity":2}',
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"add_obs","id":"o2","star":"s2","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"solve"}',
  ].join('\n'));
  assert.equal(status, 3);
  const res = lines.at(-1);
  assert.equal(res.status, 'UNSAT');
  assert.deepEqual(res.unsatCore.obs, ['o1', 'o2']);
  assert.deepEqual(res.unsatCore.constraints, ['exclusive_cell']);
});

test('PENDING exits 4 and is never reported as UNSAT', () => {
  const { status, lines } = runCli([
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"add_obs","id":"o2","star":"s2","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"solve","budget":{"propagation":0,"backtrack":0}}',
  ].join('\n'));
  assert.equal(status, 4);
  const res = lines.at(-1);
  assert.equal(res.status, 'PENDING');
  assert.equal(res.reason, 'BUDGET_EXCEEDED');
  assert.ok(!('unsatCore' in res));
});

test('undo level skip is reported as a warning, not an error', () => {
  const { status, lines } = runCli([
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"checkpoint","name":"cp1"}',
    '{"type":"checkpoint","name":"cp2"}',
    '{"type":"undo_to","name":"cp1"}',
  ].join('\n'));
  assert.equal(status, 0);
  const undo = lines.at(-1);
  assert.equal(undo.type, 'undo');
  assert.equal(undo.warning, 'UNDO_LEVEL_SKIP');
  assert.equal(undo.restored, 'cp2');
});

test('CLI budget flags apply to solve events without explicit budgets', () => {
  const { status, lines } = runCli([
    '{"type":"add_obs","id":"o1","star":"s1","night":0,"ts":1,"coord":0,"mag":0,"conf":1}',
    '{"type":"solve"}',
  ].join('\n'), ['--budget-propagation', '0']);
  assert.equal(status, 4);
  assert.equal(lines.at(-1).status, 'PENDING');
});
