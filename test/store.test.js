import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, tokenize, orderedWithinWindow } from '../lib/store.js';

function freshDir() {
  return mkdtempSync(join(tmpdir(), 'hold-store-'));
}

/** Independent brute-force enumeration: does memo contain terms in order within window? */
function bruteForceMatch(memo, query, window) {
  const terms = tokenize(query);
  const tokens = tokenize(memo);
  const lists = terms.map((t) => tokens.flatMap((tok, i) => (tok === t ? [i] : [])));
  if (lists.some((l) => l.length === 0)) return false;
  return orderedWithinWindow(lists, window);
}

function bruteForceSearch(holds, query, window, includeHistory) {
  const win = window ?? tokenize(query).length;
  return holds
    .filter((h) => includeHistory || h.state !== 'cancelled')
    .filter((h) => bruteForceMatch(h.memo, query, win))
    .map((h) => h.id)
    .sort();
}

test('1) serial freeze/release/cancel balance matches independent history sum', () => {
  const dir = freshDir();
  const store = openStore(dir);
  const history = []; // independent transaction log
  let rev = 0;

  const expectBalances = (wallets) => {
    for (const w of wallets) {
      const available = history
        .filter((e) => e.wallet === w)
        .reduce((sum, e) => sum + (e.op === 'deposit' || e.op === 'release' || e.op === 'cancel' ? e.amount : -e.amount), 0);
      const held = history
        .filter((e) => e.wallet === w)
        .reduce((sum, e) => sum + (e.op === 'freeze' ? e.amount : e.op === 'deposit' ? 0 : -e.amount), 0);
      const b = store.balance(w);
      assert.equal(b.balance, available, `${w} available`);
      assert.equal(b.held, held, `${w} held`);
    }
  };

  const ops = [
    { op: 'deposit', wallet: 'alice', amount: 1000 },
    { op: 'deposit', wallet: 'bob', amount: 250 },
    { op: 'freeze', wallet: 'alice', amount: 100, memo: 'invoice one' },
    { op: 'freeze', wallet: 'alice', amount: 40, memo: 'invoice two' },
    { op: 'freeze', wallet: 'bob', amount: 250, memo: 'full amount' },
    { op: 'release', id: 'h1' },
    { op: 'cancel', id: 'h2' },
    { op: 'freeze', wallet: 'alice', amount: 5, memo: 'invoice three' },
    { op: 'cancel', id: 'h3' },
    { op: 'release', id: 'h4' },
  ];

  for (const op of ops) {
    let res;
    if (op.op === 'deposit') res = store.deposit({ ...op, rev });
    else if (op.op === 'freeze') res = store.freeze({ ...op, rev });
    else if (op.op === 'release') res = store.release({ id: op.id, rev });
    else res = store.cancel({ id: op.id, rev });
    assert.equal(res.ok, true, JSON.stringify(res));
    rev += 1;
    // mirror into independent history with the settled amount
    if (op.op === 'release' || op.op === 'cancel') {
      history.push({ op: op.op, wallet: res.wallet, amount: res.released });
    } else {
      history.push({ op: op.op, wallet: op.wallet, amount: op.amount });
    }
    // every accepted command returns balance + this-op amount + cert
    assert.equal(typeof res.balance, 'number');
    assert.equal(typeof res.cert, 'string');
    if (op.op === 'freeze') assert.equal(res.held, op.amount);
    if (op.op === 'release' || op.op === 'cancel') assert.equal(typeof res.released, 'number');
  }

  expectBalances(['alice', 'bob']);
  assert.equal(store.rev, rev);
  assert.equal(store.verify().ok, true);
});

