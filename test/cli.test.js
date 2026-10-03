'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runLines } = require('../src/cli-core');

// Drive the CLI core in-process: the sandbox forbids spawning child
// processes, and runLines is exactly what src/cli.js wires to stdin/stdout.
async function runCli(input) {
  const lines = Array.isArray(input) ? input : input.split('\n');
  const out = [];
  const code = await runLines(lines, (obj) => out.push(obj));
  return { code, lines: out };
}

test('feasible cycle over NDJSON stdin', async () => {
  const { code, lines } = await runCli([
    JSON.stringify({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 }),
    JSON.stringify({ op: 'add-edge', id: 'e2', from: 'B', to: 'C', lower: 1, upper: 4 }),
    JSON.stringify({ op: 'add-edge', id: 'e3', from: 'C', to: 'A', lower: 3, upper: 6 }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.equal(lines[2].ok, true);
  assert.equal(lines[2].feasible, true);
  for (const [edge, f] of Object.entries(lines[2].flows)) {
    assert.ok(Number.isInteger(f), `${edge} flow must be integral`);
  }
});

test('infeasible command reports certificate and no flows', async () => {
  const { code, lines } = await runCli([
    JSON.stringify({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 5, upper: 9 }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[0].feasible, false);
  assert.ok(!('flows' in lines[0]));
  assert.ok(lines[0].cut.violation > 0);
  assert.ok(lines[0].deficits.length > 0);
});

test('undo after update changes feasibility back', async () => {
  const { code, lines } = await runCli([
    JSON.stringify({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 2, upper: 5 }),
    JSON.stringify({ op: 'add-edge', id: 'e2', from: 'B', to: 'A', lower: 2, upper: 5 }),
    JSON.stringify({ op: 'update-edge', id: 'e3', from: 'B', to: 'A', lower: 0, upper: 1 }),
    JSON.stringify({ op: 'undo', id: 'e3' }),
    JSON.stringify({ op: 'redo', id: 'e3' }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines[1].feasible, true);
  assert.equal(lines[2].feasible, false);
  assert.equal(lines[3].feasible, true);
  assert.equal(lines[4].feasible, false);
});

test('error cases emit JSON error and exit code 1', async () => {
  const cases = [
    { input: { op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 4, upper: 2 }, code: 'LOWER_EXCEEDS_UPPER' },
    { input: { op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 0, upper: -1 }, code: 'NEGATIVE_CAPACITY' },
    { input: { op: 'update-edge', id: 'e1', from: 'A', to: 'B', upper: 1 }, code: 'UNKNOWN_NODE' },
    { input: { op: 'redo', id: 'e1' }, code: 'REDO_MISMATCH' },
    { input: { op: 'undo', id: 'e1' }, code: 'UNDO_MISMATCH' },
    { input: { op: 'bogus' }, code: 'UNKNOWN_OP' },
  ];
  for (const { input, code: expected } of cases) {
    const { code, lines } = await runCli([JSON.stringify(input)]);
    assert.equal(code, 1, `expected exit 1 for ${expected}`);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ok, false);
    assert.equal(lines[0].error.code, expected);
    assert.equal(typeof lines[0].error.message, 'string');
  }
});

test('malformed JSON line is a JSON error with exit 1', async () => {
  const { code, lines } = await runCli(['{"op":"add-edge",oops']);
  assert.equal(code, 1);
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].error.code, 'PARSE_ERROR');
});

test('processing stops at the first error', async () => {
  const { code, lines } = await runCli([
    JSON.stringify({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 0, upper: 1 }),
    JSON.stringify({ op: 'add-edge', id: 'e2', from: 'A', to: 'B', lower: 0, upper: 1 }),
    JSON.stringify({ op: 'add-edge', id: 'e3', from: 'B', to: 'A', lower: 0, upper: 1 }),
  ]);
  assert.equal(code, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[1].error.code, 'EDGE_EXISTS');
});

test('blank lines are ignored and check evaluates without mutating', async () => {
  const { code, lines } = await runCli([
    '',
    JSON.stringify({ op: 'check' }),
    '   ',
    JSON.stringify({ op: 'add-edge', id: 'e1', from: 'A', to: 'B', lower: 0, upper: 1 }),
    JSON.stringify({ op: 'check' }),
  ]);
  assert.equal(code, 0);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].flows, {});
  assert.equal(lines[2].feasible, true); // zero flow satisfies a lower-0 edge
});
