'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generatePair, shuffleEvents, toNdjson } = require('../src/generate');
const { parseNdjson, mergeEvents, sha256Hex } = require('../src/sync');

const SEED = 'group17';
const COUNT = 200;

function logHash(events) {
  return sha256Hex(events.map((ev) => JSON.stringify(ev)).join('\n') + '\n');
}

test('1) fixed seed, two 200-event sources, shuffled exchange order merges to identical hash', () => {
  const { a, b } = generatePair(COUNT, SEED);
  assert.equal(a.length, COUNT);
  assert.equal(b.length, COUNT);

  const aText = toNdjson(a);
  const bText = toNdjson(b);

  const variants = [
    ['orig/orig', aText, bText],
    ['orig/shuffledB', aText, toNdjson(shuffleEvents(b, `${SEED}:shB`))],
    ['shuffledA/orig', toNdjson(shuffleEvents(a, `${SEED}:shA`)), bText],
    ['shuffledA/shuffledB', toNdjson(shuffleEvents(a, `${SEED}:shA2`)), toNdjson(shuffleEvents(b, `${SEED}:shB2`))],
  ];

  const results = variants.map(([name, ta, tb]) => {
    const r = mergeEvents(parseNdjson(ta, 'a'), parseNdjson(tb, 'b'));
    return { name, hash: logHash(r.log), balance: r.balance, effective: r.effective, conflicts: r.conflicts };
  });

  const base = results[0];
  for (const r of results) {
    assert.equal(r.hash, base.hash, `log hash mismatch for ${r.name}`);
    assert.equal(r.balance, base.balance, `balance mismatch for ${r.name}`);
    assert.deepEqual(r.effective, base.effective);
    assert.deepEqual(r.conflicts, base.conflicts);
  }
  assert.equal(results.length, 4);
  assert.match(base.hash, /^[0-9a-f]{64}$/);
});
