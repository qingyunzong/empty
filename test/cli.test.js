import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHashChain } from '../src/engine.js';

const CLI = new URL('../bin/cli.js', import.meta.url).pathname;

// The sandbox interferes with piped stdio to grandchild processes, so the
// CLI is driven through files and `sh -c` redirection instead of `input`.
function runCli(stdin, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pay-ledger-cli-'));
  const inFile = join(dir, 'stdin.json');
  const outFile = join(dir, 'stdout.txt');
  const errFile = join(dir, 'stderr.txt');
  const codeFile = join(dir, 'code.txt');
  writeFileSync(inFile, stdin);
  const quotedArgs = args.map((a) => `'${a}'`).join(' ');
  spawnSync(
    'sh',
    ['-c', `${process.execPath} '${CLI}' ${quotedArgs} < '${inFile}' > '${outFile}' 2> '${errFile}'; echo $? > '${codeFile}'`],
    { encoding: 'utf8' },
  );
  return {
    status: Number(readFileSync(codeFile, 'utf8').trim()),
    stdout: readFileSync(outFile, 'utf8'),
    stderr: readFileSync(errFile, 'utf8'),
    dir,
  };
}

const OPS = [
  { type: 'deposit', clientOpId: 'd1', clock: 1, amount: 500 },
  { type: 'authorize', clientOpId: 'a1', clock: 2, amount: 200, ttl: 5 },
  { type: 'capture', clientOpId: 'c1', clock: 3, parentId: 'a1', amount: 120 },
  { type: 'reverse', clientOpId: 'r1', clock: 4, parentId: 'c1', amount: 50 },
];

test('CLI reads an op array from stdin and prints view, results, log, tipHash', () => {
  const proc = runCli(JSON.stringify(OPS));
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.view, {
    available: 350,
    frozen: 80,
    captured: 70,
    refunded: 50,
    voided: 0,
    expired: 0,
    openAuthorizations: 1,
    terminalAuthorizations: 0,
  });
  assert.equal(out.results.length, 4);
  assert.equal(out.log.length, 4);
  assert.equal(verifyHashChain(out.log, 0), true);
  assert.equal(out.log.at(-1).hash, out.tipHash);
});

test('CLI accepts { initialBalance, ops } envelope', () => {
  const proc = runCli(JSON.stringify({ initialBalance: 40, ops: OPS }));
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.view.available, 390);
});

test('CLI failure is atomic: invalid JSON -> exit 1, nothing on stdout, no file written', () => {
  const proc = runCli('not json');
  const outFile = join(proc.dir, 'out.json');
  const proc2 = runCli('not json', ['--out', outFile]);
  assert.equal(proc.status, 1);
  assert.equal(proc2.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc2.stderr, /not valid JSON/);
  assert.equal(existsSync(outFile), false);
});

test('CLI failure is atomic: invalid op -> exit 1, no partial output file', () => {
  const bad = [...OPS, { type: 'authorize', clientOpId: 'bad', clock: 5, amount: -3 }];
  const probe = runCli(JSON.stringify(bad));
  const outFile = join(probe.dir, 'out.json');
  const proc = runCli(JSON.stringify(bad), ['--out', outFile]);
  assert.equal(proc.status, 1);
  assert.equal(proc.stdout, '');
  assert.match(proc.stderr, /invalid op/);
  assert.equal(existsSync(outFile), false);
});

test('CLI --out writes the full report atomically on success', () => {
  const probe = runCli(JSON.stringify(OPS));
  const outFile = join(probe.dir, 'out.json');
  const proc = runCli(JSON.stringify(OPS), ['--out', outFile]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stdout, '');
  const out = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(out.ok, true);
  assert.equal(verifyHashChain(out.log, 0), true);
});
