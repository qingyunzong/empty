'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ledger = require('../lib/ledger');

// Deterministic PRNG (mulberry32) so the 30k-entry corpus is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 30000;
const N_KEYS = 5000;
const T0 = 1_700_000_000_000;

function generate(dir) {
  const log = path.join(dir, 'ledger.log');
  const idx = log + '.idx';
  const key = log + '.key';
  const rand = rng(42);
  const heads = new Map(); // bizKey -> [seq]
  const items = [];
  for (let i = 0; i < N; i++) {
    const logTime = T0 + i * 1000;
    const businessTime = logTime - Math.floor(rand() * 86_400_000);
    const roll = rand();
    if (i > 0 && roll < 0.05) {
      // correction (5%): supersede a random head of a random key with < 12 entries
      const candidates = [...heads.entries()].filter(([, h]) => h.length > 0 && h.length < 12);
      const [bizKey, hs] = candidates[Math.floor(rand() * candidates.length)];
      const target = hs[Math.floor(rand() * hs.length)];
      // ~20% of corrections on multi-head keys reuse a sibling head's businessTime,
      // forcing concurrent same-business-key conflicts
      let forcedBizTime;
      if (hs.length >= 2 && rand() < 0.2) {
        const sibling = hs.find((h) => h !== target);
        forcedBizTime = items[sibling].businessTime;
      }
      const op = rand() < 0.1
        ? { type: 'tombstone', account: 'acct' + Math.floor(rand() * 100), bizKey }
        : { type: rand() < 0.5 ? 'credit' : 'debit', account: 'acct' + Math.floor(rand() * 100), amount: Math.ceil(rand() * 1000), bizKey };
      if (op.type === 'tombstone') op.account = items[target].op.account;
      items.push({ op, logTime, businessTime: forcedBizTime === undefined ? businessTime : forcedBizTime, supersedes: target });
      // tombstones cannot be superseded, so they are not kept as correction targets
      const next = hs.filter((h) => h !== target);
      if (op.type !== 'tombstone') next.push(items.length - 1);
      heads.set(bizKey, next);
    } else {
      const bizKey = 'biz' + (i % N_KEYS);
      const op = { type: rand() < 0.5 ? 'credit' : 'debit', account: 'acct' + Math.floor(rand() * 100), amount: Math.ceil(rand() * 1000), bizKey };
      items.push({ op, logTime, businessTime });
      const hs = heads.get(bizKey) || [];
      hs.push(items.length - 1);
      heads.set(bizKey, hs);
    }
  }
  ledger.appendEntries(log, idx, key, items);
  return { log, idx, key, items };
}

// Enumerate every valid application order (linear extension of the supersedes
// partial order) for one business key and collect the distinct outcomes.
function enumerateOutcomes(entries) {
  const seqs = entries.map((e) => e.seq);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const deps = new Map(seqs.map((s) => [s, new Set()]));
  for (const e of entries) {
    if (e.supersedes !== null && e.supersedes !== undefined && bySeq.has(e.supersedes)) {
      deps.get(e.seq).add(e.supersedes); // target must be applied before the correction
    }
  }
  const outcomes = new Set();
  const applied = new Set();
  const active = new Set();
  const walk = () => {
    if (applied.size === seqs.length) {
      const maxBiz = Math.max(...[...active].map((s) => bySeq.get(s).businessTime));
      const winners = [...active].filter((s) => bySeq.get(s).businessTime === maxBiz).sort((a, b) => a - b);
      outcomes.add(JSON.stringify(winners));
      return;
    }
    for (const s of seqs) {
      if (applied.has(s)) continue;
      if (![...deps.get(s)].every((d) => applied.has(d))) continue;
      applied.add(s);
      const e = bySeq.get(s);
      if (e.supersedes !== null && e.supersedes !== undefined) active.delete(e.supersedes);
      active.add(s);
      walk();
      active.delete(s);
      if (e.supersedes !== null && e.supersedes !== undefined) active.add(e.supersedes);
      applied.delete(s);
    }
  };
  walk();
  return [...outcomes].map((o) => JSON.parse(o));
}

test('30k entries with 5% corrections: view matches n<=15 enumeration of application orders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-scale-'));
  const { log, key, items } = generate(dir);

  const vres = ledger.verify(log, key);
  assert.equal(vres.ok, true);
  assert.equal(vres.count, N);

  const view = ledger.buildView(log);

  // group generated items by bizKey
  const groups = new Map();
  items.forEach((it, seq) => {
    const bk = it.op.bizKey;
    if (!groups.has(bk)) groups.set(bk, []);
    groups.get(bk).push(Object.assign({ seq }, it));
  });

  const expectedBalances = new Map();
  let checked = 0;
  for (const [bizKey, group] of groups) {
    assert.ok(group.length <= 15, `bizKey ${bizKey} has ${group.length} entries (>15)`);
    const outcomes = enumerateOutcomes(group);
    assert.equal(outcomes.length, 1, `bizKey ${bizKey}: application order must be deterministic`);
    const winners = outcomes[0];
    const viewKey = view.keys[bizKey];
    if (winners.length > 1) {
      assert.equal(viewKey.status, 'conflict', `bizKey ${bizKey}`);
      assert.deepEqual(viewKey.certificate.candidates.map((c) => c.seq).sort((a, b) => a - b), winners);
    } else {
      const winner = items[winners[0]];
      if (winner.op.type === 'tombstone') {
        assert.equal(viewKey.status, 'void', `bizKey ${bizKey}`);
      } else {
        assert.equal(viewKey.status, 'ok', `bizKey ${bizKey}`);
        assert.equal(viewKey.winner, winners[0]);
        const delta = winner.op.type === 'credit' ? winner.op.amount : -winner.op.amount;
        expectedBalances.set(winner.op.account, (expectedBalances.get(winner.op.account) || 0) + delta);
      }
    }
    checked++;
  }
  assert.equal(checked, groups.size);
  for (const [acct, bal] of expectedBalances) {
    assert.equal(view.accounts[acct], bal, `balance mismatch for ${acct}`);
  }
  assert.equal(Object.keys(view.accounts).length, expectedBalances.size);
  console.log(`checked ${checked} business keys, ${Object.keys(view.accounts).length} accounts, ${view.conflicts.length} conflicts`);
}, { timeout: 120000 });
