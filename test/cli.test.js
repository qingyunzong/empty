'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-'));
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('run commands file and write result with -o', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  const output = path.join(dir, 'result.json');
  fs.writeFileSync(
    input,
    JSON.stringify({
      commands: [
        { op: 'upsert', name: 'a', type: 'const', value: 2 },
        { op: 'upsert', name: 'b', type: 'formula', expr: 'a * 10' },
        { op: 'set', name: 'a', value: 3 },
        { op: 'commit' },
      ],
    })
  );
  const res = runCli(['run', input, '-o', output]);
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.versions.length, 4);
  assert.deepEqual(result.final.values, { a: 3, b: 30 });
  assert.deepEqual(result.final.invalid, {});
  assert.equal(result.final.committed, true);
  assert.equal(result.final.certificate.seq, 4);
  assert.deepEqual(result.final.certificate.topo, ['a', 'b']);
  assert.match(result.final.certificate.hash, /^[0-9a-f]{64}$/);
});

test('without -o the result goes to stdout', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, JSON.stringify([{ op: 'upsert', name: 'x', type: 'const', value: 1 }]));
  const res = runCli(['run', input]);
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(res.stdout);
  assert.equal(result.final.values.x, 1);
});

test('invalid JSON input exits 1 with {error,code,message}', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, '{not valid json');
  const res = runCli(['run', input, '-o', path.join(dir, 'out.json')]);
  assert.equal(res.status, 1);
  const body = JSON.parse(res.stdout);
  assert.equal(body.error, true);
  assert.equal(body.code, 'INVALID_JSON');
  assert.equal(typeof body.message, 'string');
});

test('unreadable input file exits 1 with {error,code,message}', () => {
  const res = runCli(['run', path.join(tmpdir(), 'missing.json')]);
  assert.equal(res.status, 1);
  const body = JSON.parse(res.stdout);
  assert.equal(body.error, true);
  assert.equal(body.code, 'FILE_UNREADABLE');
  assert.equal(typeof body.message, 'string');
});

test('non-array document exits 1 with INVALID_INPUT', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(input, JSON.stringify({ nope: 1 }));
  const res = runCli(['run', input]);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stdout).code, 'INVALID_INPUT');
});

test('command-level errors are recorded per version and processing continues', () => {
  const dir = tmpdir();
  const input = path.join(dir, 'commands.json');
  fs.writeFileSync(
    input,
    JSON.stringify([
      { op: 'wat' },
      { op: 'upsert', name: 'a', type: 'const', value: 1 },
      { op: 'upsert', name: 'f', type: 'formula', expr: 'a +' },
      { op: 'set', name: 'a', value: 2 },
    ])
  );
  const res = runCli(['run', input]);
  assert.equal(res.status, 0, res.stderr);
  const result = JSON.parse(res.stdout);
  assert.equal(result.versions[0].status, 'error');
  assert.equal(result.versions[1].status, 'ok');
  assert.equal(result.versions[2].status, 'error');
  assert.equal(result.versions[3].status, 'ok');
  assert.equal(result.final.values.a, 2);
});
