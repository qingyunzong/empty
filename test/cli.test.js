'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const { main } = require('../src/cli');

// Runs the CLI in-process while capturing stdout/stderr, so tests also work
// in sandboxes that forbid spawning child node processes.
function runCliInProcess(args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    out.push(String(chunk));
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    err.push(String(chunk));
    if (typeof rest[rest.length - 1] === 'function') rest[rest.length - 1]();
    return true;
  };
  let status;
  try {
    status = main(['node', 'cli.js', ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { status, stdout: out.join(''), stderr: err.join('') };
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genealogy-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('cli trace applies ops and writes a deterministic result file', () =>
  withTemp((dir) => {
    const events = path.join(dir, 'events.json');
    const out = path.join(dir, 'result.json');
    fs.writeFileSync(
      events,
      JSON.stringify({
        ops: [
          { op: 'append', event: { id: 'e1', output: 'A', inputs: [] } },
          { op: 'append', event: { id: 'e2', output: 'B', inputs: ['A'] } },
          { op: 'hold', batch: 'A' },
          { op: 'query', batch: 'B' },
          { op: 'query' },
        ],
      }),
    );
    const first = runCliInProcess(['trace', events, '-o', out]);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.version, 3);
    const query = result.ops.find((r) => r.op === 'query' && r.batch === 'B');
    assert.equal(query.status, 'held');
    assert.deepEqual(query.blockers, ['A']);
    assert.deepEqual(query.reasons, [{ kind: 'ancestor', source: 'A' }]);
    assert.deepEqual(query.certificate.paths, [['A', 'B']]);
    assert.match(query.certificate.hash, /^[0-9a-f]{64}$/);
    assert.equal(result.finalState.batches.B.status, 'held');
    const queryAll = result.ops.filter((r) => r.op === 'query')[1];
    assert.deepEqual(
      queryAll.batches.map((b) => b.batch),
      ['A', 'B'],
    );

    const second = runCliInProcess(['trace', events, '-o', out]);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(out, 'utf8'), JSON.stringify(result, null, 2) + '\n');
  }));

test('cli reports CYCLE with exit code 1 and keeps partial results', () =>
  withTemp((dir) => {
    const events = path.join(dir, 'events.json');
    const out = path.join(dir, 'result.json');
    fs.writeFileSync(
      events,
      JSON.stringify({
        ops: [
          { op: 'append', event: { id: 'e1', output: 'A', inputs: [] } },
          { op: 'append', event: { id: 'e2', output: 'B', inputs: ['A'] } },
          { op: 'correct', eventId: 'e1', event: { inputs: ['B'] } },
        ],
      }),
    );
    const res = runCliInProcess(['trace', events, '-o', out]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /CYCLE/);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'CYCLE');
    assert.equal(result.error.index, 2);
    assert.equal(result.ops.length, 2);
  }));

test('cli reports unknown parent batch and duplicate output', () =>
  withTemp((dir) => {
    const events = path.join(dir, 'events.json');
    const out = path.join(dir, 'result.json');
    fs.writeFileSync(
      events,
      JSON.stringify([
        { op: 'append', event: { id: 'e1', output: 'A', inputs: [] } },
        { op: 'append', event: { id: 'e2', output: 'B', inputs: ['GHOST'] } },
      ]),
    );
    let res = runCliInProcess(['trace', events, '-o', out]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /UNKNOWN_BATCH/);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).error.code, 'UNKNOWN_BATCH');

    fs.writeFileSync(
      events,
      JSON.stringify([
        { op: 'append', event: { id: 'e1', output: 'A', inputs: [] } },
        { op: 'append', event: { id: 'e2', output: 'A', inputs: [] } },
      ]),
    );
    res = runCliInProcess(['trace', events, '-o', out]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /DUPLICATE_OUTPUT/);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).error.code, 'DUPLICATE_OUTPUT');
  }));

test('cli exits 2 on usage errors and unreadable files', () =>
  withTemp((dir) => {
    assert.equal(runCliInProcess([]).status, 2);
    assert.match(runCliInProcess([]).stderr, /usage/);
    assert.equal(runCliInProcess(['nope']).status, 2);
    const res = runCliInProcess(['trace', path.join(dir, 'missing.json'), '-o', path.join(dir, 'o.json')]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /cannot load events file/);
  }));

test('cli works as a real subprocess: node src/cli.js trace events.json -o result.json', (t) =>
  withTemp((dir) => {
    const probe = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    if (probe.error && probe.error.code === 'EPERM') {
      t.skip('spawning child node processes is not permitted in this environment');
      return;
    }
    const events = path.join(dir, 'events.json');
    const out = path.join(dir, 'result.json');
    fs.writeFileSync(
      events,
      JSON.stringify({
        ops: [
          { op: 'append', event: { id: 'e1', output: 'A', inputs: [] } },
          { op: 'append', event: { id: 'e2', output: 'B', inputs: ['A'] } },
          { op: 'hold', batch: 'A' },
          { op: 'query', batch: 'B' },
        ],
      }),
    );
    const res = spawnSync(process.execPath, [CLI, 'trace', events, '-o', out], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const result = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(result.ok, true);
    const query = result.ops.find((r) => r.op === 'query');
    assert.equal(query.status, 'held');
    assert.deepEqual(query.certificate.paths, [['A', 'B']]);
  }));
