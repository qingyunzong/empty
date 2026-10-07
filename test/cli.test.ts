import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/app.js';

function run(args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runCli(args, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('solve prints step-by-step boards and the optimum', () => {
  const { code, out } = run(['solve', 'examples/basic.json']);
  assert.equal(code, 0);
  assert.ok(out.includes('initial board:'));
  assert.ok(out.includes('step 1: JUMP (0,0) -> (2,0)  captures (1,0)'));
  assert.ok(out.includes('step 2: JUMP (2,0) -> (4,0)  captures (3,0)'));
  assert.ok(out.includes('optimal captures : 2'));
  assert.ok(out.includes('safe upper bound : 2'));
});

test('solve writes a certificate file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcs-'));
  try {
    const certPath = join(dir, 'cert.json');
    const { code, out } = run(['solve', 'examples/toggle.json', '--quiet', '--cert', certPath]);
    assert.equal(code, 0);
    assert.ok(out.includes('self-check passed'));
    const cert = JSON.parse(readFileSync(certPath, 'utf8'));
    assert.equal(cert.optimalCaptures, 2);
    assert.equal(cert.moves.length, 2);
    assert.equal(cert.jumpSequence.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('solve can pause to a checkpoint and resume to the same optimum', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcs-'));
  try {
    const cp = join(dir, 'cp.json');
    const paused = run(['solve', 'examples/combined.json', '--quiet', '--max-pops', '2', '--checkpoint', cp]);
    assert.equal(paused.code, 0);
    assert.ok(paused.out.includes('paused'));
    const resumed = run(['resume', cp, '--quiet']);
    assert.equal(resumed.code, 0);
    const full = run(['solve', 'examples/combined.json', '--quiet']);
    const capturesOf = (s: string) => s.match(/optimal captures : (\d+)/)![1];
    assert.equal(capturesOf(resumed.out), capturesOf(full.out));
    const landingsOf = (s: string) => s.match(/jump landings    : (.+)/)![1];
    assert.equal(landingsOf(resumed.out), landingsOf(full.out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verify cross-checks all bundled examples', () => {
  for (const f of ['basic', 'toggle', 'push', 'combined']) {
    const { code, out } = run(['verify', `examples/${f}.json`]);
    assert.ok(out.includes('verify: OK'), `${f}: ${out}`);
    assert.equal(code, 0);
  }
});

test('check validates puzzles and rejects bad ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jcs-'));
  try {
    const bad = join(dir, 'bad.json');
    writeFileSync(
      bad,
      JSON.stringify({ width: 3, height: 3, start: [0, 0], directions: [[0, 0]] }),
    );
    const good = run(['check', 'examples/push.json']);
    assert.equal(good.code, 0);
    assert.ok(good.out.includes('valid puzzle'));
    const invalid = run(['check', bad]);
    assert.equal(invalid.code, 1);
    assert.ok(invalid.err.includes('zero vector'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown command exits with usage error', () => {
  const { code, err } = run(['frobnicate']);
  assert.equal(code, 2);
  assert.ok(err.includes('unknown command'));
});
