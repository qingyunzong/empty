import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { main } from '../src/cli.js';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Runs the CLI entry point with captured I/O (no subprocess needed).
function runCli(args, { stdin, files = {} } = {}) {
  const out = [];
  const err = [];
  const code = main(args, {
    readStdin: () => {
      if (stdin === undefined) throw new Error('no stdin provided');
      return stdin;
    },
    readFile: (f) => files[f] ?? readFileSync(f, 'utf8'),
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test('CLI prints the full report for a valid input file', () => {
  const res = runCli([path.join(rootDir, 'examples', 'reclaim.json')]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.nodes));
  assert.ok(Array.isArray(report.borrowChain));
  assert.ok(Array.isArray(report.preemptions));
  assert.ok(Array.isArray(report.schedule));
  assert.equal(report.preemptions.length, 2);
});

test('CLI reads JSON from stdin', () => {
  const stdin = JSON.stringify({
    tenants: [
      { id: 'root', parent: null, guarantee: 1 },
      { id: 'A', parent: 'root', guarantee: 1 },
      { id: 'B', parent: 'root', guarantee: 0 },
    ],
    orders: [{ id: 'o1', tenant: 'B', duration: 1 }],
  });
  const res = runCli([], { stdin });
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.borrowChain.length, 1);
  assert.equal(report.borrowChain[0].lender, 'A');
});

test('CLI exits non-zero with a structured error on invalid tenants', () => {
  const stdin = JSON.stringify({
    tenants: [
      { id: 'A', parent: 'B', guarantee: 1 },
      { id: 'B', parent: 'A', guarantee: 1 },
    ],
  });
  const res = runCli([], { stdin });
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'TENANT_CYCLE');
});

test('CLI exits non-zero on malformed JSON', () => {
  const res = runCli([], { stdin: '{not json' });
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'INVALID_JSON');
});

test('CLI exits non-zero when the input file cannot be read', () => {
  const res = runCli(['/no/such/file.json']);
  assert.equal(res.code, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'READ_ERROR');
});
