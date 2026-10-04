import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

// The CLI is exercised in-process through main(argv, io): the sandboxed test
// runner may not be allowed to spawn child node processes, and exit codes are
// returned by main() exactly as the process wrapper would produce them.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = main(args, {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  });
  return { status, stdout, stderr };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  writeFileSync(
    jsonl,
    [
      { op: 'add', id: 'LOT-2025-0001', attrs: { type: 'raw', date: '2025-01-01', name: 'flour' } },
      { op: 'add', id: 'LOT-2025-0002', attrs: { type: 'semi', date: '2025-01-02', name: 'dough-a' } },
      { op: 'add', id: 'LOT-2025-0003', attrs: { type: 'semi', date: '2025-01-03', name: 'dough-b' } },
      { op: 'add', id: 'LOT-2025-0004', attrs: { type: 'finished', date: '2025-01-04', name: 'bread' } },
      { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' },
      { op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0003' },
      { op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0004' },
      { op: 'link', from: 'LOT-2025-0003', to: 'LOT-2025-0004' },
    ]
      .map((c) => JSON.stringify(c))
      .join('\n') + '\n',
  );
  return { dir, jsonl };
}

test('apply writes graph state to --out and stdout', () => {
  const { dir, jsonl } = fixture();
  const state = join(dir, 'state.json');
  const res = runCli(['apply', jsonl, '--out', state]);
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(parsed.nodes.length, 4);
  assert.equal(parsed.edges.length, 4);
  assert.equal(parsed.version, 8);

  const res2 = runCli(['apply', jsonl]);
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal(JSON.parse(res2.stdout).nodes.length, 4);
});

test('acceptance 3: cycle inside a transaction is rejected with no partial writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  const state = join(dir, 'state.json');
  writeFileSync(
    jsonl,
    [
      JSON.stringify({ op: 'add', id: 'LOT-2025-0001', attrs: { type: 'raw', date: '2025-01-01' } }),
      JSON.stringify({ op: 'add', id: 'LOT-2025-0002', attrs: { type: 'semi', date: '2025-01-02' } }),
      JSON.stringify({ op: 'begin' }),
      JSON.stringify({ op: 'add', id: 'LOT-2025-0003', attrs: { type: 'semi', date: '2025-01-03' } }),
      JSON.stringify({ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }),
      JSON.stringify({ op: 'link', from: 'LOT-2025-0002', to: 'LOT-2025-0001' }),
      JSON.stringify({ op: 'commit' }),
    ].join('\n') + '\n',
  );
  const res = runCli(['apply', jsonl, '--out', state]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /graph\.jsonl:7: transaction failed: .*cycle/);
  assert.equal(existsSync(state), false, 'no state file may be written on failure');
});

test('malformed JSONL reports the line number and exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  writeFileSync(
    jsonl,
    '{"op":"add","id":"LOT-2025-0001","attrs":{"type":"raw","date":"2025-01-01"}}\nnot json\n',
  );
  const res = runCli(['apply', jsonl]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /graph\.jsonl:2: invalid JSON/);
});

test('invalid command shape exits 2 with a line number', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  writeFileSync(jsonl, '{"op":"link","from":"LOT-2025-0001"}\n');
  const res = runCli(['apply', jsonl]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /graph\.jsonl:1:/);
});

test('query and verify round-trip through the CLI', () => {
  const { dir, jsonl } = fixture();
  const state = join(dir, 'state.json');
  assert.equal(runCli(['apply', jsonl, '--out', state]).status, 0);

  const dsl = join(dir, 'q.dsl');
  writeFileSync(dsl, 'query ancestors(LOT-2025-0004);\n');
  const qres = runCli(['query', dsl, '--graph', state]);
  assert.equal(qres.status, 0, qres.stderr);
  const output = JSON.parse(qres.stdout);
  assert.deepEqual(output.results[0].result, ['LOT-2025-0001', 'LOT-2025-0002', 'LOT-2025-0003']);

  const certFile = join(dir, 'cert.json');
  writeFileSync(certFile, qres.stdout);
  const vres = runCli(['verify', certFile, '--graph', state]);
  assert.equal(vres.status, 0, vres.stderr);
  assert.match(vres.stdout, /certificate 0: OK/);
});

test('acceptance 5 (CLI): a tampered certificate path fails verify with exit 1', () => {
  const { dir, jsonl } = fixture();
  const state = join(dir, 'state.json');
  assert.equal(runCli(['apply', jsonl, '--out', state]).status, 0);
  const dsl = join(dir, 'q.dsl');
  writeFileSync(dsl, 'query ancestors(LOT-2025-0004);\n');
  const qres = runCli(['query', dsl, '--graph', state]);
  const output = JSON.parse(qres.stdout);
  output.certificates[0].paths[0][0] = 'LOT-2025-0099';
  const certFile = join(dir, 'cert.json');
  writeFileSync(certFile, JSON.stringify(output));
  const vres = runCli(['verify', certFile, '--graph', state]);
  assert.equal(vres.status, 1);
  assert.match(vres.stderr, /path 0 hash mismatch/);
});

test('DSL syntax errors exit 2 with a line number; unknown lots exit 1', () => {
  const { dir, jsonl } = fixture();
  const state = join(dir, 'state.json');
  assert.equal(runCli(['apply', jsonl, '--out', state]).status, 0);

  const bad = join(dir, 'bad.dsl');
  writeFileSync(bad, 'query ancestors(LOT-2025-0001);\nquery nope(LOT-2025-0001);\n');
  const resBad = runCli(['query', bad, '--graph', state]);
  assert.equal(resBad.status, 2);
  assert.match(resBad.stderr, /bad\.dsl:2: unknown function 'nope'/);

  const unknown = join(dir, 'unknown.dsl');
  writeFileSync(unknown, 'query ancestors(LOT-2025-9999);\n');
  const resUnknown = runCli(['query', unknown, '--graph', state]);
  assert.equal(resUnknown.status, 1);
  assert.match(resUnknown.stderr, /unknown lot 'LOT-2025-9999'/);
});

test('undo/redo commands in JSONL and missing args usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lineage-cli-'));
  const jsonl = join(dir, 'graph.jsonl');
  writeFileSync(
    jsonl,
    [
      JSON.stringify({ op: 'add', id: 'LOT-2025-0001', attrs: { type: 'raw', date: '2025-01-01' } }),
      JSON.stringify({ op: 'add', id: 'LOT-2025-0002', attrs: { type: 'semi', date: '2025-01-02' } }),
      JSON.stringify({ op: 'link', from: 'LOT-2025-0001', to: 'LOT-2025-0002' }),
      JSON.stringify({ op: 'undo' }),
      JSON.stringify({ op: 'redo' }),
    ].join('\n') + '\n',
  );
  const res = runCli(['apply', jsonl]);
  assert.equal(res.status, 0, res.stderr);
  const state = JSON.parse(res.stdout);
  assert.equal(state.edges.length, 1);
  assert.equal(state.version, 5);

  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['apply']).status, 2);
});
