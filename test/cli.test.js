import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

// Feed NDJSON lines to the CLI and parse the NDJSON responses.
// stdio is wired through temp files so the child's output is captured reliably.
const runCli = (lines) => {
  const dir = mkdtempSync(join(tmpdir(), 'payment-net-cli-'));
  try {
    const inputPath = join(dir, 'input.ndjson');
    const outputPath = join(dir, 'output.ndjson');
    const input = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
    writeFileSync(inputPath, input === '' ? '' : `${input}\n`);
    const inputFd = openSync(inputPath, 'r');
    const outputFd = openSync(outputPath, 'w');
    const result = spawnSync(process.execPath, [CLI], { stdio: [inputFd, outputFd, 'inherit'] });
    closeSync(inputFd);
    closeSync(outputFd);
    assert.equal(result.status, 0, `cli exited with ${result.status}: ${result.stderr ?? ''}`);
    return readFileSync(outputPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('cli: NDJSON command loop', () => {
  it('drives the full acceptance flow over stdin/stdout', () => {
    const responses = runCli([
      { cmd: 'add-edge', a: 'A', b: 'B', bandwidth: 100 },
      { cmd: 'add-edge', a: 'B', b: 'C', bandwidth: 100 },
      { cmd: 'add-edge', a: 'A', b: 'D', bandwidth: 50 },
      { cmd: 'add-edge', a: 'D', b: 'C', bandwidth: 50 },
      { cmd: 'close-edge', a: 'A', b: 'B' },
      { cmd: 'cancel-batch', payments: [{ id: 'p1', from: 'A', to: 'C' }] },
      { cmd: 'open-edge', a: 'A', b: 'B' },
      { cmd: 'cancel-batch', payments: [{ id: 'p2', from: 'A', to: 'C' }] },
    ]);
    assert.deepEqual(responses.map((r) => r.ok), [true, true, true, true, true, true, true, true]);
    assert.equal(responses[4].bridgeCertificate, null);
    assert.deepEqual(responses[5].cancelled[0].path, ['A', 'D', 'C']);
    assert.deepEqual(responses[7].cancelled[0].path, ['A', 'B', 'C']);
    assert.deepEqual(responses[7].bridges, []);
  });

  it('emits a bridge certificate and fails the batch atomically', () => {
    const responses = runCli([
      { cmd: 'add-edge', a: 'A', b: 'B' },
      { cmd: 'close-edge', a: 'A', b: 'B' },
      { cmd: 'cancel-batch', payments: [{ id: 'p1', from: 'A', to: 'B' }] },
      { cmd: 'snapshot' },
    ]);
    assert.equal(responses[1].ok, true);
    assert.deepEqual(responses[1].bridgeCertificate.splitsInto, [['A'], ['B']]);
    assert.equal(responses[2].ok, false);
    assert.equal(responses[2].error.code, 'BATCH_NOT_ROUTABLE');
    assert.deepEqual(responses[3].edges, [{ a: 'A', b: 'B', bandwidth: 1, open: false }]);
  });

  it('reports validation errors as NDJSON', () => {
    const responses = runCli([
      { cmd: 'add-edge', a: 'A', b: 'A' },
      { cmd: 'add-edge', a: 'A', b: 'B' },
      { cmd: 'close-edge', a: 'A', b: 'B' },
      { cmd: 'close-edge', a: 'A', b: 'B' },
      { cmd: 'cancel-batch', payments: [] },
      { cmd: 'cancel-batch', payments: [{ id: 'p', from: 'A', to: 'ZZ' }] },
      { cmd: 'frobnicate' },
    ]);
    assert.deepEqual(
      responses.map((r) => r.error?.code),
      ['SELF_LOOP', undefined, undefined, 'EDGE_ALREADY_CLOSED', 'EMPTY_BATCH', 'BATCH_NOT_ROUTABLE', 'UNKNOWN_COMMAND'],
    );
    assert.equal(responses[5].error.details[0].code, 'UNKNOWN_NODE');
  });

  it('rejects malformed JSON lines without crashing', () => {
    const [bad, good] = runCli(['not json', '{"cmd":"add-edge","a":"A","b":"B"}']);
    assert.equal(bad.ok, false);
    assert.equal(bad.error.code, 'BAD_REQUEST');
    assert.equal(good.ok, true);
  });
});
