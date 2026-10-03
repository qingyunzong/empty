'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../lib/ledger');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Generate a random log: `count` entries, `corrRate` fraction of them
// corrections/tombstones, spread over `accounts` accounts.
// Returns { dir, logPath, ledger }.
function generateLog({ count, accounts, corrRate, seed, conflictEvery = 0 }) {
  const rand = mulberry32(seed);
  const dir = tmpdir('ledger-gen-');
  const logPath = path.join(dir, 'ledger.log');
  const ledger = Ledger.create(logPath);
  const baseTs = 1_700_000_000_000;
  const byAccount = new Map(); // account -> entries appended
  const stats = { posts: 0, corrections: 0, tombstones: 0, conflicts: 0 };

  for (let i = 0; i < count; i++) {
    const ts = baseTs + i * 1000;
    const account = `acct-${Math.floor(rand() * accounts)}`;
    const history = byAccount.get(account) || [];
    const isCorr = history.length > 0 && rand() < corrRate;
    if (isCorr) {
      const target = history[Math.floor(rand() * history.length)];
      const bizTime = Math.min(target.bizTime + 1 + Math.floor(rand() * 500), ts - 1);
      if (rand() < 0.05) {
        ledger.append({ type: 'tombstone', account, supersedes: target.hash }, { ts, bizTime });
        stats.tombstones++;
      } else {
        const amount = Math.floor(rand() * 100000) - 50000;
        ledger.append({ type: 'correct', account, amount, supersedes: target.hash }, { ts, bizTime });
        stats.corrections++;
        // Occasionally fire a concurrent correction at the same business time.
        if (conflictEvery > 0 && stats.corrections % conflictEvery === 0) {
          const amount2 = Math.floor(rand() * 100000) - 50000;
          ledger.append({ type: 'correct', account, amount: amount2, supersedes: target.hash }, { ts: ts + 1, bizTime });
          stats.conflicts++;
        }
      }
    } else {
      const amount = Math.floor(rand() * 100000) - 50000;
      const bizTime = ts - Math.floor(rand() * 500);
      ledger.append({ type: 'post', account, amount, bizKey: `k-${i}` }, { ts, bizTime });
      stats.posts++;
    }
    byAccount.set(account, (byAccount.get(account) || []).concat(ledger.entries[ledger.entries.length - 1]));
  }
  return { dir, logPath, ledger, stats };
}

// Independent reference applicator: folds entries in the GIVEN order using a
// "max by (bizTime, descendant, seq)" replace rule. Used to cross-check the
// library view for order-independence.
function referenceApply(accountEntries, order) {
  const byId = new Map(accountEntries.map((e) => [e.hash, e]));
  const parentOf = (e) => (e.op.supersedes != null ? byId.get(e.op.supersedes) : null);
  const isAncestor = (a, b) => {
    let cur = parentOf(b);
    while (cur) {
      if (cur.hash === a.hash) return true;
      cur = parentOf(cur);
    }
    return false;
  };
  const beats = (y, x) => {
    if (y.bizTime !== x.bizTime) return y.bizTime > x.bizTime;
    if (isAncestor(x, y)) return true;  // descendant supersedes ancestor
    if (isAncestor(y, x)) return false;
    return y.seq < x.seq;               // concurrent: earlier append wins
  };

  // group by root (business key)
  const rootOf = new Map();
  const findRoot = (e) => {
    let cur = e;
    while (parentOf(cur)) cur = parentOf(cur);
    return cur.hash;
  };
  for (const e of accountEntries) rootOf.set(e.hash, findRoot(e));

  const tips = new Map(); // rootHash -> current winner entry
  for (const idx of order) {
    const e = accountEntries[idx];
    const r = rootOf.get(e.hash);
    const tip = tips.get(r);
    if (!tip || beats(e, tip)) tips.set(r, e);
  }

  // conflicts: >1 ancestor-maximal node at max bizTime within a root tree
  const conflicts = [];
  const byRoot = new Map();
  for (const e of accountEntries) {
    const r = rootOf.get(e.hash);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(e);
  }
  for (const nodes of byRoot.values()) {
    const maxBt = Math.max(...nodes.map((n) => n.bizTime));
    let top = nodes.filter((n) => n.bizTime === maxBt);
    top = top.filter((n) => !top.some((m) => m.hash !== n.hash && isAncestor(n, m)));
    if (top.length > 1) conflicts.push(top.map((n) => n.hash).sort());
  }

  const effective = [];
  const tombstoned = [];
  for (const tip of tips.values()) {
    if (tip.op.type === 'tombstone') tombstoned.push(tip.hash);
    else effective.push(tip);
  }
  return {
    balance: effective.reduce((s, e) => s + e.op.amount, 0),
    effective: effective.map((e) => e.hash).sort(),
    tombstoned: tombstoned.sort(),
    conflicts: conflicts.map((c) => c.join(',')).sort(),
  };
}

// Random linear extension of the supersedes DAG (target before correction).
function randomValidOrder(accountEntries, rand) {
  const idxByHash = new Map(accountEntries.map((e, i) => [e.hash, i]));
  const deps = accountEntries.map((e) => (e.op.supersedes != null ? idxByHash.get(e.op.supersedes) : -1));
  const placed = new Array(accountEntries.length).fill(false);
  const order = [];
  while (order.length < accountEntries.length) {
    const available = [];
    for (let i = 0; i < accountEntries.length; i++) {
      if (!placed[i] && (deps[i] === -1 || placed[deps[i]])) available.push(i);
    }
    const pick = available[Math.floor(rand() * available.length)];
    placed[pick] = true;
    order.push(pick);
  }
  return order;
}

module.exports = { mulberry32, tmpdir, generateLog, referenceApply, randomValidOrder };
