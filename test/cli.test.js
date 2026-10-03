import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

// Note: piped stdio to grandchild processes is unreliable in this sandbox
// (spawnSync reports a spurious EPERM and pipes stall), so the CLI is driven
// through shell redirection with files in a temp directory and the spawn
// result's error field is deliberately ignored; the exit-code file is the
// source of truth.
function runCli(input) {
  const dir = mkdtempSync(path.join(tmpdir(), 'labcli-'));
  const inFile = path.join(dir, 'in.json');
  const outFile = path.join(dir, 'out.json');
  const codeFile = path.join(dir, 'code.txt');
  writeFileSync(inFile, typeof input === 'string' ? input : JSON.stringify(input));
  spawnSync('bash', ['-c', `node "$1" < "$2" > "$3"; echo -n $? > "$4"`, 'bash', CLI, inFile, outFile, codeFile], {
    encoding: 'utf8',
  });
  return { status: Number(readFileSync(codeFile, 'utf8')), stdout: readFileSync(outFile, 'utf8') };
}

test('CLI reads JSON ops from stdin and prints final evaluation', () => {
  const res = runCli({
    now: '2026-01-01',
    ops: [
      { op: 'addBatch', id: 'B1', expiresAt: '2027-01-01', concentration: 1 },
      { op: 'addBatch', id: 'B2', expiresAt: '2027-01-01', concentration: 2 },
      { op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1', substitutes: ['B2'] },
      { op: 'addNode', id: 'K1', kind: 'conclusion', dependsOn: ['R1'] },
      { op: 'withdrawBatch', id: 'B1' },
    ],
  });
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results.length, 5);
  assert.equal(out.final.error, null);
  assert.equal(out.final.nodes.R1.status, 'valid');
  assert.equal(out.final.nodes.R1.chosenBatch, 'B2');
  assert.equal(out.final.nodes.K1.status, 'valid');
});

test('CLI supports undo/redo ops and reports affected closure', () => {
  const res = runCli([
    { op: 'addBatch', id: 'B1' },
    { op: 'addResult', id: 'R1', batchId: 'B1', protocolVersion: 'v1' },
    { op: 'withdrawBatch', id: 'B1' },
    { op: 'undo' },
    { op: 'redo' },
  ]);
  assert.equal(res.status, 0);
  const out = JSON.parse(res.stdout);
  assert.equal(out.results[2].affected.join(','), 'R1');
  assert.equal(out.results[3].ok, true);
  assert.equal(out.final.nodes.R1.status, 'invalid');
});

test('CLI surfaces E_REF and E_CYCLE with nonzero exit', () => {
  const ref = runCli([{ op: 'addResult', id: 'R1', batchId: 'GHOST', protocolVersion: 'v1' }]);
  assert.equal(ref.status, 2);
  assert.equal(JSON.parse(ref.stdout).final.error.code, 'E_REF');

  const cyc = runCli([
    { op: 'addNode', id: 'A', kind: 'derived', dependsOn: ['B'] },
    { op: 'addNode', id: 'B', kind: 'derived', dependsOn: ['A'] },
  ]);
  assert.equal(cyc.status, 2);
  assert.equal(JSON.parse(cyc.stdout).final.error.code, 'E_CYCLE');
});

test('CLI rejects malformed JSON with E_PARSE', () => {
  const res = runCli('{not json');
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).error.code, 'E_PARSE');
});
