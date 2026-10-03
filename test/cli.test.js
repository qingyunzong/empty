import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/replica.js');

function runCli(lines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr}`));
      resolve(stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    });
    child.stdin.write(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    child.stdin.end();
  });
}

test('CLI: JSONL in, JSON out, full membership lifecycle', async () => {
  const out = await runCli([
    { cmd: 'join', node: 'n1' },
    { cmd: 'join', node: 'n2' },
    { cmd: 'join', node: 'n3' },
    { cmd: 'join', node: 'n3' },              // idempotent
    { cmd: 'write', node: 'n1', key: 'temp', value: 21.5, epoch: 3 },
    { cmd: 'write', node: 'n1', key: 'temp', value: 99, epoch: 1 }, // stale epoch
    { cmd: 'read', node: 'n2', key: 'temp', epoch: 3 },
    { cmd: 'leave', node: 'n3' },
    { cmd: 'write', node: 'n3', key: 'temp', value: 1, epoch: 4 },  // tombstoned
    { cmd: 'repair' },
    { cmd: 'status' },
  ]);

  assert.deepEqual(out.map((o) => o.ok), [
    true, true, true, true, true, false, true, true, false, true, true,
  ]);

  assert.equal(out[3].result.idempotent, true);
  assert.equal(out[3].result.epoch, 3);

  assert.equal(out[4].result.acks, 3);
  assert.equal(out[5].error, 'EPOCH_MISMATCH');

  assert.equal(out[6].result.value, 21.5);
  assert.deepEqual(out[6].result.certificate.signers, ['n1', 'n2', 'n3']);
  assert.equal(out[6].result.certificate.epoch, 3);

  assert.equal(out[7].result.epoch, 4);
  assert.equal(out[8].error, 'NOT_MEMBER');

  const status = out[10].result;
  assert.equal(status.epoch, 4);
  const n3 = status.members.find((m) => m.id === 'n3');
  assert.equal(n3.status, 'tombstone');
  assert.equal(n3.leftEpoch, 4);
});

test('CLI: partition then heal + repair recovers majority value', async () => {
  const out = await runCli([
    { cmd: 'join', node: 'a' },
    { cmd: 'join', node: 'b' },
    { cmd: 'join', node: 'c' },
    { cmd: 'join', node: 'd' },
    { cmd: 'join', node: 'e' },
    { cmd: 'partition', groups: [['a', 'b', 'c'], ['d', 'e']] },
    { cmd: 'write', node: 'a', key: 'k', value: 'majority', epoch: 5 },
    { cmd: 'write', node: 'd', key: 'k', value: 'minority', epoch: 5 },
    { cmd: 'heal' },
    { cmd: 'repair' },
    { cmd: 'read', node: 'e', key: 'k', epoch: 5 },
  ]);
  assert.equal(out[6].ok, true);
  assert.equal(out[7].ok, false);
  assert.equal(out[7].error, 'QUORUM_FAIL');
  assert.equal(out[10].result.value, 'majority');
  assert.equal(out[10].result.certificate.signers.length, 5);
});
