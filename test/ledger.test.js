'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  GENESIS,
  Ledger,
  chainHash,
  reversalPayloadHash,
  reverseTxFor,
  netTotals,
  totalsEqual,
  enumerateRewrites,
} = require('../src/ledger');

const CLI = path.join(__dirname, '..', 'cli.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
}

function run(dir, args, env = {}) {
  // This environment drops pipe output of spawned node processes, so capture
  // stdout/stderr via temp files instead of pipes.
  const outFile = path.join(os.tmpdir(), `ledger-out-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const errFile = outFile + '.err';
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [CLI, '--dir', dir, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', outFd, errFd],
    }).status;
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  fs.rmSync(outFile, { force: true });
  fs.rmSync(errFile, { force: true });
  return { status, stdout, stderr };
}

function okJson(res) {
  assert.equal(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function errJson(res, status) {
  assert.equal(res.status, status, `expected exit ${status}, got ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stderr);
  assert.ok(parsed.error && typeof parsed.error.code === 'string');
  return parsed.error;
}

function writeTxFile(dir, tx) {
  const file = path.join(dir, `tx-${tx.id}.json`);
  fs.writeFileSync(file, JSON.stringify(tx));
  return file;
}

function normalTx(id, parent, amount, account) {
  return { id, parent, amount, account, kind: 'NORMAL', payloadHash: `payload-${id}` };
}

// Build a ledger with the given normal txs chained; returns { dir, entries }.
function buildLedger(txs) {
  const dir = tmpDir();
  assert.equal(run(dir, ['init']).status, 0);
  const entries = [];
  let parent = GENESIS;
  for (const [i, spec] of txs.entries()) {
    const tx = normalTx(spec.id || `t${i}`, parent, spec.amount, spec.account);
    const res = run(dir, ['append', writeTxFile(dir, tx)]);
    const head = okJson(res).head;
    entries.push({ tx, hash: head });
    parent = head;
  }
  return { dir, entries, head: parent };
}

test('init, append and verify a hash-chained ledger', () => {
  const { dir, entries } = buildLedger([
    { id: 'a1', amount: 100, account: 'alice' },
    { id: 'a2', amount: -30, account: 'bob' },
  ]);
  const res = okJson(run(dir, ['verify']));
  assert.equal(res.length, 2);
  assert.equal(res.head, entries[1].hash);
  // chain hash links parent
  assert.equal(entries[1].hash, chainHash({ ...entries[1].tx, parent: entries[0].hash }));
  // balances
  const balances = okJson(run(dir, ['balance'])).balances;
  assert.deepEqual(balances, { alice: 100, bob: -30 });
});

test('append rejects a wrong parent', () => {
  const { dir } = buildLedger([{ id: 'a1', amount: 1, account: 'x' }]);
  const bad = normalTx('a2', GENESIS, 1, 'x');
  const err = errJson(run(dir, ['append', writeTxFile(dir, bad)]), 2);
  assert.equal(err.code, 'PARENT_MISMATCH');
});

test('reverse restores the balance and verify stays consistent', () => {
  const { dir } = buildLedger([{ id: 'pay1', amount: 250, account: 'alice' }]);
  okJson(run(dir, ['reverse', 'pay1']));
  const res = okJson(run(dir, ['verify']));
  assert.equal(res.length, 2);
  const balances = okJson(run(dir, ['balance'])).balances;
  assert.equal(balances.alice, 0);
  const ledger = Ledger.open(dir);
  const chain = ledger.chain();
  assert.equal(chain[1].tx.kind, 'REVERSAL');
  assert.equal(chain[1].tx.amount, -250);
  assert.equal(chain[1].tx.payloadHash, reversalPayloadHash('pay1'));
});

test('duplicate reversal exits 4 with JSON on stderr', () => {
  const { dir } = buildLedger([{ id: 'pay1', amount: 10, account: 'a' }]);
  okJson(run(dir, ['reverse', 'pay1']));
  const err = errJson(run(dir, ['reverse', 'pay1']), 4);
  assert.equal(err.code, 'DUPLICATE_REVERSAL');
});

test('reversing an unknown tx or a reversal is rejected', () => {
  const { dir } = buildLedger([{ id: 'pay1', amount: 10, account: 'a' }]);
  assert.equal(errJson(run(dir, ['reverse', 'nope']), 2).code, 'UNKNOWN_TX');
  okJson(run(dir, ['reverse', 'pay1']));
  assert.equal(errJson(run(dir, ['reverse', 'rev-pay1']), 2).code, 'INVALID_REVERSAL');
});

test('rewrite with unknown anchor exits 3', () => {
  const { dir } = buildLedger([{ id: 'a1', amount: 1, account: 'x' }]);
  const err = errJson(run(dir, ['rewrite', '--keep-published', 'f'.repeat(64)]), 3);
  assert.equal(err.code, 'ANCHOR_NOT_FOUND');
});

