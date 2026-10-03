'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, ScanError } = require('../src/engine');

const rec = (o) => JSON.stringify(o);
const base = { clearingNo: 'C1', counterparty: 'X', currency: 'CNY', amount: '1', memo: '' };

test('A: overlapping hits returned in unified (start, length, ruleId) order', () => {
  const rules = {
    exact: [
      { id: 'E1', pattern: 'ab' },
      { id: 'E2', pattern: 'abc' },
      { id: 'E3', pattern: 'bcd' },
      { id: 'E4', pattern: 'd' },
    ],
    regex: [{ id: 'R1', field: 'memo', pattern: 'b.' }],
  };
  const e = new Engine(rules);
  e.load([rec({ ...base, memo: 'abcd' })]);
  const { hits } = e.scan();
  assert.deepEqual(
    hits.map((h) => [h.start, h.length, h.ruleId]),
    [[0, 2, 'E1'], [0, 3, 'E2'], [1, 2, 'R1'], [1, 3, 'E3'], [3, 1, 'E4']]
  );
  // same start+length across engines -> rule id decides
  const e2 = new Engine({
    exact: [{ id: 'Z9', pattern: 'xy' }],
    regex: [{ id: 'A1', field: 'memo', pattern: 'xy' }],
  });
  e2.load([rec({ ...base, memo: 'xy' })]);
  assert.deepEqual(e2.scan().hits.map((h) => h.ruleId), ['A1', 'Z9']);
});

test('B: out-of-range / malformed patch rejected, file unchanged', () => {
  const rules = { exact: [{ id: 'E1', pattern: 'risk' }], regex: [] };
  const e = new Engine(rules);
  e.load([
    rec({ ...base, memo: 'risk here' }),
    rec({ ...base, memo: 'clean' }),
    rec({ ...base, memo: 'risk risk' }),
  ]);
  const before = e.scan();
  for (const bad of [
    () => e.patch(-1, rec({ ...base, memo: 'x' })),
    () => e.patch(3, rec({ ...base, memo: 'x' })),
    () => e.patch(100, rec({ ...base, memo: 'x' })),
    () => e.patch(1.5, rec({ ...base, memo: 'x' })),
    () => e.patch(1, 'not json'),
    () => e.patch(1, '[1,2]'),
  ]) {
    assert.throws(bad, (err) => err instanceof ScanError && err.code === 'BAD_PATCH');
  }
  const after = e.scan();
  assert.deepEqual(after.hits, before.hits);
  assert.equal(after.proof.rootHash, before.proof.rootHash);
});

test('D: incremental patch result equals full rescan, with interval proof', () => {
  const rules = {
    exact: [{ id: 'E1', pattern: 'risk' }, { id: 'E2', pattern: 'isk' }],
    regex: [{ id: 'R1', field: 'amount', pattern: '[0-9]{3,}' }],
  };
  const lines = [
    rec({ ...base, amount: '10', memo: 'nothing' }),
    rec({ ...base, amount: '9999', memo: 'risky business' }),
    rec({ ...base, amount: '5', memo: 'clean' }),
  ];
  const e = new Engine(rules);
  e.load(lines);
  const p = e.patch(1, rec({ ...base, amount: '7', memo: 'now clean' }));
  assert.deepEqual(p.window, { start: 1, end: 1 });
  assert.equal(p.contextIntact, true);
  assert.equal(p.hitsRemoved, 4); // risk, isk, amount 9999 (len 4 and len 3)
  assert.equal(p.hitsAdded, 0);
  assert.notEqual(p.before.rootHash, p.after.rootHash);

  const fresh = new Engine(rules);
  fresh.load([lines[0], rec({ ...base, amount: '7', memo: 'now clean' }), lines[2]]);
  const inc = e.scan();
  const full = fresh.scan();
  assert.deepEqual(inc.hits, full.hits);
  assert.equal(inc.proof.rootHash, full.proof.rootHash);
  assert.deepEqual(e.verify(inc.proof), { ok: true, hits: inc.hits.length });
});

test('E: tampered proof fails verify with PROOF_MISMATCH', () => {
  const rules = {
    exact: [{ id: 'E1', pattern: 'risk' }],
    regex: [{ id: 'R1', field: 'memo', pattern: '[0-9]+' }],
  };
  const e = new Engine(rules);
  e.load([rec({ ...base, memo: 'risk 42' }), rec({ ...base, memo: 'clean' })]);
  const { proof } = e.scan();
  assert.deepEqual(e.verify(proof), { ok: true, hits: 3 });

  const tamper = (fn) => {
    const p = JSON.parse(JSON.stringify(proof));
    fn(p);
    assert.throws(() => e.verify(p), (err) => err.code === 'PROOF_MISMATCH');
  };
  tamper((p) => { p.hits[0].start += 1; });                 // moved hit
  tamper((p) => { p.hits[0].traceHash = '0'.repeat(64); }); // forged trace digest
  tamper((p) => { p.hits.pop(); });                          // deleted hit
  tamper((p) => { p.hits.push(p.hits[0]); });                // injected hit
  tamper((p) => { p.lines[1].hash = 'f'.repeat(64); });      // forged line hash
  tamper((p) => { p.rootHash = 'a'.repeat(64); });           // forged root
  tamper((p) => { p.rulesHash = 'b'.repeat(64); });          // wrong ruleset
  tamper((p) => { p.lineCount = 99; });                      // wrong line count
});

test('error codes: DUP_RULE and OFFSET_OVERFLOW', () => {
  assert.throws(
    () => new Engine({ exact: [{ id: 'E1', pattern: 'a' }, { id: 'E1', pattern: 'b' }], regex: [] }),
    (err) => err.code === 'DUP_RULE'
  );
  assert.throws(
    () => new Engine({ exact: [{ id: 'E1', pattern: 'a' }, { id: 'E2', pattern: 'a' }], regex: [] }),
    (err) => err.code === 'DUP_RULE'
  );
  assert.throws(
    () => new Engine({ exact: [{ id: 'E1', pattern: 'a' }], regex: [{ id: 'E1', field: 'memo', pattern: 'x' }] }),
    (err) => err.code === 'DUP_RULE'
  );
  const tooMany = Array.from({ length: 5001 }, (_, i) => ({ id: `E${i}`, pattern: `p${i}` }));
  assert.throws(() => new Engine({ exact: tooMany, regex: [] }), (err) => err.code === 'OFFSET_OVERFLOW');
  const e = new Engine({ exact: [], regex: [] });
  assert.throws(
    () => e.load(Array.from({ length: 100001 }, (_, i) => rec({ ...base, clearingNo: `C${i}` }))),
    (err) => err.code === 'OFFSET_OVERFLOW'
  );
});

test('scale smoke: 100k lines, 5000 rules scan + verify', () => {
  const exact = Array.from({ length: 5000 }, (_, i) => ({ id: `E${i}`, pattern: `w${i}` }));
  const e = new Engine({ exact, regex: [{ id: 'R1', field: 'memo', pattern: '[0-9]{4}' }] });
  const lines = Array.from({ length: 100000 }, (_, i) =>
    rec({ ...base, clearingNo: `C${i}`, memo: i % 1000 === 0 ? `hit w7 and 1234` : `filler ${i}` }));
  e.load(lines);
  const r = e.scan();
  assert.ok(r.hits.length > 0);
  assert.ok(r.hits.some((h) => h.ruleId === 'E7' && h.kind === 'exact'));
  assert.ok(r.hits.some((h) => h.ruleId === 'R1' && h.kind === 'regex'));
  assert.deepEqual(e.verify(r.proof), { ok: true, hits: r.hits.length });
});
