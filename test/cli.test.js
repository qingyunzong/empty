import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MIN = 60 * 1000;

// NOTE: this sandboxed environment drops piped stdout of spawned children,
// so the child's stdout is redirected to a file via an inherited fd instead.
function runCli(args, stdoutPath) {
  return open(stdoutPath, 'w').then(
    (handle) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['src/cli.js', ...args], {
          stdio: ['ignore', handle.fd, 'ignore'],
        });
        child.on('error', reject);
        child.on('close', (code) => {
          handle.close().then(() => resolve(code), reject);
        });
      }),
  );
}

test('cli processes a jsonl event file and prints pane results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flux-cli-'));
  const file = join(dir, 'events.jsonl');
  const lines = [
    { type: 'CALIBRATION', op: 'UPSERT', id: 'cal-low', sensorId: 'gh-1', version: 1, effectiveFrom: 0, expireAt: 10 * MIN, factor: 2 },
    { type: 'CALIBRATION', op: 'UPSERT', id: 'cal-high', sensorId: 'gh-1', version: 2, effectiveFrom: 10 * MIN, expireAt: 20 * MIN, factor: 4 },
    { type: 'FLUX', op: 'UPSERT', id: 's3', sensorId: 'gh-1', ts: 12 * MIN, value: 30 },
    { type: 'FLUX', op: 'UPSERT', id: 's1', sensorId: 'gh-1', ts: 2 * MIN, value: 10 },
    { type: 'FLUX', op: 'UPSERT', id: 's2', sensorId: 'gh-1', ts: 8 * MIN, value: 20 },
  ];
  await writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const outPath = join(dir, 'out.jsonl');
  const code = await runCli(['flux', '--in', file], outPath);
  assert.equal(code, 0);
  const stdout = await readFile(outPath, 'utf8');
  const outputs = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const adds = outputs.filter((o) => o.type === 'ADD' && o.pane === 'gh-1#0');
  const final = adds[adds.length - 1];
  assert.equal(final.weightedFlux, 60);
  assert.deepEqual(final.segments.map((s) => s.version), [1, 2]);
  assert.deepEqual(final.evidence, ['s1', 's2', 's3']);
});

test('cli rejects a missing --in argument', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flux-cli-'));
  const code = await runCli(['flux'], join(dir, 'out.txt'));
  assert.equal(code, 2);
});