test('2) stale rev write fails: no id, amount, rev or cert change', () => {
  const dir = freshDir();
  const store = openStore(dir);
  assert.equal(store.deposit({ wallet: 'w', amount: 100, rev: 0 }).ok, true);
  const f = store.freeze({ wallet: 'w', amount: 30, memo: 'first hold', rev: 1 });
  assert.equal(f.ok, true);

  const before = {
    rev: store.rev,
    cert: store.cert,
    balance: store.balance('w'),
    holds: store.listHolds({ includeHistory: true }),
  };

  // stale rev on every write command
  const staleFreeze = store.freeze({ wallet: 'w', amount: 10, memo: 'sneaky', rev: 1 });
  assert.equal(staleFreeze.ok, false);
  assert.equal(staleFreeze.error, 'CONFLICT');
  assert.equal(staleFreeze.currentRev, before.rev); // conflict returns current rev
  assert.equal(staleFreeze.cert, before.cert); // and the certificate
  assert.equal(staleFreeze.id, undefined); // no id allocated

  const staleRelease = store.release({ id: 'h1', rev: 0 });
  assert.equal(staleRelease.error, 'CONFLICT');
  const staleCancel = store.cancel({ id: 'h1', rev: 99 });
  assert.equal(staleCancel.error, 'CONFLICT');
  const staleDeposit = store.deposit({ wallet: 'w', amount: 1, rev: 1 });
  assert.equal(staleDeposit.error, 'CONFLICT');

  // nothing changed
  assert.equal(store.rev, before.rev);
  assert.equal(store.cert, before.cert);
  assert.deepEqual(store.balance('w'), before.balance);
  assert.deepEqual(store.listHolds({ includeHistory: true }), before.holds);

  // log on disk has exactly the 2 accepted entries
  const lines = readFileSync(join(dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);

  // correct rev still works afterwards
  const ok = store.freeze({ wallet: 'w', amount: 10, memo: 'sneaky', rev: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.id, 'h2');
});

test('3) proximity search matches enumeration before/after delete, after compaction + restart', () => {
  const dir = freshDir();
  const threshold = 3;
  let store = openStore(dir, { compactThreshold: threshold });

  const memos = [
    'the quick brown fox jumps over',
    'quick brown fox',
    'brown fox quick', // out of order for "quick fox"
    'quick and the fox', // span 4
    'quick something very fox', // span 4
    'lazy dog sleeps all day',
    'fox quick brown', // reverse order
  ];
  let rev = 0;
  assert.equal(store.deposit({ wallet: 'w', amount: 10000, rev: rev++ }).ok, true);
  for (const memo of memos) {
    assert.equal(store.freeze({ wallet: 'w', amount: 1, memo, rev: rev++ }).ok, true);
  }

  const queries = [
    { query: 'quick fox', window: 3 },
    { query: 'quick fox', window: 4 },
    { query: 'quick brown fox', window: undefined }, // exact phrase
    { query: 'fox quick', window: 2 },
    { query: 'the fox', window: 4 },
  ];

  const checkAll = (label) => {
    const all = store.listHolds({ includeHistory: true });
    for (const q of queries) {
      const live = store.search(q.query, { window: q.window });
      assert.deepEqual(
        live.matches.map((m) => m.id),
        bruteForceSearch(all, q.query, q.window, false),
        `${label}: live window for ${JSON.stringify(q)}`,
      );
      const full = store.search(q.query, { window: q.window, includeHistory: true });
      assert.deepEqual(
        full.matches.map((m) => m.id),
        bruteForceSearch(all, q.query, q.window, true),
        `${label}: full window for ${JSON.stringify(q)}`,
      );
      // deleted records annotated
      for (const m of full.matches) {
        const rec = all.find((h) => h.id === m.id);
        assert.equal(m.state, rec.state);
        assert.equal(m.deleted, rec.state === 'cancelled');
      }
    }
  };

  checkAll('before delete');

  // cancel enough records to trigger incremental compaction (threshold = 3)
  for (const id of ['h1', 'h3', 'h5']) {
    assert.equal(store.cancel({ id, rev: rev++ }).ok, true);
  }
  assert.ok(store.tombstones >= threshold);
  assert.ok(existsSync(join(dir, 'snapshot.json')), 'compaction wrote snapshot');
  assert.equal(readFileSync(join(dir, 'log.jsonl'), 'utf8'), '', 'log truncated after compaction');

  checkAll('after delete + compaction');

  // restart: reload from snapshot + log
  const revBefore = store.rev;
  const certBefore = store.cert;
  store = openStore(dir, { compactThreshold: threshold });
  assert.equal(store.rev, revBefore, 'rev chain continuous across restart');
  assert.equal(store.cert, certBefore, 'cert chain continuous across restart');

  checkAll('after restart');

  // rev chain still advances seamlessly after compaction + restart
  const next = store.freeze({ wallet: 'w', amount: 1, memo: 'quick fox again', rev: revBefore });
  assert.equal(next.ok, true);
  assert.equal(next.rev, revBefore + 1);
  assert.equal(store.verify().ok, true);
  checkAll('after post-restart write');
});

test('phrase query requires consecutive terms; window smaller than term count rejected', () => {
  const dir = freshDir();
  const store = openStore(dir);
  store.deposit({ wallet: 'w', amount: 100, rev: 0 });
  store.freeze({ wallet: 'w', amount: 1, memo: 'a b c', rev: 1 });
  store.freeze({ wallet: 'w', amount: 1, memo: 'a x b c', rev: 2 });

  const phrase = store.search('a b c');
  assert.deepEqual(phrase.matches.map((m) => m.id), ['h1']);
  const near = store.search('a b c', { window: 4 });
  assert.deepEqual(near.matches.map((m) => m.id), ['h1', 'h2']);
  const bad = store.search('a b c', { window: 2 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'WINDOW_TOO_SMALL');
});

test('business-rule rejections do not consume rev', () => {
  const dir = freshDir();
  const store = openStore(dir);
  store.deposit({ wallet: 'w', amount: 10, rev: 0 });
  assert.equal(store.freeze({ wallet: 'w', amount: 50, memo: 'too big', rev: 1 }).error, 'INSUFFICIENT');
  assert.equal(store.release({ id: 'nope', rev: 1 }).error, 'NOT_FOUND');
  assert.equal(store.rev, 1, 'rev untouched by rejected commands');
  assert.equal(store.freeze({ wallet: 'w', amount: 10, memo: 'fits', rev: 1 }).ok, true);
});
