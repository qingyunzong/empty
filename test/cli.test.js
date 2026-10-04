import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, EXIT_CODES } from '../src/cli.js';

const MAIN = ['N1 G21 G90', 'M98 Psub', 'GOTO N10', 'G1 X999', 'N10 G1 X1', 'M30'].join('\n');
const SUB = ['N1 G91', 'G1 X5', 'M99'].join('\n');
const EXPECTED_TRACE = [
  'N1 G21 G90',
  'M98 Psub',
  'N1 G91',
  'G1 X5',
  'M99',
  'GOTO N10',
  'N10 G1 X1',
  'M30',
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-cli-'));
}

// Drives the real CLI entry point in-process (the sandbox forbids nested
// node spawns); captures output lines and the numeric exit code.
function run(args) {
  const stdout = [];
  const stderr = [];
  const status = runCli(args, {
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
  });
  return { status, stdout, stderr };
}

function traceLines(stdout) {
  return stdout
    .filter((l) => !/^(CONFIRMED|NEXT|DONE|BLOCKED)/.test(l))
    .map((l) => l.split(' ').slice(2).join(' '));
}

function makePackage(dir) {
  fs.writeFileSync(path.join(dir, 'main.nc'), MAIN + '\n');
  fs.writeFileSync(path.join(dir, 'sub.nc'), SUB + '\n');
  const pkg = path.join(dir, 'pkg');
  const r = run(['encode', pkg, '--main', 'main', '--block-lines', '2',
    path.join(dir, 'main.nc'), path.join(dir, 'sub.nc')]);
  assert.equal(r.status, 0, r.stderr.join('\n'));
  return pkg;
}

test('encode then verify succeeds', () => {
  const dir = tmpdir();
  const pkg = makePackage(dir);
  const v = run(['verify', pkg]);
  assert.equal(v.status, 0, v.stderr.join('\n'));
  assert.ok(v.stdout.some((l) => /OK 5 blocks verified/.test(l)));
});

test('decode prints hand-enumerated execution sequence', () => {
  const dir = tmpdir();
  const pkg = makePackage(dir);
  const d = run(['decode', pkg]);
  assert.equal(d.status, 0, d.stderr.join('\n'));
  assert.deepEqual(traceLines(d.stdout), EXPECTED_TRACE);
  assert.ok(d.stdout.includes('CONFIRMED 5'));
  assert.ok(d.stdout.includes('NEXT none'));
  assert.ok(d.stdout.includes('DONE'));
});

test('decode --from resumes at any sequence without re-executing confirmed blocks', () => {
  const dir = tmpdir();
  const pkg = makePackage(dir);
  const full = traceLines(run(['decode', pkg]).stdout);
  for (let k = 0; k <= 5; k++) {
    const r = run(['decode', pkg, '--from', String(k)]);
    assert.equal(r.status, 0, `resume from ${k}: ${r.stderr.join('\n')}`);
    const resumed = traceLines(r.stdout);
    assert.ok(resumed.length <= full.length);
    assert.deepEqual(full.slice(full.length - resumed.length), resumed, `suffix at --from ${k}`);
    assert.ok(r.stdout.includes('DONE'));
  }
});

test('corrupted block: verify and decode exit with E_CRC', () => {
  const dir = tmpdir();
  const pkg = makePackage(dir);
  const dataPath = path.join(pkg, 'data.bin');
  const data = fs.readFileSync(dataPath);
  data[12] ^= 0xff; // flip first payload byte of block 0
  fs.writeFileSync(dataPath, data);
  const v = run(['verify', pkg]);
  assert.equal(v.status, EXIT_CODES.E_CRC);
  assert.ok(v.stderr.some((l) => /E_CRC/.test(l)));
  const d = run(['decode', pkg]);
  assert.equal(d.status, EXIT_CODES.E_CRC);
  assert.ok(d.stderr.some((l) => /E_CRC/.test(l)));
});

test('over-deep nesting exits with E_DEPTH', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'main.nc'), 'M98 Pa\nM30\n');
  fs.writeFileSync(path.join(dir, 'a.nc'), 'M98 Pb\nM99\n');
  fs.writeFileSync(path.join(dir, 'b.nc'), 'G1 X1\nM99\n');
  const pkg = path.join(dir, 'pkg');
  run(['encode', pkg, '--main', 'main',
    path.join(dir, 'main.nc'), path.join(dir, 'a.nc'), path.join(dir, 'b.nc')]);
  const d = run(['decode', pkg, '--max-depth', '1']);
  assert.equal(d.status, EXIT_CODES.E_DEPTH);
  assert.ok(d.stderr.some((l) => /E_DEPTH/.test(l)));
});

test('missing subroutine exits with E_TARGET', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'main.nc'), 'M98 Pghost\nM30\n');
  const pkg = path.join(dir, 'pkg');
  run(['encode', pkg, '--main', 'main', path.join(dir, 'main.nc')]);
  const d = run(['decode', pkg]);
  assert.equal(d.status, EXIT_CODES.E_TARGET);
  assert.ok(d.stderr.some((l) => /E_TARGET/.test(l)));
});
