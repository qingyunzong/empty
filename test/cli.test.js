import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

const BASE = 1_700_000_000_000 - (1_700_000_000_000 % 120_000);

function makeStreams() {
  const streams = {
    stdout: { text: '', write(chunk) { this.text += chunk; } },
    stderr: { text: '', write(chunk) { this.text += chunk; } },
  };
  return streams;
}

function runCli(argv) {
  const streams = makeStreams();
  const code = run(argv, streams);
  return { code, stdout: streams.stdout.text, stderr: streams.stderr.text };
}

function runCliWithInput(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'windows-cli-'));
  const file = join(dir, 'samples.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return runCli(['windows', '--in', file]);
}

function parseLines(text) {
  return text.trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('CLI emits JSONL pane results and stderr JSON errors', () => {
  const result = runCliWithInput([
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'a', ts: BASE, temp: 20 }),
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'b', ts: BASE, temp: 21 }),
    JSON.stringify({ type: 'RETRACT', sensorId: 's1', sampleId: 'nobody' }),
    JSON.stringify({ type: 'WATERMARK', ts: BASE + 11 * 60_000 }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  const outputs = parseLines(result.stdout);
  assert.ok(outputs.some((o) => o.op === 'ADD'));
  assert.ok(outputs.some((o) => o.op === 'CORRECTION'));
  const finals = outputs.filter((o) => o.op === 'FINAL');
  assert.equal(finals.length, 5);
  for (const pane of finals) {
    assert.equal(pane.sensorId, 's1');
    assert.equal(typeof pane.paneStart, 'number');
    assert.equal(pane.median, 20.5);
    assert.equal(typeof pane.mad, 'number');
    assert.deepEqual(pane.outlierIds, []);
    assert.match(pane.certificate, /^[0-9a-f]{64}$/);
  }
  const stderrRecords = parseLines(result.stderr);
  assert.equal(stderrRecords.length, 1);
  assert.equal(stderrRecords[0].error, 'UNKNOWN_RETRACT');
  assert.equal(stderrRecords[0].line, 3);
});

test('CLI reports BUDGET_EXCEEDED on stderr and keeps going', () => {
  const lines = [];
  for (let version = 1; version <= 9; version += 1) {
    lines.push(JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'x', ts: BASE, temp: 20 + version }));
  }
  lines.push(JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'y', ts: BASE, temp: 30 }));
  const result = runCliWithInput(lines);
  assert.equal(result.code, 0, result.stderr);
  const stderrRecords = parseLines(result.stderr);
  assert.equal(stderrRecords.length, 1);
  assert.equal(stderrRecords[0].error, 'BUDGET_EXCEEDED');
  assert.equal(stderrRecords[0].line, 9);
  assert.ok(result.stdout.trim().length > 0, 'processing continues after the rejected line');
});

test('CLI reports LATE modifications on stderr', () => {
  const result = runCliWithInput([
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'a', ts: BASE, temp: 20 }),
    JSON.stringify({ type: 'WATERMARK', ts: BASE + 11 * 60_000 }),
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'b', ts: BASE, temp: 21 }),
  ]);
  assert.equal(result.code, 0, result.stderr);
  const stderrRecords = parseLines(result.stderr);
  assert.equal(stderrRecords.length, 1);
  assert.equal(stderrRecords[0].error, 'LATE');
  assert.equal(stderrRecords[0].line, 3);
});

test('CLI exits 2 on malformed JSON input', () => {
  const result = runCliWithInput([
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'a', ts: BASE, temp: 20 }),
    '{not json',
  ]);
  assert.equal(result.code, 2);
  const stderrRecords = parseLines(result.stderr);
  assert.equal(stderrRecords.at(-1).error, 'INVALID_JSON');
  assert.equal(stderrRecords.at(-1).line, 2);
});

test('CLI exits 2 on schema-invalid events', () => {
  const result = runCliWithInput([
    JSON.stringify({ type: 'UPSERT', sensorId: 's1', sampleId: 'a', ts: BASE }),
  ]);
  assert.equal(result.code, 2);
  const stderrRecords = parseLines(result.stderr);
  assert.equal(stderrRecords[0].error, 'INVALID_EVENT');
});

test('CLI exits 2 on bad usage or unreadable input', () => {
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['windows']).code, 2);
  assert.equal(runCli(['bogus', '--in', 'x']).code, 2);
  const missing = runCli(['windows', '--in', '/nonexistent/samples.jsonl']);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stderr.trim()).error, 'INPUT_UNREADABLE');
});
