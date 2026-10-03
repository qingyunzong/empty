'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/state');
const engine = require('../src/engine');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evpack-'));
}

function makeConfig(overrides) {
  return {
    workers: [
      { id: 'w-hi', throughput: 10, maxClassification: 3 },
      { id: 'w-lo', throughput: 6, maxClassification: 1 },
    ],
    waitThreshold: 5,
    quotas: { t1: 100, t2: 100, hog: 100, waiter: 100 },
    ...(overrides || {}),
  };
}

function makeStore() {
  return new Store(tmpDir());
}

let seqCounter = 0;
function submitEvent(packId, overrides) {
  seqCounter += 1;
  return {
    lamport: seqCounter,
    client: 'test-client',
    hash: 'h-' + packId,
    packId,
    tenant: 't1',
    size: 2,
    classification: 1,
    chain: engine.buildChain(packId, 2),
    submitter: 'tester',
    deadline: 50,
    ...(overrides || {}),
  };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { tmpDir, makeConfig, makeStore, submitEvent, mulberry32, engine, Store };
