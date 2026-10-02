'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildRules, replay, digestEntries } = require('../lib/core');
const { sync } = require('../lib/sync');
const { loadLedger, ledgerPath, positionPath } = require('../lib/store');
const { mulberry32, makeTmpDir, writeNdjson, runCli } = require('./helpers');

const RANGE = 100000;

function genDataset(seed) {
  const rng = mulberry32(seed);
  // 50 rule versions, overlapping windows, priorities declared
  const ruleEvents = [];
  for (let i = 0; i < 50; i++) {
    const from = i * 2000;
    ruleEvents.push({
      op: 'add',
      ruleId: `r${i}`,
      validFrom: from,
      validTo: from + 4000 + Math.floor(rng() * 2000),
      rateBps: 50 + Math.floor(rng() * 450),
      priority: i,
    });
  }
  for (let i = 0; i < 10; i++) {
    ruleEvents.push({ op: 'revoke', ruleId: `r${i * 3}`, at: i * 2000 + 3000 });
  }
  const txs = [];
  for (let i = 0; i < 10000; i++) {
    txs.push({ txId: `t${i}`, ts: Math.floor(rng() * RANGE), amount: 1 + Math.floor(rng() * 1000000) });
  }
  return { ruleEvents, txs };
}

function setup(dir, ruleEvents, txs) {
  const rulesPath = path.join(dir, 'rules.ndjson');
  const txPath = path.join(dir, 'tx.ndjson');
  const stateDir = path.join(dir, 'state');
  writeNdjson(rulesPath, ruleEvents);
  writeNdjson(txPath, txs);
  return { rulesPath, txPath, stateDir };
}

test('acceptance 1: 10k txs across 50 rule versions, interval replay hash equals full', () => {
  const dir = makeTmpDir();
  const { ruleEvents, txs } = genDataset(17);
  const { rulesPath, txPath, stateDir } = setup(dir, ruleEvents, txs);

  const result = sync({ rulesPath, txPath, stateDir });
  assert.equal(result.processed, 10000);

  const rules = buildRules(ruleEvents);
  const full = replay(rules, txs, 0, RANGE);

  // replay 10 adjacent intervals; concatenated digest must equal the full digest
  const concat = [];
  for (let k = 0; k < 10; k++) {
    const part = replay(rules, txs, k * (RANGE / 10), (k + 1) * (RANGE / 10));
    concat.push(...part.entries);
  }
  assert.equal(digestEntries(concat), full.hash);

  // incrementally-built ledger must equal a from-scratch full replay
  const ledger = loadLedger(stateDir);
  const ledgerEntries = [...ledger.values()].filter((e) => e.ts >= 0 && e.ts < RANGE);
  assert.equal(ledgerEntries.length, full.count);
  assert.equal(digestEntries(ledgerEntries), full.hash);

  // every interval also matches the ledger individually (incremental == replay)
  for (let k = 0; k < 10; k++) {
    const from = k * (RANGE / 10);
    const to = (k + 1) * (RANGE / 10);
    const part = replay(rules, txs, from, to);
    const inLedger = ledgerEntries.filter((e) => e.ts >= from && e.ts < to);
    assert.equal(digestEntries(inLedger), part.hash, `interval ${k}`);
  }
});

