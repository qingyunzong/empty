'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseNdjson, topoSort, mergeEvents } = require('../src/sync');

const CLI = path.join(__dirname, '..', 'cli.js');

function post(id, amount, causes = [], lamport = 1, node = 'A') {
  return { id, kind: 'post', amount, causes, lamport, node };
}
function toNdjson(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

function expectCode3(fn, label) {
  assert.throws(fn, (err) => err.code === 3, label);
}

test('errors: unknown cause, cyclic causality, non-integer amount all give code=3', () => {
  // unknown cause
  expectCode3(
    () => mergeEvents(parseNdjson(toNdjson([{ id: 'v1', kind: 'void', causes: ['ghost'], lamport: 1, node: 'A' }]), 'a'), []),
    'unknown cause'
  );

  // cyclic causality
  const cyc = toNdjson([
    { id: 'x', kind: 'void', causes: ['y'], lamport: 1, node: 'A' },
    { id: 'y', kind: 'void', causes: ['x'], lamport: 2, node: 'A' },
  ]);
  expectCode3(() => topoSort(parseNdjson(cyc, 'a')), 'cycle');

  // non-integer amounts
  expectCode3(() => parseNdjson(toNdjson([post('p1', 1.5)]), 'a'), 'float amount');
  expectCode3(() => parseNdjson(toNdjson([post('p2', '100')]), 'a'), 'string amount');
  expectCode3Safe: {
    expectCode3(() => parseNdjson(toNdjson([post('p3', NaN)]), 'a'), 'NaN amount');
  }

  // CLI exits with code 3
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-'));
  const bad = path.join(dir, 'bad.ndjson');
  const ok = path.join(dir, 'ok.ndjson');
  fs.writeFileSync(bad, toNdjson([post('p', 3.14)]));
  fs.writeFileSync(ok, toNdjson([post('q', 5)]));
  for (const [name, content] of [
    ['amount', toNdjson([post('p', 3.14)])],
    ['unknown-cause', toNdjson([{ id: 'v', kind: 'void', causes: ['nope'], lamport: 1, node: 'A' }])],
    [
      'cycle',
      toNdjson([
        { id: 'x', kind: 'void', causes: ['y'], lamport: 1, node: 'A' },
        { id: 'y', kind: 'void', causes: ['x'], lamport: 2, node: 'A' },
      ]),
    ],
  ]) {
    fs.writeFileSync(bad, content);
    const res = execFileSyncSafe(bad, ok, dir);
    assert.equal(res.status, 3, `CLI must exit 3 for ${name}, got ${res.status}: ${res.stderr}`);
  }
});

function execFileSyncSafe(bad, ok, dir) {
  const { spawnSync } = require('node:child_process');
  return spawnSync(process.execPath, [CLI, 'merge', bad, ok, '--out', path.join(dir, 'out')], {
    encoding: 'utf8',
  });
}
