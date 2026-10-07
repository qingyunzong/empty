import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatasets, MergeError, canonical, sha256Hex } from '../src/merge.js';
import { parseJsonl } from '../src/jsonl.js';

function toMap(records) {
  return new Map(records.map((rec, i) => [rec.id, { rec, line: i + 1 }]));
}

function rec(id, overrides = {}) {
  return { id, account: 'ACC-1', amount: 100, ccy: 'USD', seq: 1, status: 'DRAFT', ...overrides };
}

function rulesFor(conflicts, id) {
  return conflicts.filter((c) => c.id === id).map((c) => c.rule).sort();
}

test('acceptance 1: conflict-free merge with deterministic ordering', () => {
  const base = toMap([
    rec('b2', { amount: 100 }),
    rec('b1', { status: 'DRAFT' }),
    rec('b3', { ccy: 'USD' }),
    rec('b4', { amount: 7 }),
  ]);
  const left = toMap([
    rec('b2', { amount: 250 }),           // left-only amount change
    rec('b1', { status: 'LOCKED' }),      // left-only status advance
    rec('b3', { ccy: 'USD' }),
    // b4 deleted by left
    rec('n1', { account: 'ACC-9', amount: 5, ccy: 'EUR', seq: 9, status: 'DRAFT' }), // left-only add
  ]);
  const right = toMap([
    rec('b2', { amount: 100 }),
    rec('b1', { status: 'LOCKED' }),      // same change on both sides
    rec('b3', { ccy: 'EUR' }),            // right-only ccy change
    rec('b4', { amount: 7 }),             // unmodified -> deletion effective
  ]);
  const { result, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(conflicts, []);
  assert.deepEqual(result.map((r) => r.id), ['b1', 'b2', 'b3', 'n1']);
  assert.equal(result.find((r) => r.id === 'b2').amount, 250);
  assert.equal(result.find((r) => r.id === 'b1').status, 'LOCKED');
  assert.equal(result.find((r) => r.id === 'b3').ccy, 'EUR');
  assert.equal(result.find((r) => r.id === 'n1').account, 'ACC-9');
});

test('acceptance 2: double-sided amount change conflicts and is withheld from result', () => {
  const base = toMap([rec('x1', { amount: 100 }), rec('x2')]);
  const left = toMap([rec('x1', { amount: 200 }), rec('x2')]);
  const right = toMap([rec('x1', { amount: 300 }), rec('x2')]);
  const { result, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(result.map((r) => r.id), ['x2']);
  assert.deepEqual(rulesFor(conflicts, 'x1'), ['R1']);
  const c = conflicts[0];
  assert.equal(c.base.amount, 100);
  assert.equal(c.left.amount, 200);
  assert.equal(c.right.amount, 300);
  assert.match(c.sha256, /^[0-9a-f]{64}$/);
  const { sha256, ...summary } = c;
  assert.equal(sha256, sha256Hex(canonical(summary)));
});

test('acceptance 3a: status rollback is a conflict', () => {
  const base = toMap([rec('s1', { status: 'LOCKED' })]);
  const left = toMap([rec('s1', { status: 'DRAFT' })]);
  const right = toMap([rec('s1', { status: 'LOCKED' })]);
  const { result, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(result, []);
  assert.deepEqual(rulesFor(conflicts, 's1'), ['R4']);
});

test('acceptance 3b: both sides advancing status differently conflicts', () => {
  const base = toMap([rec('s2', { status: 'DRAFT' })]);
  const left = toMap([rec('s2', { status: 'LOCKED' })]);
  const right = toMap([rec('s2', { status: 'DRAFT' })]);
  const ok = mergeDatasets(base, toMap([rec('s2', { status: 'LOCKED' })]), right);
  assert.equal(ok.result[0].status, 'LOCKED');
  const both = mergeDatasets(
    base,
    toMap([rec('s2', { status: 'LOCKED', amount: 1 })]),
    toMap([rec('s2', { status: 'LOCKED', amount: 2 })]),
  );
  assert.deepEqual(rulesFor(both.conflicts, 's2'), ['R1']);
  void left;
});

test('acceptance 3c: delete vs modify conflicts; delete vs unmodified is effective', () => {
  const base = toMap([rec('d1'), rec('d2')]);
  const left = toMap([rec('d2')]);                       // deletes d1
  const right = toMap([rec('d1', { amount: 999 }), rec('d2')]); // modifies d1
  const { result, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(result.map((r) => r.id), ['d2']);
  assert.deepEqual(rulesFor(conflicts, 'd1'), ['R5']);
  assert.equal(conflicts[0].left, null);
  assert.equal(conflicts[0].right.amount, 999);

  const bothDelete = mergeDatasets(base, toMap([]), toMap([]));
  assert.deepEqual(bothDelete.result, []);
  assert.deepEqual(bothDelete.conflicts, []);
});

test('add-add with different content conflicts (R6)', () => {
  const base = toMap([]);
  const left = toMap([rec('a1', { amount: 1 })]);
  const right = toMap([rec('a1', { amount: 2 })]);
  const { result, conflicts } = mergeDatasets(base, left, right);
  assert.deepEqual(result, []);
  assert.deepEqual(rulesFor(conflicts, 'a1'), ['R6']);
  assert.equal(conflicts[0].base, null);
});

test('illegal status transition (skip) raises MergeError with code/line', () => {
  const base = toMap([rec('j1', { status: 'DRAFT' })]);
  const left = toMap([rec('j1', { status: 'SETTLED' })]);
  const right = toMap([rec('j1', { status: 'DRAFT' })]);
  assert.throws(() => mergeDatasets(base, left, right), (err) => {
    assert.ok(err instanceof MergeError);
    assert.equal(err.code, 'ILLEGAL_TRANSITION');
    assert.equal(err.line, 1);
    return true;
  });
});

test('parseJsonl: bad JSON line reports code and line', () => {
  assert.throws(() => parseJsonl(`${JSON.stringify(rec('ok'))}\nnot json\n`, 'f.jsonl'), (err) => {
    assert.equal(err.code, 'BAD_JSONL');
    assert.equal(err.line, 2);
    assert.match(err.message, /f\.jsonl:2/);
    return true;
  });
});

test('parseJsonl: duplicate id reports code and line', () => {
  const text = `${JSON.stringify(rec('dup'))}\n${JSON.stringify(rec('dup'))}\n`;
  assert.throws(() => parseJsonl(text, 'f.jsonl'), (err) => {
    assert.equal(err.code, 'DUP_ID');
    assert.equal(err.line, 2);
    return true;
  });
});

test('parseJsonl: unknown status and missing fields are rejected', () => {
  assert.throws(() => parseJsonl(JSON.stringify(rec('z', { status: 'PAID' })), 'f'), (err) => {
    assert.equal(err.code, 'BAD_STATUS');
    return true;
  });
  const incomplete = { id: 'z', account: 'A', amount: 1 };
  assert.throws(() => parseJsonl(JSON.stringify(incomplete), 'f'), (err) => {
    assert.equal(err.code, 'BAD_JSONL');
    return true;
  });
});

test('output ordering is deterministic regardless of input order', () => {
  const mk = (ids) => toMap(ids.map((id) => rec(id)));
  const a = mergeDatasets(mk(['i3', 'i1', 'i2']), mk(['i3', 'i1', 'i2']), mk(['i3', 'i1', 'i2']));
  const b = mergeDatasets(mk(['i2', 'i3', 'i1']), mk(['i1', 'i2', 'i3']), mk(['i3', 'i2', 'i1']));
  assert.deepEqual(a.result.map((r) => r.id), ['i1', 'i2', 'i3']);
  assert.deepEqual(a, b);
});
