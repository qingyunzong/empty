'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../cli.js');

const CLI = path.join(__dirname, '..', 'cli.js');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJournal(dir, records) {
  const p = path.join(dir, 'journal.ndjson');
  fs.writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

// In-process CLI invocation: the sandbox forbids child processes, and the
// recovery logic is identical because all durable state lives on disk.
// Real kill -9 coverage is provided by scripts/e2e_crash.sh (see RESULTS.md).
function runCli(args) {
  const r = main(args);
  return { status: r.code, stdout: r.stdout, stderr: r.stderr, signal: null };
}

function genJournal(seed, n) {
  const rng = mulberry32(seed);
  const records = [];
  const balances = {};
  const txIds = [];
  const undoneRefs = new Set();
  let seq = 1;
  let txCounter = 0;
  const accounts = ['cash', 'ar', 'ap', 'equity', 'fees', 'fx', 'vault', 'ops'];
  while (seq <= n) {
    const roll = rng();
    const acc = accounts[Math.floor(rng() * accounts.length)];
    if (roll < 0.55 || txIds.length === 0) {
      const amount = 1 + Math.floor(rng() * 100000);
      txCounter += 1;
      const txId = `tx-${txCounter}`;
      records.push({ seq, txId, op: 'credit', account: acc, amount });
      balances[acc] = (balances[acc] || 0) + amount;
      txIds.push(txId);
    } else if (roll < 0.85) {
      const cur = balances[acc] || 0;
      if (cur <= 0) continue;
      const amount = 1 + Math.floor(rng() * cur);
      txCounter += 1;
      const txId = `tx-${txCounter}`;
      records.push({ seq, txId, op: 'debit', account: acc, amount });
      balances[acc] = (balances[acc] || 0) - amount;
      txIds.push(txId);
    } else {
      const ref = txIds[Math.floor(rng() * txIds.length)];
      txCounter += 1;
      const txId = `tx-${txCounter}`;
      const target = records.find((r) => r.txId === ref);
      if (target && target.op !== 'undo' && !undoneRefs.has(ref)) {
        balances[target.account] = (balances[target.account] || 0) - (target.op === 'credit' ? target.amount : -target.amount);
        if (balances[target.account] < 0) { txCounter -= 1; continue; }
        records.push({ seq, txId, op: 'undo', ref });
        undoneRefs.add(ref);
        txIds.push(txId);
      } else {
        continue;
      }
    }
    seq += 1;
  }
  return records;
}

module.exports = { CLI, mulberry32, makeTmpDir, writeJournal, runCli, genJournal };
