import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WalletStore, tokenize } from '../src/store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wallet-holds-'));
}

/** Fully independent brute-force ordered-window matcher (enumerates combos). */
function bruteForceMatch(memo, terms, window) {
  const tokens = tokenize(memo);
  const posLists = terms.map((term) =>
    tokens.flatMap((tok, i) => (tok === term ? [i] : [])),
  );
  if (posLists.some((list) => list.length === 0)) return false;
  const search = (i, prev, start) => {
    if (i === posLists.length) return prev - start <= window;
    for (const p of posLists[i]) {
      if (i === 0) {
        if (search(i + 1, p, p)) return true;
      } else if (p > prev && search(i + 1, p, start)) {
        return true;
      }
    }
    return false;
  };
  return search(0, -1, -1);
}

function bruteForceIds(records, terms, window) {
  return records
    .filter((r) => bruteForceMatch(r.memo, terms, window))
    .map((r) => r.id)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function resultIds(searchResult) {
  assert.equal(searchResult.ok, true);
  return searchResult.results.map((r) => r.id);
}

test('acceptance 1: serial freeze/release/cancel balances match independent ledger', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WalletStore(dir, { compactThreshold: 1000 });

  // Independent ledger: wallet -> { deposited, activeHeld }
  const ledger = new Map();
  const ledgerWallet = (w) => {
    if (!ledger.has(w)) ledger.set(w, { deposited: 0, activeHeld: 0 });
    return ledger.get(w);
  };

  let rev = 0;
  const deposits = [
    ['alice', 10_000],
    ['bob', 5_000],
    ['alice', 2_500],
  ];
  for (const [wallet, amount] of deposits) {
    const res = store.deposit({ wallet, amount, expectedRev: rev });
    assert.equal(res.ok, true);
    assert.equal(res.rev, ++rev);
    assert.equal(res.balance, ledgerWallet(wallet).deposited + amount);
    ledgerWallet(wallet).deposited += amount;
  }

  // Serial freezes, releases, cancels across both wallets.
  const ops = [
    ['freeze', 'alice', 3_000, 'invoice 2026-09 office chairs'],
    ['freeze', 'alice', 1_500, 'invoice 2026-09 standing desk'],
    ['freeze', 'bob', 2_000, 'invoice 2026-09 office chairs bulk'],
    ['freeze', 'alice', 4_000, 'travel advance q4'],
    ['release', 1],
    ['cancel', 2],
    ['freeze', 'bob', 500, 'misc office supplies'],
    ['cancel', 3],
    ['release', 4],
    ['cancel', 5],
  ];
  const holds = new Map(); // seq -> { id, wallet, amount, state }
  for (const op of ops) {
    const [kind] = op;
    if (kind === 'freeze') {
      const [, wallet, amount, memo] = op;
      const res = store.freeze({ wallet, amount, memo, expectedRev: rev });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.rev, ++rev);
      assert.equal(res.amount, amount, '本次占用 must echo the frozen amount');
      const lw = ledgerWallet(wallet);
      assert.equal(res.available, lw.deposited - lw.activeHeld - amount);
      lw.activeHeld += amount;
      holds.set(res.id, { wallet, amount, state: 'active' });
    } else {
      const seq = op[1];
      const id = `hold-${seq}`;
      const hold = holds.get(id);
      const res =
        kind === 'release'
          ? store.release({ id, expectedRev: rev })
          : store.cancel({ id, expectedRev: rev });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(res.rev, ++rev);
      if (hold.state === 'active') {
        ledgerWallet(hold.wallet).activeHeld -= hold.amount;
      }
      hold.state = kind === 'release' ? 'released' : 'cancelled';
    }
  }

  // Final balances must equal the independent ledger sums.
  for (const [wallet, lw] of ledger) {
    const bal = store.balance(wallet);
    assert.equal(bal.balance, lw.deposited, `${wallet} balance`);
    assert.equal(bal.held, lw.activeHeld, `${wallet} held`);
    assert.equal(bal.available, lw.deposited - lw.activeHeld, `${wallet} available`);
  }

  // Cross-check against the persisted event history replayed independently.
  const replayed = new WalletStore(dir, { compactThreshold: 1000 });
  for (const [wallet, lw] of ledger) {
    assert.equal(replayed.balance(wallet).available, lw.deposited - lw.activeHeld);
  }
});

