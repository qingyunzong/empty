import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'cli.js');

function runCli(inputText) {
  const dir = mkdtempSync(join(tmpdir(), 'cb-cli-'));
  const input = join(dir, 'case.jsonl');
  const output = join(dir, 'result.json');
  writeFileSync(input, inputText);
  const proc = spawnSync(process.execPath, [cli, input, output], {encoding: 'utf8'});
  return {proc, output};
}

const CASE = [
  '{"type":"node","id":"m1","balance":1000}',
  '{"type":"node","id":"s1","parent":"m1","balance":200}',
  '{"type":"node","id":"t1","parent":"s1","balance":50}',
  '{"type":"node","id":"t2","parent":"s1","balance":80}',
  '{"type":"chargeback","id":"cb1","node":"t1","amount":150}',
  '{"type":"chargeback","id":"cb2","node":"t2","amount":120}',
  '{"type":"reverse","id":"rv1","chargeback":"cb1"}',
  '{"type":"reverse","id":"rv2","chargeback":"cb2"}',
  '{"type":"reverse","id":"rv3","chargeback":"cb1"}',
  '',
].join('\n');

test('CLI processes a case file and writes results', () => {
  const {proc, output} = runCli(CASE);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stderr, '');
  const report = JSON.parse(readFileSync(output, 'utf8'));

  const cb1 = report.results.find((r) => r.type === 'chargeback' && r.id === 'cb1');
  assert.equal(cb1.code, 'OK');
  assert.deepEqual(
    cb1.steps.map((s) => [s.node, s.amount]),
    [['t1', 50], ['s1', 100]],
  );

  const rv1 = report.results.find((r) => r.type === 'reverse' && r.id === 'rv1');
  assert.equal(rv1.code, 'E_RESTORE');
  const rv3 = report.results.find((r) => r.type === 'reverse' && r.id === 'rv3');
  assert.equal(rv3.code, 'OK');

  assert.deepEqual(report.balances, {m1: 1000, s1: 200, t1: 50, t2: 80});
  assert.ok(report.audit.some((e) => e.type === 'restore' && e.code === 'E_RESTORE'));
});

test('CLI exits 1 with stderr on invalid JSON', () => {
  const {proc} = runCli('{"type":"node","id":"m1","balance":10}\nnot-json\n');
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /^E_INPUT: line 2: invalid JSON/);
});

test('CLI exits 1 with stderr on unknown node', () => {
  const {proc} = runCli('{"type":"chargeback","id":"cb1","node":"nope","amount":5}\n');
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /^E_INPUT: line 1: unknown node: nope/);
});

test('CLI exits 1 without arguments', () => {
  const proc = spawnSync(process.execPath, [cli], {encoding: 'utf8'});
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /^E_INPUT: usage:/);
});
