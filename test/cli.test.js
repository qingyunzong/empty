import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { run } from '../src/cli.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixturePath = path.join(root, 'test', 'fixtures', 'events.jsonl');

function runCli(args) {
  const out = [];
  const err = [];
  const code = run(args, {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return { code, lines: out.map((line) => JSON.parse(line)), err };
}

test('cli flux --in emits ADD/WITHDRAW/ERROR JSONL records', () => {
  const { code, lines } = runCli(['flux', '--in', fixturePath]);
  assert.equal(code, 0);
  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(['ADD', 'WITHDRAW', 'ERROR'].includes(line.type));
  }

  const paneId = 'gh-1@2026-01-01T00:00:00.000Z/2026-01-01T00:15:00.000Z';
  const paneLines = lines.filter((line) => line.pane === paneId);

  const adds = paneLines.filter((line) => line.type === 'ADD');
  const weighted = adds.find((line) => line.weightedFlux === 15.333333);
  assert.ok(weighted, 'expected ADD with cross-calibration weighted flux 15.333333');
  assert.deepEqual(weighted.evidence, ['s1', 's2', 's3']);
  assert.deepEqual(
    weighted.segments.map((segment) => segment.version),
    [1, 2],
  );

  const finalAdd = adds.at(-1);
  assert.equal(finalAdd.weightedFlux, 10);
  assert.deepEqual(
    finalAdd.segments.map((segment) => segment.version),
    [1],
  );

  const withdraw = paneLines.find((line) => line.type === 'WITHDRAW' && line.weightedFlux === 15.333333);
  assert.ok(withdraw, 'expected WITHDRAW of the v2-based result after c2 retract');

  const late = lines.find((line) => line.type === 'ERROR' && line.code === 'LATE');
  assert.ok(late, 'expected LATE error for the post-freeze insert');
  assert.equal(late.id, 's10');

  const unknown = lines.find((line) => line.type === 'ERROR' && line.code === 'UNKNOWN_RETRACT');
  assert.ok(unknown, 'expected UNKNOWN_RETRACT error');
  assert.equal(unknown.id, 'ghost');

  const malformed = lines.find((line) => line.type === 'ERROR' && line.code === 'MALFORMED');
  assert.ok(malformed, 'expected MALFORMED error for the non-JSON line');
  assert.equal(malformed.line, 10);
});

test('cli rejects unknown command and missing --in', () => {
  assert.equal(runCli(['nope']).code, 2);
  assert.equal(runCli(['flux']).code, 2);
  assert.equal(runCli(['flux', '--in', '/nonexistent/events.jsonl']).code, 1);
});
