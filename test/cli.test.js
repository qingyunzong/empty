import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { T0, MIN } from '../testlib/helpers.js';

function mockStreams() {
  const out = { text: '', write(chunk) { this.text += chunk; } };
  const err = { text: '', write(chunk) { this.text += chunk; } };
  return { out, err };
}

async function setupInput(lines) {
  const dir = await mkdtemp(path.join(tmpdir(), 'cold-'));
  const inputDir = path.join(dir, 'in');
  const outputDir = path.join(dir, 'out');
  await mkdir(inputDir, { recursive: true });
  await writeFile(path.join(inputDir, 'events.jsonl'), `${lines.join('\n')}\n`);
  return { inputDir, outputDir };
}

const LINES = [
  JSON.stringify({ type: 'temp', id: 't1', eventTs: T0, zone: 'A', c: -10 }),
  JSON.stringify({ type: 'door', id: 'd1', eventTs: T0 + 30_000, zone: 'A', open: true }),
  JSON.stringify({ type: 'temp', id: 't2', eventTs: T0 + MIN, zone: 'A', c: -20 }),
  JSON.stringify({ type: 'temp', id: 't3', eventTs: T0 + 10 * MIN, zone: 'A', c: -9 }),
  JSON.stringify({ type: 'temp', id: 't4', eventTs: T0 + 11 * MIN, zone: 'A', c: -20 }),
  JSON.stringify({ type: 'ship', id: 's1', eventTs: T0 + 12 * MIN, lot: 'L1', zone: 'A', start: T0 - MIN, end: T0 + 2 * MIN }),
  JSON.stringify({ type: 'ship', id: 's2', eventTs: T0 + 12 * MIN + 1, lot: 'L2', zone: 'A', start: T0 + 10 * MIN, end: T0 + 12 * MIN }),
  JSON.stringify({ type: 'temp', id: 't5', eventTs: T0 - 60 * MIN, zone: 'A', c: -10 }),
];

test('cold recall writes recall.json, evidence.jsonl, unexplained.jsonl, late.log', async () => {
  const { inputDir, outputDir } = await setupInput(LINES);
  const { out } = mockStreams();
  const code = await main(['recall', '--in', inputDir, '--out', outputDir], { stdout: out, stderr: mockStreams().err });
  assert.equal(code, 0);
  assert.match(out.text, /recall complete/);

  const files = await readdir(outputDir);
  for (const name of ['recall.json', 'evidence.jsonl', 'unexplained.jsonl', 'late.log']) {
    assert.ok(files.includes(name), `missing ${name}`);
  }

  const recall = JSON.parse(await readFile(path.join(outputDir, 'recall.json'), 'utf8'));
  assert.equal(recall.minimalSize, 1);
  assert.deepEqual(recall.solutions, [['L2']]);
  assert.equal(recall.counts.explainedWindows, 1);
  assert.equal(recall.counts.unexplainedWindows, 1);
  assert.equal(recall.counts.lateEvents, 1);
  assert.equal(recall.watermark, T0 + 12 * MIN + 1 - 2 * MIN);

  const evidence = (await readFile(path.join(outputDir, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].lot, 'L2');
  assert.equal(evidence[0].reason, 'temp-exceedance');

  const unexplained = (await readFile(path.join(outputDir, 'unexplained.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(unexplained.length, 1);
  assert.deepEqual(unexplained[0].lots, ['L2']);

  const late = (await readFile(path.join(outputDir, 'late.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(late.length, 1);
  assert.equal(late[0].event.id, 't5');
});

test('empty anomaly input produces empty recall set, not an error', async () => {
  const { inputDir, outputDir } = await setupInput([
    JSON.stringify({ type: 'temp', id: 't1', eventTs: T0, zone: 'A', c: -20 }),
    JSON.stringify({ type: 'ship', id: 's1', eventTs: T0 + MIN, lot: 'L1', zone: 'A', start: T0, end: T0 + MIN }),
  ]);
  const code = await main(['recall', '--in', inputDir, '--out', outputDir], mockStreams() && {
    stdout: mockStreams().out,
    stderr: mockStreams().err,
  });
  assert.equal(code, 0);
  const recall = JSON.parse(await readFile(path.join(outputDir, 'recall.json'), 'utf8'));
  assert.equal(recall.minimalSize, 0);
  assert.deepEqual(recall.solutions, [[]]);
  assert.deepEqual(recall.lots, []);
  const evidence = await readFile(path.join(outputDir, 'evidence.jsonl'), 'utf8');
  assert.equal(evidence, '');
});

test('out-of-range temperature exits non-zero with TEMP_RANGE', async () => {
  const { inputDir, outputDir } = await setupInput([
    JSON.stringify({ type: 'temp', id: 't1', eventTs: T0, zone: 'A', c: -999 }),
  ]);
  const { out, err } = mockStreams();
  const code = await main(['recall', '--in', inputDir, '--out', outputDir], { stdout: out, stderr: err });
  assert.equal(code, 1);
  assert.match(err.text, /TEMP_RANGE/);
});

test('missing arguments print usage and fail', async () => {
  const { out, err } = mockStreams();
  const code = await main([], { stdout: out, stderr: err });
  assert.equal(code, 1);
  assert.match(out.text, /Usage: cold recall/);
});

test('unknown command fails with usage on stderr', async () => {
  const { out, err } = mockStreams();
  const code = await main(['frobnicate'], { stdout: out, stderr: err });
  assert.equal(code, 1);
  assert.match(err.text, /unknown command/);
});
