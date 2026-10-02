'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli');

function setup(observations, corrections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corrections-cli-'));
  const obsPath = path.join(dir, 'observations.json');
  const corrPath = path.join(dir, 'corrections.json');
  fs.writeFileSync(obsPath, JSON.stringify(observations));
  fs.writeFileSync(corrPath, JSON.stringify(corrections));
  return { dir, obsPath, corrPath };
}

function runCli(argv) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = main(argv);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

test('CLI writes state.json and history.json with exit code 0', () => {
  const { dir, obsPath, corrPath } = setup(
    [{ id: 'temp', value: 20 }],
    [
      { id: 'c1', observationId: 'temp', timestamp: '2024-01-01T00:00:00Z', reason: 'DRIFT', author: 'ann', newValue: 21 },
      { id: 'c2', observationId: 'temp', timestamp: '2024-01-01T01:00:00Z', reason: 'RECOUNT', author: 'bob', newValue: 19 },
    ]
  );
  const res = runCli([obsPath, corrPath, dir]);
  assert.equal(res.code, 0);

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  const history = JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'));

  assert.equal(state.observations.temp, 19);
  assert.match(state.stateHash, /^[0-9a-f]{64}$/);
  assert.equal(history.cursor, 2);
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].before, 20);
  assert.equal(history.entries[0].after, 21);
  assert.equal(history.entries[1].before, 21);
  assert.equal(history.entries[1].after, 19);
  assert.deepEqual(history.auditMap.c1.originalIds, ['c1']);
});

test('CLI exits 1 when a correction references an unknown observation', () => {
  const { dir, obsPath, corrPath } = setup(
    [{ id: 'temp', value: 20 }],
    [{ id: 'c1', observationId: 'ghost', timestamp: 1, reason: 'R', author: 'a', newValue: 1 }]
  );
  const res = runCli([obsPath, corrPath, dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /UNKNOWN_OBSERVATION/);
  assert.ok(!fs.existsSync(path.join(dir, 'state.json')));
});

test('CLI exits 1 on out-of-order timestamps', () => {
  const { dir, obsPath, corrPath } = setup(
    [{ id: 'temp', value: 20 }],
    [
      { id: 'c1', observationId: 'temp', timestamp: '2024-02-01T00:00:00Z', reason: 'R', author: 'a', newValue: 21 },
      { id: 'c2', observationId: 'temp', timestamp: '2024-01-01T00:00:00Z', reason: 'R', author: 'a', newValue: 22 },
    ]
  );
  const res = runCli([obsPath, corrPath, dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /OUT_OF_ORDER_TIMESTAMP/);
});

test('CLI exits 1 with usage when arguments are missing', () => {
  const res = runCli([]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /usage/);
});