test('rewrite refuses to drop the anchor or its ancestors (exit 5)', () => {
  const { dir, entries } = buildLedger([
    { id: 'pub1', amount: 5, account: 'a' },
    { id: 'pub2', amount: 5, account: 'a' },
    { id: 'u1', amount: 7, account: 'b' },
  ]);
  const anchor = entries[1].hash; // pub2 is anchor; pub1 is its ancestor
  for (const id of ['pub1', 'pub2']) {
    const err = errJson(run(dir, ['rewrite', '--keep-published', anchor, '--drop', id]), 5);
    assert.equal(err.code, 'PUBLISHED_TAMPER');
  }
  // chain untouched
  assert.equal(okJson(run(dir, ['verify'])).length, 3);
});

test('rewrite drops unpublished NORMAL txs only when totals stay equal', () => {
  const { dir, entries } = buildLedger([
    { id: 'pub', amount: 100, account: 'a' },
    { id: 'u1', amount: 50, account: 'b' },
    { id: 'u2', amount: -50, account: 'b' },
    { id: 'u3', amount: 70, account: 'c' },
  ]);
  const anchor = entries[0].hash;
  // dropping only u1 changes account b's total -> unsatisfiable
  const err = errJson(run(dir, ['rewrite', '--keep-published', anchor, '--drop', 'u1']), 6);
  assert.equal(err.code, 'UNSATISFIABLE');
  // dropping the netting pair u1+u2 is fine
  const { head } = okJson(run(dir, ['rewrite', '--keep-published', anchor, '--drop', 'u1', '--drop', 'u2']));
  const res = okJson(run(dir, ['verify']));
  assert.equal(res.length, 2);
  assert.equal(res.head, head);
  const balances = okJson(run(dir, ['balance'])).balances;
  assert.deepEqual(balances, { a: 100, c: 70 });
});

test('rewrite keeps reversal causality: dropping a reversed tx is unsatisfiable', () => {
  const { dir, entries } = buildLedger([{ id: 'pub', amount: 1, account: 'a' }]);
  // unpublished: u1 (+100 b) then its reversal
  const head1 = entries[0].hash;
  const u1 = normalTx('u1', head1, 100, 'b');
  okJson(run(dir, ['append', writeTxFile(dir, u1)]));
  okJson(run(dir, ['reverse', 'u1']));
  const err = errJson(run(dir, ['rewrite', '--keep-published', head1, '--drop', 'u1']), 6);
  assert.equal(err.code, 'UNSATISFIABLE');
  // dropping the reversal itself is not allowed at all
  const err2 = errJson(run(dir, ['rewrite', '--keep-published', head1, '--drop', 'rev-u1']), 2);
  assert.equal(err2.code, 'INVALID_DROP');
  assert.equal(okJson(run(dir, ['verify'])).length, 3);
});

test('rewrite can roll the head back to the anchor when the suffix nets to zero', () => {
  const { dir, entries } = buildLedger([
    { id: 'pub', amount: 9, account: 'a' },
    { id: 'u1', amount: 40, account: 'b' },
    { id: 'u2', amount: -40, account: 'b' },
  ]);
  const anchor = entries[0].hash;
  const { head } = okJson(run(dir, ['rewrite', '--keep-published', anchor, '--drop', 'u1', '--drop', 'u2']));
  assert.equal(head, anchor);
  assert.equal(okJson(run(dir, ['verify'])).length, 1);
});

test('fault injection at tmp/rename/head never leaves a half-chain', () => {
  for (const point of ['tmp', 'rename', 'head']) {
    const { dir, head: oldHead } = buildLedger([{ id: 'a1', amount: 1, account: 'x' }]);
    const t2 = normalTx('a2', oldHead, 2, 'x');
    const res = run(dir, ['append', writeTxFile(dir, t2)], { LEDGER_FAIL_AT: point });
    assert.notEqual(res.status, 0, `injected fault at ${point} should fail the command`);
    assert.equal(JSON.parse(res.stderr).error.code, 'INJECTED_FAULT');
    // after recovery the chain verifies and is exactly the old or the new chain
    const verify = okJson(run(dir, ['verify']));
    const newHead = chainHash(t2);
    assert.ok(
      (verify.head === oldHead && verify.length === 1) ||
      (verify.head === newHead && verify.length === 2),
      `head ${verify.head} is neither old nor new chain after fault at ${point}`,
    );
    // no leftover tmp files
    const leftovers = fs.readdirSync(path.join(dir, 'txs')).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    assert.ok(!fs.existsSync(path.join(dir, 'HEAD.tmp')));
  }
});

test('fault injection during rewrite leaves old or new chain intact', () => {
  for (const point of ['tmp', 'rename', 'head']) {
    const { dir, entries } = buildLedger([
      { id: 'pub', amount: 3, account: 'a' },
      { id: 'u1', amount: 10, account: 'b' },
      { id: 'u2', amount: -10, account: 'b' },
      { id: 'u3', amount: 5, account: 'c' },
    ]);
    const anchor = entries[0].hash;
    const oldHead = entries[3].hash;
    // the rewritten chain keeps u3 re-parented onto the anchor
    const newHead = chainHash({ ...entries[3].tx, parent: anchor });
    const res = run(dir, ['rewrite', '--keep-published', anchor, '--drop', 'u1', '--drop', 'u2'],
      { LEDGER_FAIL_AT: point });
    assert.notEqual(res.status, 0);
    const verify = okJson(run(dir, ['verify']));
    assert.ok(
      (verify.head === oldHead && verify.length === 4) ||
      (verify.head === newHead && verify.length === 2),
      `unexpected chain state after fault at ${point}`,
    );
  }
});

