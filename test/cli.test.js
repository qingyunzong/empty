import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));

function run(args, { input } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    input,
    encoding: 'utf8',
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'downtime-cli-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('CLI: ingest/query/diff happy path exits 0', () => {
  withTempDir((dir) => {
    const state = join(dir, 'state.json');

    const ingest = run(['ingest', '--state', state, '--file', join(EXAMPLES, 'scenario1-causal-out-of-order.json')]);
    assert.equal(ingest.status, 0, ingest.stderr);
    const ingestOut = JSON.parse(ingest.stdout);
    assert.equal(ingestOut.ok, true);
    assert.equal(ingestOut.version, 1);
    assert.equal(ingestOut.added.length, 4);

    // Re-ingesting the same file is idempotent.
    const again = run(['ingest', '--state', state, '--file', join(EXAMPLES, 'scenario1-causal-out-of-order.json')]);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).version, 1);
    assert.equal(JSON.parse(again.stdout).duplicates.length, 4);

    const query = run(['query', '--state', state]);
    assert.equal(query.status, 0, query.stderr);
    const queryOut = JSON.parse(query.stdout);
    assert.equal(queryOut.devices['pump-1'].status, 'determined');
    assert.equal(queryOut.devices['pump-1'].downtimeMs, 1000);

    const late = run(['ingest', '--state', state, '--file', join(EXAMPLES, 'late-correction.json')]);
    assert.equal(late.status, 0, late.stderr);
    assert.equal(JSON.parse(late.stdout).version, 2);

    const diff = run(['diff', '--state', state, '--from', '1', '--to', '2']);
    assert.equal(diff.status, 0, diff.stderr);
    const diffOut = JSON.parse(diff.stdout);
    assert.equal(diffOut.corrections.length, 1);
    assert.deepEqual(diffOut.changes['pump-1'].downtimeMs, { from: 1000, to: 1400 });
  });
});

test('CLI: schema errors exit 1', () => {
  withTempDir((dir) => {
    const state = join(dir, 'state.json');
    const bad = run(['ingest', '--state', state, '--file', join(EXAMPLES, 'invalid-schema.json')]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /schema validation failed/);
    assert.match(bad.stderr, /state/);
  });
});

test('CLI: schema errors from stdin payload exit 1 and write nothing', () => {
  withTempDir((dir) => {
    const state = join(dir, 'state.json');
    const bad = run(['ingest', '--state', state], {
      input: '{"id":"x","device":"d","ts":1,"state":"up","node":"A","clock":{"A":-3}}\n',
    });
    assert.equal(bad.status, 1);
    const query = run(['query', '--state', state]);
    assert.equal(query.status, 0);
    assert.equal(JSON.parse(query.stdout).eventCount, 0);
  });
});

test('CLI: NDJSON input and watermark query', () => {
  withTempDir((dir) => {
    const state = join(dir, 'state.json');
    const ndjson = [
      JSON.stringify({ id: 'n1', device: 'd', ts: 100, state: 'down', node: 'A', clock: { A: 1 } }),
      JSON.stringify({ id: 'n2', device: 'd', ts: 400, state: 'up', node: 'A', clock: { A: 2 } }),
    ].join('\n');
    const ingest = run(['ingest', '--state', state], { input: ndjson });
    assert.equal(ingest.status, 0, ingest.stderr);

    const query = run(['query', '--state', state, '--watermark', '1000', '--device', 'd']);
    assert.equal(query.status, 0, query.stderr);
    const out = JSON.parse(query.stdout);
    assert.equal(out.devices.d.downtimeMs, 300);
    assert.equal(out.devices.d.availability, 1 - 300 / 900);
  });
});

test('CLI: unknown command exits 2', () => {
  const result = run(['frobnicate']);
  assert.equal(result.status, 2);
});
