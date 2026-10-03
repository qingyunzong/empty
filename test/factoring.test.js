import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FactoringLedger,
  FactoringError,
  freezeAmount,
  minWordDistance,
  tokenize,
} from '../src/factoring.js';

// Independent brute-force helpers (deliberately re-implemented, not imported logic).

function bruteTokens(memo) {
  return String(memo)
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/u)
    .filter(Boolean)
    .flatMap((part) => (/^[a-z0-9]+$/.test(part) ? [part] : [...part]));
}

function bruteMinDistance(memoA, memoB) {
  const a = bruteTokens(memoA);
  const b = bruteTokens(memoB);
  let best = Infinity;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (a[i] === b[j]) best = Math.min(best, Math.abs(i - j));
    }
  }
  return best;
}

function bruteClusters(invoices, slop) {
  const active = invoices.filter((inv) => (inv.state ?? 'active') !== 'revoked');
  const parent = new Map(active.map((inv) => [inv.id, inv.id]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const byCreditor = new Map();
  for (const inv of active) {
    if (!byCreditor.has(inv.creditor)) byCreditor.set(inv.creditor, []);
    byCreditor.get(inv.creditor).push(inv);
  }
  for (const group of byCreditor.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (bruteMinDistance(group[i].memo, group[j].memo) <= slop) {
          const ra = find(group[i].id);
          const rb = find(group[j].id);
          if (ra !== rb) parent.set(rb, ra);
        }
      }
    }
  }
  const groups = new Map();
  for (const inv of active) {
    const root = find(inv.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(inv.id);
  }
  return [...groups.values()]
    .filter((members) => members.length >= 2)
    .map((members) => members.slice().sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function ledgerClusterSets(ledger) {
  return ledger
    .clusters()
    .map((cluster) => cluster.members.slice().sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}

const SAMPLE_INVOICES = [
  { id: 'A1', creditor: 'acme', faceValue: 10000, advanceRate: 0.8, memo: 'steel delivery contract alpha' },
  { id: 'A2', creditor: 'acme', faceValue: 20000, advanceRate: 0.5, memo: 'steel shipment beta' },
  { id: 'A3', creditor: 'acme', faceValue: 5000, advanceRate: 0.9, memo: 'delivery of copper rods' },
  { id: 'A4', creditor: 'acme', faceValue: 8000, advanceRate: 0.7, memo: 'unrelated invoice gamma delta' },
  { id: 'B1', creditor: 'globex', faceValue: 30000, advanceRate: 0.6, memo: 'steel delivery contract alpha' },
  { id: 'B2', creditor: 'globex', faceValue: 4000, advanceRate: 1, memo: 'nothing in common here' },
  { id: 'A5', creditor: 'acme', faceValue: 12000, advanceRate: 0.25, memo: 'alpha omega steel' },
];

test('冻结额与可用额与逐张独立枚举一致', () => {
  const ledger = new FactoringLedger({ creditLimit: 100000, slop: 1 });
  const added = SAMPLE_INVOICES.map((inv) => ledger.addInvoice(inv));

  const expectFrozen = (invoices) =>
    Math.round(
      invoices
        .filter((inv) => inv.state !== 'revoked')
        .reduce((sum, inv) => sum + freezeAmount(inv.faceValue, inv.advanceRate), 0) * 100,
    ) / 100;

  assert.equal(ledger.frozenTotal(), expectFrozen(added));
  assert.equal(ledger.available(), Math.round((100000 - expectFrozen(added)) * 100) / 100);

  for (const inv of added) {
    assert.equal(inv.frozenAmount, freezeAmount(inv.faceValue, inv.advanceRate));
  }

  ledger.revoke('A2');
  ledger.revoke('B1');
  const remaining = added.map((inv) =>
    inv.id === 'A2' || inv.id === 'B1' ? { ...inv, state: 'revoked' } : inv,
  );
  assert.equal(ledger.frozenTotal(), expectFrozen(remaining));
  assert.equal(ledger.available(), Math.round((100000 - expectFrozen(remaining)) * 100) / 100);
});

test('近邻簇与枚举所有词对窗口一致（slop = 0/1/2 边界）', () => {
  for (const slop of [0, 1, 2]) {
    const ledger = new FactoringLedger({ creditLimit: 1000000, slop });
    for (const inv of SAMPLE_INVOICES) ledger.addInvoice(inv);
    assert.deepEqual(
      ledgerClusterSets(ledger),
      bruteClusters(SAMPLE_INVOICES, slop),
      `slop=${slop} cluster mismatch`,
    );
  }
});

test('词距边界：距离恰为 slop 时关联，slop+1 时不关联', () => {
  // common word "anchor" at position 0 vs position k => distance k
  for (const k of [0, 1, 2, 3]) {
    const memoB = ['pad'.repeat(0), ...Array(k).fill('x'), 'anchor'].filter(Boolean).join(' ');
    assert.equal(minWordDistance('anchor tail', `${Array(k).fill('x').join(' ')}${k ? ' ' : ''}anchor tail`), k);
    for (const slop of [0, 1, 2]) {
      const ledger = new FactoringLedger({ creditLimit: 100000, slop });
      ledger.addInvoice({ id: 'X1', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: 'anchor tail' });
      ledger.addInvoice({ id: 'X2', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: memoB });
      const expected = k <= slop ? [['X1', 'X2']] : [];
      assert.deepEqual(ledgerClusterSets(ledger), expected, `k=${k} slop=${slop}`);
    }
  }
});

test('跨债权人不聚簇，单发票不成簇', () => {
  const ledger = new FactoringLedger({ creditLimit: 100000, slop: 2 });
  ledger.addInvoice({ id: 'P1', creditor: 'one', faceValue: 100, advanceRate: 0.5, memo: 'shared words here' });
  ledger.addInvoice({ id: 'P2', creditor: 'two', faceValue: 100, advanceRate: 0.5, memo: 'shared words here' });
  ledger.addInvoice({ id: 'P3', creditor: 'one', faceValue: 100, advanceRate: 0.5, memo: 'totally different' });
  assert.deepEqual(ledger.clusters(), []);
});

test('非法费率、重复撤销、超额冻结、重复 ID 均报错', () => {
  const ledger = new FactoringLedger({ creditLimit: 1000, slop: 1 });
  for (const bad of [0, -0.5, 1.5, NaN, Infinity, '0.8']) {
    assert.throws(
      () => ledger.addInvoice({ id: `R${String(bad)}`, creditor: 'c', faceValue: 100, advanceRate: bad }),
      (err) => err instanceof FactoringError && err.code === 'INVALID_RATE',
      `rate=${bad}`,
    );
  }
  assert.throws(
    () => ledger.addInvoice({ id: 'F0', creditor: 'c', faceValue: 0, advanceRate: 0.5 }),
    (err) => err.code === 'INVALID_FACE_VALUE',
  );
  ledger.addInvoice({ id: 'K1', creditor: 'c', faceValue: 1000, advanceRate: 0.8, memo: 'memo one' });
  assert.throws(
    () => ledger.addInvoice({ id: 'K1', creditor: 'c', faceValue: 1, advanceRate: 0.5 }),
    (err) => err.code === 'DUPLICATE_INVOICE',
  );
  assert.throws(
    () => ledger.addInvoice({ id: 'K2', creditor: 'c', faceValue: 1000, advanceRate: 0.5 }),
    (err) => err.code === 'LIMIT_EXCEEDED',
  );
  const cert = ledger.revoke('K1');
  assert.equal(cert.releasedAmount, 800);
  assert.equal(ledger.frozenTotal(), 0);
  assert.throws(() => ledger.revoke('K1'), (err) => err.code === 'ALREADY_REVOKED');
  assert.throws(() => ledger.revoke('NOPE'), (err) => err.code === 'INVOICE_NOT_FOUND');
});

test('撤销证书列出存活关联成员；簇空后物理删除且重启无残留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factoring-'));
  const file = join(dir, 'data.json');
  try {
    const ledger = new FactoringLedger({ creditLimit: 100000, slop: 1 });
    ledger.addInvoice({ id: 'M1', creditor: 'c', faceValue: 100, advanceRate: 0.5, memo: 'apple banana' });
    ledger.addInvoice({ id: 'M2', creditor: 'c', faceValue: 200, advanceRate: 0.5, memo: 'apple cherry' });
    ledger.addInvoice({ id: 'M3', creditor: 'c', faceValue: 300, advanceRate: 0.5, memo: 'banana apple' });
    assert.equal(ledger.clusters().length, 1);

    const cert1 = ledger.revoke('M2');
    assert.deepEqual(cert1.survivingMembers.slice().sort(), ['M1', 'M3']);
    assert.equal(cert1.clusterDissolved, false);
    assert.equal(ledger.clusters().length, 1);

    const cert2 = ledger.revoke('M1');
    assert.deepEqual(cert2.survivingMembers, ['M3']);
    assert.equal(cert2.clusterDissolved, true, 'cluster dissolves when fewer than 2 members remain');
    assert.deepEqual(ledger.clusters(), []);

    const cert3 = ledger.revoke('M3');
    assert.equal(cert3.clusterId, null);
    assert.deepEqual(cert3.survivingMembers, []);
    assert.deepEqual(ledger.clusters(), [], 'cluster must be physically removed once empty');

    ledger.save(file);
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(persisted.clusterIndex, [], 'persisted file must not keep empty cluster entries');

    const reopened = FactoringLedger.load(file);
    assert.deepEqual(reopened.clusters(), [], 'no empty cluster residue after restart');
    assert.equal(reopened.frozenTotal(), 0);
    assert.equal(reopened.available(), 100000);
    assert.equal(reopened.invoices.get('M1').state, 'revoked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('同词距候选按金额差最小、id 最小排序', () => {
  const ledger = new FactoringLedger({ creditLimit: 1000000, slop: 0 });
  ledger.addInvoice({ id: 'T0', creditor: 'c', faceValue: 1000, advanceRate: 0.5, memo: 'anchor word' });
  // all candidates share "anchor" at position 0 => distance 0 tie
  ledger.addInvoice({ id: 'T9', creditor: 'c', faceValue: 1100, advanceRate: 0.5, memo: 'anchor a' }); // diff 50
  ledger.addInvoice({ id: 'T2', creditor: 'c', faceValue: 1100, advanceRate: 0.5, memo: 'anchor b' }); // diff 50, smaller id
  ledger.addInvoice({ id: 'T5', creditor: 'c', faceValue: 1020, advanceRate: 0.5, memo: 'anchor c' }); // diff 10
  ledger.addInvoice({ id: 'T7', creditor: 'c', faceValue: 3000, advanceRate: 0.5, memo: 'nothing shared' }); // no common word
  ledger.addInvoice({ id: 'T8', creditor: 'other', faceValue: 1020, advanceRate: 0.5, memo: 'anchor c' }); // other creditor
  const candidates = ledger.matchCandidates('T0');
  assert.deepEqual(
    candidates.map((c) => c.id),
    ['T5', 'T2', 'T9'],
  );
  assert.deepEqual(
    candidates.map((c) => c.distance),
    [0, 0, 0],
  );
});

test('tokenize 支持英文词与中文字符', () => {
  assert.deepEqual(tokenize('Steel 合同 Alpha1'), ['steel', '合', '同', 'alpha1']);
  assert.equal(minWordDistance('合同 到期', '到期 合同'), 2);
});