test('verify detects a tampered published tx (exit 5)', () => {
  const { dir, entries } = buildLedger([
    { id: 'a1', amount: 1, account: 'x' },
    { id: 'a2', amount: 2, account: 'x' },
  ]);
  const file = path.join(dir, 'txs', entries[0].hash + '.json');
  fs.writeFileSync(file, JSON.stringify({ ...entries[0].tx, amount: 999 }));
  const err = errJson(run(dir, ['verify']), 5);
  assert.equal(err.code, 'CHAIN_BROKEN');
});

test('enumerateRewrites: for n<=7 every candidate preserves net totals and reversal causality', () => {
  let seed = 123456789;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

  for (let trial = 0; trial < 40; trial++) {
    const n = 1 + Math.floor(rand() * 7); // 1..7 txs
    const accounts = ['alice', 'bob', 'carol'];
    const suffix = [];
    const reversedTargets = new Set();
    for (let i = 0; i < n; i++) {
      const makeReversal = i > 0 && rand() < 0.35;
      if (makeReversal) {
        const candidates = suffix.filter(
          (t) => t.kind === 'NORMAL' && !reversedTargets.has(t.id),
        );
        if (candidates.length > 0) {
          const target = candidates[Math.floor(rand() * candidates.length)];
          reversedTargets.add(target.id);
          suffix.push({ ...reverseTxFor(target, 'p'.repeat(64)), id: `r${i}` });
          continue;
        }
      }
      suffix.push({
        id: `t${i}`,
        parent: 'p'.repeat(64),
        amount: Math.floor(rand() * 201) - 100,
        account: accounts[Math.floor(rand() * accounts.length)],
        kind: 'NORMAL',
        payloadHash: `ph-${trial}-${i}`,
      });
    }

    const results = enumerateRewrites(suffix);
    assert.ok(results.length > 0, 'at least the identity rewrite must exist');
    const full = netTotals(suffix);

    for (const cand of results) {
      // per-account net totals unchanged
      assert.deepEqual(netTotals(cand), full);
      // every reversal kept
      assert.equal(
        cand.filter((t) => t.kind === 'REVERSAL').length,
        suffix.filter((t) => t.kind === 'REVERSAL').length,
      );
      // causal order: a reversal comes after its target when both are present
      const pos = new Map(cand.map((t, i) => [t.id, i]));
      for (const tx of cand) {
        if (tx.kind !== 'REVERSAL') continue;
        const target = suffix.find((t) => reversalPayloadHash(t.id) === tx.payloadHash);
        if (target) {
          assert.ok(pos.has(target.id), `target ${target.id} must be kept with its reversal`);
          assert.ok(pos.get(target.id) < pos.get(tx.id), `${tx.id} must follow ${target.id}`);
        }
      }
    }

    // the identity candidate (keep all, original order) is always enumerated
    assert.ok(
      results.some((c) => c.length === suffix.length && c.every((t, i) => t.id === suffix[i].id)),
      'identity rewrite missing',
    );
  }
});

test('enumerateRewrites: exhaustive check against brute force for a tricky suffix', () => {
  // suffix with a reversal pair and a netting pair: many subsets/orders
  const a = { id: 'a', parent: 'p'.repeat(64), amount: 30, account: 'x', kind: 'NORMAL', payloadHash: 'pa' };
  const b = { id: 'b', parent: 'p'.repeat(64), amount: -30, account: 'x', kind: 'NORMAL', payloadHash: 'pb' };
  const c = { id: 'c', parent: 'p'.repeat(64), amount: 12, account: 'y', kind: 'NORMAL', payloadHash: 'pc' };
  const rc = { ...reverseTxFor(c, 'p'.repeat(64)) };
  const suffix = [a, b, c, rc];
  const results = enumerateRewrites(suffix);

  // brute force: all subsets x all permutations, filter by the same rules
  const full = netTotals(suffix);
  let expected = 0;
  const idx = [0, 1, 2, 3];
  for (let mask = 0; mask < 16; mask++) {
    if (!(mask & 8)) continue; // reversal rc (index 3) must be kept
    if (!(mask & 4)) continue; // its target c (index 2) must be kept
    const sub = idx.filter((i) => mask & (1 << i));
    const totals = netTotals(sub.map((i) => suffix[i]));
    if (!totalsEqual(totals, full)) continue;
    // count permutations with c before rc
    const permCount = (function count(items) {
      if (items.length <= 1) return 1;
      let total = 0;
      for (let i = 0; i < items.length; i++) {
        if (items[i] === 3 && items.includes(2)) continue; // rc cannot be first while c remains
        total += count([...items.slice(0, i), ...items.slice(i + 1)]);
      }
      return total;
    })(sub);
    expected += permCount;
  }
  assert.equal(results.length, expected);
});
