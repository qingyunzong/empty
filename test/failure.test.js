import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from '../src/engine.js';
import { VersionStore } from '../src/versions.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

function runCli(input) {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-cli-'));
  const inputPath = join(dir, 'input.json');
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  writeFileSync(inputPath, JSON.stringify(input));
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  const result = spawnSync(process.execPath, [CLI, inputPath], {
    stdio: ['ignore', outFd, errFd],
    timeout: 15000,
  });
  return {
    status: result.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

test('deep missing field fails the whole materialization', () => {
  assert.throws(
    () => materialize('prefix {{ a.b.c.d }} suffix', { a: { b: {} } }),
    (err) => err.code === 'MISSING_FIELD',
  );
});

test('unclosed scope block fails the whole materialization', () => {
  assert.throws(
    () => materialize('{% scope s %}never rendered', { s: {} }),
    (err) => err.code === 'UNCLOSED_BLOCK',
  );
});

test('filter on an unsupported type fails the whole materialization', () => {
  assert.throws(
    () => materialize('{{ 1 | upper }}', {}),
    (err) => err.code === 'FILTER_TYPE',
  );
});

test('failed materialization leaves the patch version unchanged', () => {
  const store = new VersionStore('{{ a.b.c }}', { a: {} });
  store.applyPatch({ op: 'set', name: 'x', value: 1 });
  const before = store.version;
  assert.throws(() => materialize(store.current().template, store.current().variables));
  assert.equal(store.version, before);
});

test('CLI prints nothing to stdout when a deep field is missing', () => {
  const input = {
    template: 'partial-output {{ a.b.c.d }} should never appear',
    variables: { a: { b: {} } },
  };
  const result = runCli(input);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  const report = JSON.parse(result.stderr);
  assert.equal(report.error.code, 'MISSING_FIELD');
  assert.equal(report.version, 0);
});

test('CLI renders a patched template and reports version and hash', () => {
  const input = {
    template: 'Hello, {{ name }}!',
    variables: {},
    patches: [{ op: 'set', name: 'name', value: 'world' }],
  };
  const result = runCli(input);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.version, 1);
  assert.equal(report.output, 'Hello, world!');
  assert.match(report.hash, /^[0-9a-f]{64}$/);
});
