'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpDir, cli, writeConfig, snapshotOf } = require('./helpers');
const { quotaProof, computePkgHash } = require('../src/core');

const QUOTA = 100;

function setup() {
  const dir = tmpDir();
  const cfgPath = writeConfig(dir, {
    workers: [{ id: 'w1', throughput: 1, maxLevel: 3 }],
    quotas: { T: QUOTA },
    periodLength: 10,
    boostThreshold: 3,
  });
  assert.equal(cli(['init', '--dir', dir, '--config', cfgPath]).status, 0);
  return dir;
}

function batchEntry(id, submitter, lamport, client) {
  return {
    id, tenant: 'T', submitter, size: 5, level: 1, deadline: 9,
    prevHash: 'GENESIS', evidenceHash: `ev-${id}`, client, lamport,
    quotaProof: quotaProof('T', QUOTA),
  };
}

function orderKey(e) {
  return [e.lamport, e.client, computePkgHash({
    id: e.id, version: 1, tenant: e.tenant, submitter: e.submitter,
    size: e.size, level: e.level, deadline: e.deadline,
    evidenceHash: e.evidenceHash, prevHash: e.prevHash,
  })];
}

test('concurrent submissions are ordered by (lamport, client, hash)', () => {
  const dir = setup();
  const entries = [
    batchEntry('p-c', 's3', 2, 'c1'),
    batchEntry('p-b', 's2', 1, 'c2'),
    batchEntry('p-a', 's1', 1, 'c1'),
    batchEntry('p-d', 's4', 1, 'c1'),
  ];
  const batchPath = path.join(dir, 'batch.json');
  fs.writeFileSync(batchPath, JSON.stringify(entries));
  const r = cli(['submit', '--dir', dir, '--batch', batchPath]);
  assert.equal(r.status, 0, r.stderr);
  const journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const submitSeq = journal.filter((e) => e.type === 'submit').map((e) => e.payload.id);
  const expected = [...entries]
    .sort((a, b) => {
      const ka = orderKey(a);
      const kb = orderKey(b);
      for (let i = 0; i < 3; i += 1) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
      return 0;
    })
    .map((e) => e.id);
  assert.deepEqual(submitSeq, expected);
});

test('digest is deterministic across identical event streams', () => {
  const digests = [];
  for (let k = 0; k < 2; k += 1) {
    const dir = setup();
    const entries = [batchEntry('p1', 's1', 1, 'c1'), batchEntry('p2', 's2', 1, 'c2')];
    const batchPath = path.join(dir, 'batch.json');
    fs.writeFileSync(batchPath, JSON.stringify(entries));
    assert.equal(cli(['submit', '--dir', dir, '--batch', batchPath]).status, 0);
    const v = cli(['verify', '--dir', dir, '--now', '0']);
    assert.equal(v.status, 0, v.stderr);
    digests.push(v.json.digest);
  }
  assert.deepEqual(digests[0], digests[1], 'same events -> same verifiable digest');
  assert.ok(digests[0].eventsHash);
  assert.ok(digests[0].stateRoot);
  assert.equal(digests[0].rulesVersion, '1.0.0');
});
