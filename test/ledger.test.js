'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Ledger } = require('../src/ledger');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference: enumerate all live trades and accumulate.
function referenceNet(trades, a, b, marginRate) {
  const [p1, p2] = [a, b].sort();
  let net = 0;
  for (const t of trades) {
    if (t.state !== 'live') continue;
    const involves = (t.buyer === p1 && t.seller === p2) || (t.buyer === p2 && t.seller === p1);
    if (!involves) continue;
    net += t.buyer === p1 ? t.amount : -t.amount;
  }
  const margin = Math.ceil(Math.abs(net) * marginRate);
  const from = net > 0 ? p1 : net < 0 ? p2 : null;
  const to = net > 0 ? p2 : net < 0 ? p1 : null;
  return { net, margin, direction: from === null ? 'FLAT' : `${from}->${to}` };
}

function referenceFrozen(trades, parties, marginRate) {
  const totals = new Map(parties.map((p) => [p, 0]));
  const seen = new Set();
  for (const t of trades) {
    const key = [t.buyer, t.seller].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const r = referenceNet(trades, t.buyer, t.seller, marginRate);
    if (r.direction !== 'FLAT') {
      const from = r.direction.split('->')[0];
      totals.set(from, totals.get(from) + r.margin);
    }
  }
  return totals;
}

test('fuzz: net and margin match reference enumeration', () => {
  const rnd = mulberry32(42);
  const marginRate = 1;
  const parties = ['A', 'B', 'C', 'D'];
  const ledger = new Ledger(null, { marginRate });
  const trades = [];
  let nextId = 1;

  for (let step = 0; step < 500; step += 1) {
    const roll = rnd();
    if (roll < 0.6 || trades.length === 0) {
      const buyer = parties[Math.floor(rnd() * parties.length)];
      let seller = parties[Math.floor(rnd() * parties.length)];
      if (seller === buyer) seller = parties[(parties.indexOf(buyer) + 1) % parties.length];
      const t = {
        id: `t${nextId}`,
        buyer,
        seller,
        amount: 1 + Math.floor(rnd() * 1000),
        desc: `trade ${nextId}`,
      };
      nextId += 1;
      ledger.addTrade(t);
      trades.push({ ...t, state: 'live' });
    } else {
      const t = trades[Math.floor(rnd() * trades.length)];
      if (t.state !== 'live') continue;
      if (roll < 0.85) {
        ledger.revokeTrade(t.id);
        t.state = 'revoked';
      } else {
        ledger.deleteTrade(t.id);
        t.state = 'deleted';
      }
    }
    // spot-check every pair against the reference
    for (let i = 0; i < parties.length; i += 1) {
      for (let j = i + 1; j < parties.length; j += 1) {
        const ref = referenceNet(trades, parties[i], parties[j], marginRate);
        const got = ledger.getNet(parties[i], parties[j]);
        assert.equal(got.net, ref.net, `net mismatch ${parties[i]}/${parties[j]} step ${step}`);
        assert.equal(got.margin, ref.margin, 'margin mismatch');
        assert.equal(got.direction, ref.direction, 'direction mismatch');
      }
    }
  }
  const refFrozen = referenceFrozen(trades, parties, marginRate);
  for (const p of parties) {
    assert.equal(ledger.frozenOf(p), refFrozen.get(p), `frozen mismatch for ${p}`);
  }
});

test('net reversal: release and re-freeze happen in one atomic batch', () => {
  const ledger = new Ledger(null);
  ledger.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 100, desc: '' });
  assert.equal(ledger.frozenOf('A'), 100);
  const cert = ledger.addTrade({ id: '2', buyer: 'B', seller: 'A', amount: 300, desc: '' }).certificate;
  assert.equal(cert.reversed, true);
  assert.equal(cert.direction, 'B->A');
  assert.equal(cert.margin, 200);
  assert.deepEqual(cert.batch, [
    { type: 'release', party: 'A', amount: 100 },
    { type: 'freeze', party: 'B', amount: 200 },
  ]);
  // both ops journaled as a single atomic entry
  const last = ledger.journal[ledger.journal.length - 1];
  assert.equal(last.ops.length, 2);
  assert.equal(last.ops[0].type, 'release');
  assert.equal(last.ops[1].type, 'freeze');
  assert.equal(ledger.frozenOf('A'), 0);
  assert.equal(ledger.frozenOf('B'), 200);
});

test('revoke triggers recompute over remaining live trades', () => {
  const ledger = new Ledger(null);
  ledger.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 100, desc: '' });
  ledger.addTrade({ id: '2', buyer: 'A', seller: 'B', amount: 50, desc: '' });
  ledger.addTrade({ id: '3', buyer: 'B', seller: 'A', amount: 400, desc: '' });
  assert.deepEqual(ledger.getNet('A', 'B'), { net: -250, direction: 'B->A', margin: 250 });
  const cert = ledger.revokeTrade('3');
  assert.equal(cert.reversed, true);
  assert.equal(cert.direction, 'A->B');
  assert.equal(cert.net, 150);
  assert.equal(cert.margin, 150);
  assert.deepEqual(cert.batch.map((o) => o.type), ['release', 'freeze']);
});

test('errors: unknown trade, duplicate delete, negative amount -> no state change', () => {
  const ledger = new Ledger(null);
  ledger.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 100, desc: 'x' });
  const before = ledger.hash();
  const journalLen = ledger.journal.length;

  assert.throws(() => ledger.revokeTrade('nope'), (e) => e.code === 'UNKNOWN_TRADE');
  assert.throws(() => ledger.deleteTrade('nope'), (e) => e.code === 'UNKNOWN_TRADE');
  assert.throws(() => ledger.addTrade({ id: '2', buyer: 'A', seller: 'B', amount: -1, desc: '' }),
    (e) => e.code === 'INVALID_AMOUNT');
  assert.throws(() => ledger.addTrade({ id: '2', buyer: 'A', seller: 'B', amount: 0, desc: '' }),
    (e) => e.code === 'INVALID_AMOUNT');
  assert.throws(() => ledger.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 5, desc: '' }),
    (e) => e.code === 'DUPLICATE_TRADE');

  ledger.deleteTrade('1');
  assert.throws(() => ledger.deleteTrade('1'), (e) => e.code === 'DUPLICATE_DELETE');
  assert.throws(() => ledger.revokeTrade('1'), (e) => e.code === 'NOT_LIVE');

  // failed ops changed nothing: only the successful delete is reflected
  const ledger2 = new Ledger(null);
  ledger2.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 100, desc: 'x' });
  assert.equal(before, ledger2.hash());
  assert.equal(ledger.journal.length, journalLen + 1); // only the successful delete appended a batch
});

test('persistence: restart restores nets and frozen totals', () => {
  const dir = tmpdir();
  const l1 = new Ledger(dir);
  l1.addTrade({ id: '1', buyer: 'A', seller: 'B', amount: 100, desc: '' });
  l1.addTrade({ id: '2', buyer: 'B', seller: 'A', amount: 30, desc: '' });
  l1.revokeTrade('2');
  const l2 = new Ledger(dir);
  assert.deepEqual(l2.getNet('A', 'B'), l1.getNet('A', 'B'));
  assert.equal(l2.frozenOf('A'), l1.frozenOf('A'));
  assert.equal(l2.hash(), l1.hash());
});
