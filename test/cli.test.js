import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { certIdFor } from '../src/store.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

const W = { notBefore: '2025-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' };
const T0 = '2026-01-01T00:00:00.000Z';

function runCli(lines) {
  return new Promise((resolve, reject) => {
    // The sandbox swallows grandchild stdio pipes, so relay through files.
    const dir = mkdtempSync(join(tmpdir(), 'cli-test-'));
    const inFile = join(dir, 'in.ndjson');
    const outFile = join(dir, 'out.ndjson');
    const errFile = join(dir, 'err.txt');
    writeFileSync(inFile, lines.join('\n') + '\n');
    const child = spawn(
      'sh',
      ['-c', `"${process.execPath}" "${CLI}" < "${inFile}" > "${outFile}" 2> "${errFile}"`],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        assert.equal(code, 0, readFileSync(errFile, 'utf8'));
        const stdout = readFileSync(outFile, 'utf8');
        resolve(stdout.trim().split('\n').map((line) => JSON.parse(line)));
      } catch (err) {
        reject(err);
      }
    });
  });
}

test('end-to-end: issue, verify, revoke, restore over NDJSON stdin', async () => {
  const aliceBob = {
    issuer: 'alice', subject: 'bob', maxAmount: 200,
    notBefore: W.notBefore, notAfter: W.notAfter,
  };
  const certId = certIdFor(aliceBob);
  const out = await runCli([
    JSON.stringify({ cmd: 'issue-cert', issuer: 'root', subject: 'root', maxAmount: 1000000, ...W, root: true }),
    JSON.stringify({ cmd: 'issue-cert', issuer: 'root', subject: 'alice', maxAmount: 500, ...W }),
    JSON.stringify({ cmd: 'issue-cert', ...aliceBob }),
    JSON.stringify({ cmd: 'verify-payment', payer: 'bob', payee: 'shop', amount: 100, time: T0 }),
    JSON.stringify({ cmd: 'revoke', certId, time: T0 }),
    JSON.stringify({ cmd: 'verify-payment', payer: 'bob', payee: 'shop', amount: 100, time: T0 }),
    JSON.stringify({ cmd: 'restore', revocationId: 'rev-1', time: T0 }),
    JSON.stringify({ cmd: 'verify-payment', payer: 'bob', payee: 'shop', amount: 100, time: T0 }),
  ]);
  assert.equal(out.length, 8);
  assert.ok(out[0].ok && out[1].ok && out[2].ok);

  const auth = out[3].authorization;
  assert.equal(out[3].ok, true);
  assert.equal(auth.rootId, 'root');
  assert.equal(auth.chain.length, 2);
  assert.equal(typeof auth.signature, 'string');

  assert.equal(out[4].ok, true);
  assert.equal(out[4].revocation.id, 'rev-1');

  assert.equal(out[5].ok, false);
  assert.equal(out[5].error.code, 'CERT_REVOKED');

  assert.equal(out[6].ok, true);
  assert.equal(out[6].restore.pairs, 'rev-1');

  assert.equal(out[7].ok, true);
});

test('CLI reports errors as NDJSON lines', async () => {
  const out = await runCli([
    'not json at all',
    JSON.stringify({ cmd: 'fly-to-moon' }),
    JSON.stringify({ cmd: 'issue-cert', issuer: 'x', subject: 'x', maxAmount: 1, ...W }),
    JSON.stringify({ cmd: 'verify-payment', payer: 'ghost', payee: 'shop', amount: 1, time: T0 }),
    JSON.stringify({ cmd: 'restore', certId: 'nothing' }),
  ]);
  assert.deepEqual(
    out.map((o) => o.error.code),
    ['INVALID_JSON', 'UNKNOWN_COMMAND', 'SELF_SIGNED_NON_ROOT', 'UNKNOWN_ROOT', 'RESTORE_WITHOUT_REVOKE'],
  );
  assert.ok(out.every((o) => o.ok === false));
});
