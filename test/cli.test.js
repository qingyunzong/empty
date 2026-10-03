'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../cli');
const { tmpdir } = require('./helpers');

// Invokes the CLI in-process (the sandbox forbids nested spawns) and
// captures stdout/stderr exactly as the real entrypoint would print them.
async function cli(dir, args) {
  const out = [];
  const err = [];
  const code = await run(['--db', dir, ...args], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
  });
  return {
    code,
    err,
    json: out.filter((l) => l.startsWith('{') || l.startsWith('[')).map(JSON.parse),
  };
}

test('cli: add/find/scan/update/remove/rebuild-index/compact flow', async () => {
  const dir = tmpdir();

  let r = await cli(dir, ['add', '--id', 'B1', '--type', 'blood', '--date', '2024-01-15', '--location', 'freezer-A1', '--status', 'stored']);
  assert.equal(r.code, 0);
  await cli(dir, ['add', '--id', 'B2', '--type', 'blood', '--date', '2024-02-20']);
  await cli(dir, ['add', '--id', 'D1', '--type', 'dna', '--date', '2024-02-01']);

  // duplicate add -> DUP
  r = await cli(dir, ['add', '--id', 'B1', '--type', 'blood', '--date', '2024-01-15']);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /ERROR DUP/);

  // find
  r = await cli(dir, ['find', '--id', 'B1']);
  assert.deepEqual(r.json[0], {
    id: 'B1', type: 'blood', date: '2024-01-15', location: 'freezer-A1', status: 'stored',
  });

  // find missing -> NOT_FOUND
  r = await cli(dir, ['find', '--id', 'ZZZ']);
  assert.equal(r.code, 1);
  assert.match(r.err[0], /ERROR NOT_FOUND/);

  // update
  r = await cli(dir, ['update', '--id', 'B2', '--status', 'in-use']);
  assert.equal(r.code, 0);
  r = await cli(dir, ['find', '--id', 'B2']);
  assert.equal(r.json[0].status, 'in-use');

  // update missing -> NOT_FOUND
  r = await cli(dir, ['update', '--id', 'ZZZ', '--status', 'x']);
  assert.match(r.err[0], /ERROR NOT_FOUND/);

  // scan by type
  r = await cli(dir, ['scan', '--type', 'blood']);
  assert.equal(r.json[0].count, 2);
  assert.deepEqual(r.json.slice(1).map((x) => x.id), ['B1', 'B2']);

  // scan by date range
  r = await cli(dir, ['scan', '--from', '2024-02-01', '--to', '2024-02-29']);
  assert.equal(r.json[0].count, 2);
  assert.deepEqual(r.json.slice(1).map((x) => x.id), ['D1', 'B2']);

  // rebuild-index + compact
  r = await cli(dir, ['rebuild-index']);
  assert.deepEqual(r.json[0], { ok: true, rebuilt: ['by_type', 'by_date'] });
  r = await cli(dir, ['compact']);
  assert.equal(r.json[0].ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'wal-2.log'), 'utf8'), '');

  // data survives compact
  r = await cli(dir, ['find', '--id', 'B1']);
  assert.equal(r.json[0].type, 'blood');

  // remove
  r = await cli(dir, ['remove', '--id', 'D1']);
  assert.equal(r.code, 0);
  r = await cli(dir, ['find', '--id', 'D1']);
  assert.match(r.err[0], /ERROR NOT_FOUND/);
});
