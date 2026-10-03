import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function nullIo() {
  return { stdout: { write() {} }, stderr: { write() {} } };
}

// Acceptance 4: checkpoint -> crash -> recovery yields an identical certificate.
test('checkpoint crash recovery yields identical certificate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-sched-'));
  const part1 = [
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 10, switch: 1, quota: 100, clock: 1, node: 'n1' },
    { type: 'plan', target: 'B', pi: 'p2', window: [12, 20], value: 9, switch: 1, quota: 100, clock: 2, node: 'n1' },
    { type: 'observe', target: 'A', obs: 'O1', window: [0, 8], clock: 3, node: 'n2' },
    { type: 'checkpoint', clock: 4, node: 'n1' },
  ];
  const part2 = [
    { type: 'correct', target: 'B', window: [12, 18], clock: 5, node: 'n2' },
    { type: 'plan', target: 'C', pi: 'p2', window: [19, 30], value: 7, switch: 1, clock: 6, node: 'n1' },
    { type: 'revoke', obs: 'O1', clock: 7, node: 'n1' },
  ];
  const toJsonl = (evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const allPath = join(dir, 'all.jsonl');
  const p1Path = join(dir, 'part1.jsonl');
  const p2Path = join(dir, 'part2.jsonl');
  writeFileSync(allPath, toJsonl([...part1, ...part2]));
  writeFileSync(p1Path, toJsonl(part1));
  writeFileSync(p2Path, toJsonl(part2));

  // Run 1: no crash, single pass over the whole stream.
  assert.equal(main(['--events', allPath, '--checkpoint-file', join(dir, 'cp-full.json'), '--out', join(dir, 'full.json')], nullIo()), 0);
  // Run 2: "crash" right after the checkpoint, then recover and apply the rest.
  assert.equal(main(['--events', p1Path, '--checkpoint-file', join(dir, 'cp.json'), '--out', join(dir, 'partial.json')], nullIo()), 0);
  assert.equal(main(['--events', p2Path, '--recover', join(dir, 'cp.json'), '--checkpoint-file', join(dir, 'cp2.json'), '--out', join(dir, 'recovered.json')], nullIo()), 0);

  const full = JSON.parse(readFileSync(join(dir, 'full.json'), 'utf8'));
  const recovered = JSON.parse(readFileSync(join(dir, 'recovered.json'), 'utf8'));
  assert.equal(full.certificate.sha256, recovered.certificate.sha256, 'certificates must match');
  assert.deepEqual(full.sequence, recovered.sequence);
  assert.deepEqual(full.skipped, recovered.skipped);
});