test('acceptance 2: stale rev write fails with no id or amount drift', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WalletStore(dir);

  assert.equal(store.deposit({ wallet: 'alice', amount: 1_000, expectedRev: 0 }).ok, true);
  const frozen = store.freeze({
    wallet: 'alice',
    amount: 200,
    memo: 'stale rev probe',
    expectedRev: 1,
  });
  assert.equal(frozen.ok, true);

  const staleRev = 1; // current rev is now 2
  const before = {
    rev: store.rev,
    balance: store.balance('alice'),
    recordCount: store.records().length,
    headHash: store.certificate().hash,
  };

  // Every mutating command with the stale rev must be rejected wholesale.
  const attempts = [
    () => store.deposit({ wallet: 'alice', amount: 500, expectedRev: staleRev }),
    () => store.freeze({ wallet: 'alice', amount: 100, memo: 'x', expectedRev: staleRev }),
    () => store.release({ id: frozen.id, expectedRev: staleRev }),
    () => store.cancel({ id: frozen.id, expectedRev: staleRev }),
  ];
  for (const attempt of attempts) {
    const res = attempt();
    assert.equal(res.ok, false);
    assert.equal(res.code, 'CONFLICT');
    assert.equal(res.currentRev, before.rev, 'conflict must report current rev');
    assert.equal(res.certificate.rev, before.rev);
    assert.equal(res.certificate.hash, before.headHash, 'certificate pins head hash');
  }

  // No state drift: rev, amounts, record ids all unchanged.
  assert.equal(store.rev, before.rev);
  assert.deepEqual(store.balance('alice'), before.balance);
  assert.equal(store.records().length, before.recordCount);

  // The next legitimate id is exactly what it would have been without the
  // rejected attempts — failed writes allocated nothing.
  const next = store.freeze({
    wallet: 'alice',
    amount: 50,
    memo: 'after stale',
    expectedRev: store.rev,
  });
  assert.equal(next.ok, true);
  assert.equal(next.id, 'hold-2');
  assert.equal(store.balance('alice').held, 250);
});

const CORPUS = [
  ['alice', 'red apple pie with fresh red apples'],
  ['alice', 'red delicious apple and green apple'],
  ['bob', 'apple pie red wine pairing'],
  ['bob', 'the red fox jumps over a red lazy dog'],
  ['alice', 'apple watch series red edition'],
  ['bob', 'green tea and red apple crumble'],
];

function seedCorpus(store) {
  let rev = 0;
  assert.equal(store.deposit({ wallet: 'alice', amount: 100_000, expectedRev: rev }).ok, true);
  rev += 1;
  assert.equal(store.deposit({ wallet: 'bob', amount: 100_000, expectedRev: rev }).ok, true);
  rev += 1;
  const ids = [];
  for (const [wallet, memo] of CORPUS) {
    const res = store.freeze({ wallet, amount: 100, memo, expectedRev: rev });
    assert.equal(res.ok, true);
    rev = res.rev;
    ids.push(res.id);
  }
  return { ids, rev };
}

const QUERIES = [
  { query: 'red apple' }, // phrase
  { query: 'red apple', near: 2 },
  { query: 'red apple', near: 4 },
  { query: 'apple red', near: 3 },
  { query: 'red apple pie' }, // 3-term phrase
  { query: 'red apple pie', near: 5 },
  { query: 'red', }, // single term
  { query: 'red fox red', near: 6 },
];

function assertSearchMatchesEnumeration(store, label) {
  const live = store.records().filter((r) => r.state !== 'cancelled');
  const all = store.records();
  for (const { query, near } of QUERIES) {
    const terms = tokenize(query);
    const window = near ?? terms.length - 1;

    const viaIndex = store.search(query, { near });
    assert.deepEqual(
      resultIds(viaIndex),
      bruteForceIds(live, terms, window),
      `${label}: live search ${JSON.stringify({ query, near })}`,
    );
    assert.ok(
      viaIndex.results.every((r) => !r.deleted && r.state !== 'cancelled'),
      `${label}: deleted records invisible by default`,
    );

    const viaHistory = store.search(query, { near, includeHistory: true });
    assert.deepEqual(
      resultIds(viaHistory),
      bruteForceIds(all, terms, window),
      `${label}: includeHistory ${JSON.stringify({ query, near })}`,
    );
    for (const r of viaHistory.results) {
      assert.ok(
        r.state === 'active' || r.state === 'released' || r.state === 'cancelled',
        'state annotated',
      );
      if (all.find((x) => x.id === r.id).state === 'cancelled') {
        assert.equal(r.deleted, true, 'deleted records annotated in history');
      }
    }
  }
}