test('acceptance 2: kill before checkpoint write, recovery does not duplicate backfill', () => {
  const dir = makeTmpDir();
  const { ruleEvents, txs } = genDataset(23);
  const subset = txs.slice(0, 500);
  const { rulesPath, txPath, stateDir } = setup(dir, ruleEvents, subset);

  // crash after ledger flush, before position write
  const crashed = sync({ rulesPath, txPath, stateDir, crashBeforeCheckpoint: true });
  assert.equal(crashed.processed, 500);
  assert.equal(fs.existsSync(positionPath(stateDir)), false, 'no checkpoint written');

  // recover: reprocesses from offset 0, dedupe by txId must prevent duplicates
  const recovered = sync({ rulesPath, txPath, stateDir });
  assert.equal(recovered.processed, 0);
  assert.equal(recovered.skipped, 500);

  const rawLines = fs.readFileSync(ledgerPath(stateDir), 'utf8').trim().split('\n');
  assert.equal(rawLines.length, 500, 'ledger has no duplicate appended lines');
  const ids = new Set(rawLines.map((l) => JSON.parse(l).txId));
  assert.equal(ids.size, 500);

  // backfill a tx into the already-settled range, then crash+recover again
  fs.appendFileSync(txPath, JSON.stringify({ txId: 'late-1', ts: 12345, amount: 7777 }) + '\n');
  sync({ rulesPath, txPath, stateDir, crashBeforeCheckpoint: true });
  sync({ rulesPath, txPath, stateDir });
  const ledger = loadLedger(stateDir);
  assert.equal(ledger.size, 501);
  assert.equal(ledger.get('late-1').fee, ledger.get('late-1').fee); // present exactly once
  const raw2 = fs.readFileSync(ledgerPath(stateDir), 'utf8').trim().split('\n');
  assert.equal(new Set(raw2.map((l) => JSON.parse(l).txId)).size, raw2.length);

  // ledger still equals a full replay
  const rules = buildRules(ruleEvents);
  const full = replay(rules, [...subset, { txId: 'late-1', ts: 12345, amount: 7777 }], 0, RANGE);
  assert.equal(digestEntries([...ledger.values()]), full.hash);
});

test('backfill into settled interval triggers incremental correction, not full recompute', () => {
  const dir = makeTmpDir();
  const ruleEvents = [
    { op: 'add', ruleId: 'r1', validFrom: 0, validTo: 1000, rateBps: 100, priority: 1 },
  ];
  const txs = [
    { txId: 't1', ts: 100, amount: 10000 },
    { txId: 't2', ts: 900, amount: 20000 },
  ];
  const { rulesPath, txPath, stateDir } = setup(dir, ruleEvents, txs);
  sync({ rulesPath, txPath, stateDir });

  // settle interval [0,500): only t1
  let v = runCli(['verify', '--rules', rulesPath, '--tx', txPath, '--state', stateDir, '--from', '0', '--to', '500']);
  assert.equal(JSON.parse(v.stdout).count, 1);
  assert.equal(JSON.parse(v.stdout).match, true);

  // backfill lands inside the settled interval
  fs.appendFileSync(txPath, JSON.stringify({ txId: 't3', ts: 250, amount: 5000 }) + '\n');
  const res = sync({ rulesPath, txPath, stateDir });
  assert.equal(res.processed, 1, 'only the new tx is processed');
  assert.equal(res.skipped, 0);

  // interval summary corrected incrementally and matches a full replay
  v = runCli(['verify', '--rules', rulesPath, '--tx', txPath, '--state', stateDir, '--from', '0', '--to', '500']);
  const summary = JSON.parse(v.stdout);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalFee, 150); // 100 + 50
  assert.equal(summary.match, true);
});

test('CLI sync/fee/verify end-to-end', () => {
  const dir = makeTmpDir();
  const { ruleEvents, txs } = genDataset(31);
  const { rulesPath, txPath, stateDir } = setup(dir, ruleEvents, txs.slice(0, 1000));

  const s = runCli(['sync', '--rules', rulesPath, '--tx', txPath, '--state', stateDir]);
  assert.equal(s.code, 0, s.stderr);
  assert.equal(JSON.parse(s.stdout).processed, 1000);

  const f = runCli(['fee', '--rules', rulesPath, '--tx', JSON.stringify(txs[0])]);
  assert.equal(f.code, 0, f.stderr);
  const feeOut = JSON.parse(f.stdout);
  assert.equal(feeOut.txId, txs[0].txId);

  const v = runCli(['verify', '--rules', rulesPath, '--tx', txPath, '--state', stateDir, '--from', '0', '--to', String(RANGE)]);
  assert.equal(v.code, 0, v.stderr);
  const summary = JSON.parse(v.stdout);
  assert.equal(summary.match, true);
  assert.equal(summary.count, 1000);
});
