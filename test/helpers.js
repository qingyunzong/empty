'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { encodeStream } = require('../lib/frames');
const cli = require('../cli.js');
const verify = require('../verify.js');

const CLI = path.join(__dirname, '..', 'cli.js');
const VERIFY = path.join(__dirname, '..', 'verify.js');

function ev(eventId, acct, amount, branchSeq, logicalTs, extra = {}) {
  return { type: 'event', eventId, acct, amount, branchSeq, logicalTs, ...extra };
}

function close(periodId, cutoff) {
  return { type: 'close', periodId, cutoff };
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function writeFrames(objs, dir) {
  const d = dir || tmpdir();
  const file = path.join(d, 'frames.bin');
  fs.writeFileSync(file, encodeStream(objs));
  return { dir: d, file };
}

function runCli(file, { state, env } = {}) {
  const stateDir = state || file + '.state';
  const r = cli.run([file, '--state', stateDir], env || {});
  return { status: r.code, stdout: r.out, stderr: r.err };
}

function runVerify(certPath) {
  const r = verify.run([certPath]);
  return { status: r.code, stdout: r.out, stderr: r.err };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent reference ledger: per acct apply events in branchSeq order,
// corrections as reversal+replacement. Cross-acct order cannot affect sums.
function referenceLedger(events) {
  const bal = {};
  const posted = new Map();
  const byAcct = new Map();
  for (const e of events) {
    if (!byAcct.has(e.acct)) byAcct.set(e.acct, []);
    byAcct.get(e.acct).push(e);
  }
  for (const list of byAcct.values()) {
    list.sort((a, b) => a.branchSeq - b.branchSeq);
    for (const e of list) {
      if (e.replaces) {
        const orig = posted.get(e.replaces);
        bal[orig.acct] -= orig.amount;
        posted.set(e.eventId, { acct: e.acct, amount: e.amount });
        bal[e.acct] = (bal[e.acct] || 0) + e.amount;
      } else {
        posted.set(e.eventId, { acct: e.acct, amount: e.amount });
        bal[e.acct] = (bal[e.acct] || 0) + e.amount;
      }
    }
  }
  return bal;
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

module.exports = { CLI, VERIFY, ev, close, tmpdir, writeFrames, runCli, runVerify, mulberry32, referenceLedger, permutations };