test('acceptance 3: proximity search matches enumeration before/after delete and after compaction+restart', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WalletStore(dir, { compactThreshold: 3 });
  let { ids, rev } = seedCorpus(store);

  // Before any deletion: live set == full set.
  assertSearchMatchesEnumeration(store, 'before-delete');

  // Delete (cancel) two records whose memos contain query terms.
  for (const id of [ids[0], ids[5]]) {
    const res = store.cancel({ id, expectedRev: rev });
    assert.equal(res.ok, true);
    rev = res.rev;
  }
  // Release one more (released stays visible, not deleted).
  const rel = store.release({ id: ids[1], expectedRev: rev });
  assert.equal(rel.ok, true);
  rev = rel.rev;

  assertSearchMatchesEnumeration(store, 'after-delete');

  // Force one more cancel to cross the compaction threshold (3 tombstones).
  const res3 = store.cancel({ id: ids[2], expectedRev: rev });
  assert.equal(res3.ok, true);
  rev = res3.rev;
  assert.equal(store.tombstones, 0, 'auto-compaction resets tombstone count');

  // Rev chain continuity across compaction: next command gets rev+1.
  const after = store.deposit({ wallet: 'alice', amount: 1, expectedRev: rev });
  assert.equal(after.ok, true);
  assert.equal(after.rev, rev + 1, 'rev chain continuous after compaction');
  rev = after.rev;

  // Restart from disk and re-verify everything.
  const reopened = new WalletStore(dir, { compactThreshold: 3 });
  assert.equal(reopened.rev, rev, 'rev survives compaction + restart');
  assertSearchMatchesEnumeration(reopened, 'after-compaction-restart');

  // Cancelled records still queryable via includeHistory after restart.
  const history = reopened.search('red apple', { includeHistory: true });
  const cancelledIds = history.results.filter((r) => r.deleted).map((r) => r.id);
  assert.ok(cancelledIds.includes(ids[0]));
  assert.ok(cancelledIds.includes(ids[5]));
});

test('CLI: end-to-end commands, conflict exit code, JSON output', (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(import.meta.dirname, '..', 'bin', 'wallet.js');
  let stdoutCounter = 0;
  const run = (args) => {
    // Sandboxed environments may drop piped stdout of grandchild processes,
    // so capture stdout via a file redirect instead of a pipe.
    const outPath = join(dir, `stdout-${stdoutCounter++}.txt`);
    const fd = openSync(outPath, 'w');
    const proc = spawnSync(process.execPath, [cli, '--data', dir, ...args], {
      stdio: ['ignore', fd, 'pipe'],
    });
    closeSync(fd);
    return {
      status: proc.status,
      stdout: readFileSync(outPath, 'utf8'),
      stderr: proc.stderr ?? '',
    };
  };

  let r = run(['deposit', '--wallet', 'alice', '--amount', '1000', '--rev', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);

  r = run(['freeze', '--wallet', 'alice', '--amount', '300', '--memo', 'red apple pie', '--rev', '1']);
  assert.equal(r.status, 0, r.stderr);
  const freezeOut = JSON.parse(r.stdout);
  assert.equal(freezeOut.id, 'hold-1');
  assert.equal(freezeOut.available, 700);

  // Stale rev -> exit code 2, conflict payload with certificate.
  r = run(['freeze', '--wallet', 'alice', '--amount', '1', '--memo', 'x', '--rev', '1']);
  assert.equal(r.status, 2);
  const conflict = JSON.parse(r.stdout);
  assert.equal(conflict.code, 'CONFLICT');
  assert.equal(conflict.currentRev, 2);
  assert.equal(conflict.certificate.rev, 2);

  r = run(['balance', '--wallet', 'alice']);
  assert.equal(r.status, 0);
  assert.deepEqual(
    (({ balance, held, available }) => ({ balance, held, available }))(JSON.parse(r.stdout)),
    { balance: 1000, held: 300, available: 700 },
  );

  r = run(['search', '--query', 'red apple']);
  assert.equal(r.status, 0);
  assert.deepEqual(resultIds(JSON.parse(r.stdout)), ['hold-1']);

  r = run(['cancel', '--id', 'hold-1', '--rev', '2']);
  assert.equal(r.status, 0);

  r = run(['search', '--query', 'red apple']);
  assert.deepEqual(resultIds(JSON.parse(r.stdout)), [], 'deleted invisible by default');

  r = run(['search', '--query', 'red apple', '--include-history']);
  const hist = JSON.parse(r.stdout);
  assert.deepEqual(resultIds(hist), ['hold-1']);
  assert.equal(hist.results[0].state, 'cancelled');
  assert.equal(hist.results[0].deleted, true);

  r = run(['balance', '--wallet', 'alice']);
  assert.equal(JSON.parse(r.stdout).available, 1000, 'cancel released funds');
});
