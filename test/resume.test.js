'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { makePair, keyOf, writeCsv, callCliJson, readCsv } = require('./helpers');
const { makePlan } = require('../lib/plan');
const { scanDir } = require('../lib/scan');
const { loadState, mergeStates } = require('../lib/state');
const { computeChanges } = require('../lib/diff');
const { applyPlan } = require('../lib/apply');

const CHUNK = 64 * 1024;

function buildPlan(a, b) {
  const diff = computeChanges(scanDir(a), scanDir(b), mergeStates(loadState(a), loadState(b)));
  return makePlan(a, b, diff);
}

test('kill mid-copy: resume does not re-copy confirmed chunks', async (t) => {
  const { a, b } = makePair(t);
  const key = keyOf(0);
  const big = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
  writeCsv(a, key, big);

  const plan = buildPlan(a, b);
  assert.equal(plan.ops.length, 1);
  const planFile = path.join(a, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const journalPath = `${planFile}.journal.json`;

  // Run apply inside a worker thread and hard-terminate it mid-copy
  // (worker.terminate() is an abrupt kill, like SIGKILL: no cleanup runs).
  const workerCode = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { applyPlan } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'apply.js'))});
    const plan = JSON.parse(require('node:fs').readFileSync(workerData.planFile, 'utf8'));
    applyPlan(plan, { journalPath: workerData.journalPath, chunkSize: ${CHUNK}, chunkDelayMs: 15 });
    parentPort.postMessage('done');
  `;
  const worker = new Worker(workerCode, { eval: true, workerData: { planFile, journalPath } });

  // Wait until the journal confirms at least 3 chunks, then kill.
  let confirmed = 0;
  for (let i = 0; i < 2000; i++) {
    if (fs.existsSync(journalPath)) {
      try {
        const j = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const e = j[plan.ops[0].id];
        if (e && e.confirmedBytes >= 3 * CHUNK && e.status === 'in-progress') {
          confirmed = e.confirmedBytes;
          break;
        }
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(confirmed >= 3 * CHUNK, `expected >=3 confirmed chunks before kill, got ${confirmed}`);
  await worker.terminate();

  // Journal survived the kill with partial progress.
  const jAfter = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(jAfter[plan.ops[0].id].status, 'in-progress');
  assert.ok(jAfter[plan.ops[0].id].confirmedBytes >= 3 * CHUNK);

  // Resume: must continue from the confirmed offset, not from zero.
  const stats = applyPlan(plan, { journalPath, chunkSize: CHUNK });
  const r = stats.results[0];
  assert.equal(r.status, 'copied');
  assert.ok(r.resumedFrom >= 3 * CHUNK, `resume offset ${r.resumedFrom} must skip confirmed chunks`);
  assert.equal(stats.bytesWritten, big.length - r.resumedFrom, 'only unconfirmed bytes are re-written');
  assert.equal(stats.resumedBytes, r.resumedFrom);

  // Content is correct and both sides converge.
  assert.deepEqual(readCsv(b, key), big.toString());
  const diff2 = computeChanges(scanDir(a), scanDir(b), mergeStates(loadState(a), loadState(b)));
  assert.equal(diff2.changes.filter((c) => c.op !== 'none').length, 0);

  // A third run is fully idempotent.
  const stats3 = applyPlan(buildPlan(a, b), { journalPath, chunkSize: CHUNK });
  assert.equal(stats3.copied, 0);
});
