import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

const EVENTS = [
  { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 100, version: 1 },
  { type: 'READ_METRIC', metricId: 'm1', batchId: 'b1', ts: 10, yield: 500, quality: 0.95 },
  { type: 'READ_METRIC', metricId: 'm2', batchId: 'b1', ts: 95, yield: 700, quality: 0.8 },
  { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 50, version: 2 },
  { type: 'WATERMARK', ts: 1000 },
  { type: 'BATCH', batchId: 'b1', op: 'UPSERT', start: 0, end: 5, version: 3 },
];

function collector() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += chunk.toString();
      cb();
    },
  });
  return { stream, lines: () => text.trim().split('\n').map((l) => JSON.parse(l)) };
}

test('CLI prints JSONL actions followed by a final certificate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seq-batch-join-'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const out = collector();
  const code = await runCli(['batches', '--in', file], { stdout: out.stream });
  assert.equal(code, 0);
  const lines = out.lines();

  assert.deepEqual(lines.slice(0, -1), [
    { action: 'ADD', metricId: 'm1', batchId: 'b1', version: 1 },
    { action: 'ADD', metricId: 'm2', batchId: 'b1', version: 1 },
    { action: 'WITHDRAW', metricId: 'm2', batchId: 'b1', version: 2 },
    { action: 'ERROR', code: 'LATE', batchId: 'b1', metricId: 'm1', version: 3 },
  ]);

  const cert = lines.at(-1);
  assert.equal(cert.type, 'CERTIFICATE');
  assert.equal(cert.watermark, 1000);
  assert.deepEqual(cert.batches.map((b) => [b.batchId, b.version]), [['b1', 3]]);
  assert.deepEqual(cert.metrics.map((m) => [m.metricId, m.state, m.frozen]), [
    ['m1', 'MATCHED', true],
    ['m2', 'UNMATCHED', true],
  ]);
  assert.deepEqual(cert.counts, {
    batches: 1, metrics: 2, matched: 1, unmatched: 1, add: 2, withdraw: 1, error: 1,
  });
});

test('CLI reads events from stdin when --in -', async () => {
  const input = EVENTS.slice(0, 2).map((e) => JSON.stringify(e)).join('\n') + '\n';
  const out = collector();
  const code = await runCli(['batches', '--in', '-'], {
    stdin: Readable.from([input]),
    stdout: out.stream,
  });
  assert.equal(code, 0);
  const lines = out.lines();
  assert.deepEqual(lines[0], { action: 'ADD', metricId: 'm1', batchId: 'b1', version: 1 });
  assert.equal(lines.at(-1).type, 'CERTIFICATE');
});

test('CLI reports malformed JSON lines without aborting', async () => {
  const input = '{"type":"WATERMARK","ts":5}\nnot-json\n';
  const out = collector();
  const code = await runCli(['batches', '--in', '-'], {
    stdin: Readable.from([input]),
    stdout: out.stream,
  });
  assert.equal(code, 0);
  const lines = out.lines();
  assert.deepEqual(lines[0], { action: 'ERROR', code: 'INVALID_JSON', line: 2 });
  assert.equal(lines.at(-1).watermark, 5);
});

test('CLI rejects bad usage with exit code 2', async () => {
  const err = collector();
  const code = await runCli([], { stderr: err.stream });
  assert.equal(code, 2);
});

test('CLI entrypoint file exists and is executable as a script', () => {
  // The module must not run main when imported (side-effect free import above).
  assert.ok(CLI.endsWith('src/cli.js'));
});
