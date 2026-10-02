import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'settle-cli-'));
  return {
    dir,
    state: join(dir, 'state.jsonl'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function capture() {
  return { out: '', err: '' };
}

function ioOf(captured) {
  return {
    stdout: { write: (text) => (captured.out += text) },
    stderr: { write: (text) => (captured.err += text) },
  };
}

function runCliIn(ws, command, payload) {
  const input = join(ws.dir, `${command}-in.json`);
  const output = join(ws.dir, `${command}-out.json`);
  writeFileSync(input, JSON.stringify(payload));
  const captured = capture();
  const code = runCli(
    [command, '--input', input, '--output', output, '--state', ws.state],
    ioOf(captured),
  );
  return { code, captured, output };
}

test('CLI persists state in JSONL and reports errors as JSON with exit code 1', () => {
  const ws = makeWorkspace();
  try {
    const created = runCliIn(ws, 'create', {
      batchId: 'CLI-1',
      requestId: 'cli-create',
      entries: [
        { accountId: 'acc-a', amount: 100 },
        { accountId: 'acc-b', amount: -100 },
      ],
    });
    assert.equal(created.code, 0, created.captured.err);
    assert.equal(JSON.parse(readFileSync(created.output, 'utf8')).ok, true);

    const corrected = runCliIn(ws, 'correct', {
      batchId: 'CLI-1',
      baseVersion: 1,
      requestId: 'cli-corr',
      corrections: [{ op: 'add', accountId: 'acc-a', amount: 5 }],
    });
    assert.equal(corrected.code, 0, corrected.captured.err);

    // Same requestId again: idempotent replay, no new JSONL line.
    const linesBefore = readFileSync(ws.state, 'utf8').trim().split('\n').length;
    const duplicate = runCliIn(ws, 'correct', {
      batchId: 'CLI-1',
      baseVersion: 1,
      requestId: 'cli-corr',
      corrections: [{ op: 'add', accountId: 'acc-a', amount: 5 }],
    });
    assert.equal(duplicate.code, 0, duplicate.captured.err);
    assert.deepEqual(
      JSON.parse(readFileSync(duplicate.output, 'utf8')).result,
      JSON.parse(readFileSync(corrected.output, 'utf8')).result,
    );
    assert.equal(readFileSync(ws.state, 'utf8').trim().split('\n').length, linesBefore);

    // Stale version with a fresh requestId: VERSION_CONFLICT, exit code 1, JSON on stderr.
    const stale = runCliIn(ws, 'correct', {
      batchId: 'CLI-1',
      baseVersion: 1,
      requestId: 'cli-stale',
      corrections: [{ op: 'add', accountId: 'acc-a', amount: 1 }],
    });
    assert.equal(stale.code, 1);
    const errorPayload = JSON.parse(stale.captured.err);
    assert.equal(errorPayload.ok, false);
    assert.equal(errorPayload.error.code, 'VERSION_CONFLICT');

    const confirmed = runCliIn(ws, 'confirm', { batchId: 'CLI-1', requestId: 'cli-confirm' });
    assert.equal(confirmed.code, 0, confirmed.captured.err);
    const certificate = JSON.parse(readFileSync(confirmed.output, 'utf8')).result.certificate;
    assert.equal(certificate.version, 2);
    assert.match(certificate.hash, /^[0-9a-f]{64}$/);

    const revoked = runCliIn(ws, 'revoke', { batchId: 'CLI-1', requestId: 'cli-revoke' });
    assert.equal(revoked.code, 0, revoked.captured.err);
    const revokeResult = JSON.parse(readFileSync(revoked.output, 'utf8')).result;
    assert.equal(revokeResult.state, 'COMPENSATED');
    for (const net of revokeResult.nets) {
      assert.equal(net.amount, 0);
    }

    const audit = runCliIn(ws, 'audit', { batchId: 'CLI-1' });
    assert.equal(audit.code, 0, audit.captured.err);
    const trail = JSON.parse(readFileSync(audit.output, 'utf8')).result;
    assert.deepEqual(
      trail.map((event) => event.type),
      ['BATCH_CREATED', 'CORRECTION_APPLIED', 'BATCH_CONFIRMED', 'COMPENSATION_APPLIED'],
    );
  } finally {
    ws.cleanup();
  }
});
