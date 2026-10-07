import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDatasets, MergeError, STATUS_ORDER } from '../src/merge.js';

const FIELD_RULE = { account: 'R7', amount: 'R1', ccy: 'R2', seq: 'R7', status: 'R3' };
const CANDIDATES = {
  account: ['A1', 'A2', 'A9'],
  amount: [0, 1, 999.9, -3],
  ccy: ['USD', 'EUR', 'CNY', 'JPY'],
  seq: [1, 2, 9],
  status: STATUS_ORDER,
};

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

function rank(status) {
  return STATUS_ORDER.indexOf(status);
}

function randomRecord(rng, id) {
  return {
    id,
    account: `A${1 + Math.floor(rng() * 3)}`,
    amount: Math.floor(rng() * 1000) / 10,
    ccy: ['USD', 'EUR', 'CNY'][Math.floor(rng() * 3)],
    seq: 1 + Math.floor(rng() * 5),
    status: STATUS_ORDER[Math.floor(rng() * 3)],
  };
}

function toMap(records) {
  return new Map(records.map((rec, i) => [rec.id, { rec, line: i + 1 }]));
}

function clone(records) {
  return records.map((r) => ({ ...r }));
}

function rulesFor(conflicts, id) {
  return conflicts.filter((c) => c.id === id).map((c) => c.rule).sort();
}

// Expected outcome of changing exactly one field on one side, other side == base.
function expectedSingleChange(baseRec, field, value) {
  if (field === 'status') {
    const delta = rank(value) - rank(baseRec.status);
    if (delta > 1) return { throws: true };
    if (delta < 0) return { rules: ['R4'] };
  }
  return { rules: [] };
}

function assertCleanMerge(t, base, left, right, expectedRecs, ctx) {
  const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(right));
  assert.deepEqual(conflicts, [], `${ctx}: unexpected conflicts ${JSON.stringify(conflicts)}`);
  assert.deepEqual(
    result,
    [...expectedRecs].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1)),
    `${ctx}: merged result mismatch`,
  );
}

test('brute force: all single-field changes on random sets (n<=8)', (t) => {
  const rng = mulberry32(20261007);
  let checked = 0;
  for (let trial = 0; trial < 25; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const base = Array.from({ length: n }, (_, i) => randomRecord(rng, `id${i}`));
    for (let i = 0; i < n; i++) {
      for (const [field, values] of Object.entries(CANDIDATES)) {
        for (const value of values) {
          if (Object.is(base[i][field], value)) continue;
          const left = clone(base);
          left[i] = { ...left[i], [field]: value };
          const right = clone(base);
          const expected = expectedSingleChange(base[i], field, value);
          const ctx = `trial=${trial} rec=${i} field=${field} value=${JSON.stringify(value)}`;
          if (expected.throws) {
            assert.throws(
              () => mergeDatasets(toMap(base), toMap(left), toMap(right)),
              (err) => err instanceof MergeError && err.code === 'ILLEGAL_TRANSITION',
              `${ctx}: expected ILLEGAL_TRANSITION`,
            );
          } else if (expected.rules.length > 0) {
            const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(right));
            assert.deepEqual(rulesFor(conflicts, base[i].id), expected.rules, `${ctx}: rules`);
            assert.ok(!result.some((r) => r.id === base[i].id), `${ctx}: conflicted id must not merge`);
            assert.deepEqual(
              result.map((r) => r.id),
              base.filter((_, j) => j !== i).map((r) => r.id),
              `${ctx}: other records still merge`,
            );
          } else {
            const expectedRecs = clone(base);
            expectedRecs[i] = { ...expectedRecs[i], [field]: value };
            assertCleanMerge(t, base, left, right, expectedRecs, ctx);
          }
          checked++;
        }
      }
    }
  }
  t.diagnostic(`single-field cases checked: ${checked}`);
  assert.ok(checked > 1000, 'expected substantial brute-force coverage');
});

test('brute force: both sides change the same record (all field/value pairs)', (t) => {
  const rng = mulberry32(777);
  let checked = 0;
  for (let trial = 0; trial < 15; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const base = Array.from({ length: n }, (_, i) => randomRecord(rng, `id${i}`));
    for (let i = 0; i < n; i++) {
      for (const [f1, v1s] of Object.entries(CANDIDATES)) {
        for (const [f2, v2s] of Object.entries(CANDIDATES)) {
          for (const v1 of v1s) {
            for (const v2 of v2s) {
              if (Object.is(base[i][f1], v1) && Object.is(base[i][f2], v2)) continue;
              const left = clone(base);
              const right = clone(base);
              left[i] = { ...left[i], [f1]: v1 };
              right[i] = { ...right[i], [f2]: v2 };
              const ctx = `trial=${trial} rec=${i} ${f1}=${JSON.stringify(v1)} vs ${f2}=${JSON.stringify(v2)}`;

              // Illegal jumps anywhere are hard errors.
              const jump =
                (f1 === 'status' && rank(v1) - rank(base[i].status) > 1) ||
                (f2 === 'status' && rank(v2) - rank(base[i].status) > 1);
              if (jump) {
                assert.throws(
                  () => mergeDatasets(toMap(base), toMap(left), toMap(right)),
                  (err) => err instanceof MergeError && err.code === 'ILLEGAL_TRANSITION',
                  `${ctx}: expected ILLEGAL_TRANSITION`,
                );
                checked++;
                continue;
              }

              const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(right));
              const expectedRules = [];
              const merged = { ...base[i] };

              const applyChanged = (f, v) => {
                if (f === 'status' && rank(v) < rank(base[i].status)) expectedRules.push('R4');
                else merged[f] = v;
              };
              if (f1 === f2) {
                if (Object.is(v1, v2)) {
                  applyChanged(f1, v1);
                } else if (Object.is(v1, base[i][f1])) {
                  applyChanged(f1, v2);
                } else if (Object.is(v2, base[i][f2])) {
                  applyChanged(f1, v1);
                } else {
                  expectedRules.push(FIELD_RULE[f1]);
                }
              } else {
                for (const [f, v] of [[f1, v1], [f2, v2]]) {
                  if (Object.is(v, base[i][f])) continue;
                  if (f === 'status') {
                    if (rank(v) < rank(base[i].status)) expectedRules.push('R4');
                    else merged.status = v;
                  } else {
                    merged[f] = v;
                  }
                }
              }
              expectedRules.sort();

              if (expectedRules.length > 0) {
                assert.deepEqual(rulesFor(conflicts, base[i].id), expectedRules, `${ctx}: rules`);
                assert.ok(!result.some((r) => r.id === base[i].id), `${ctx}: conflicted id withheld`);
              } else {
                assert.deepEqual(rulesFor(conflicts, base[i].id), [], `${ctx}: no conflict expected`);
                const got = result.find((r) => r.id === base[i].id);
                assert.deepEqual(got, merged, `${ctx}: merged record`);
              }
              checked++;
            }
          }
        }
      }
    }
  }
  t.diagnostic(`both-side cases checked: ${checked}`);
  assert.ok(checked > 1000, 'expected substantial brute-force coverage');
});

test('brute force: deletion matrix on random sets (n<=8)', () => {
  const rng = mulberry32(4242);
  let checked = 0;
  for (let trial = 0; trial < 25; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const base = Array.from({ length: n }, (_, i) => randomRecord(rng, `id${i}`));
    for (let i = 0; i < n; i++) {
      // left deletes, right unmodified -> deletion effective
      {
        const left = base.filter((_, j) => j !== i);
        const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(clone(base)));
        assert.deepEqual(conflicts, []);
        assert.deepEqual(result.map((r) => r.id), base.filter((_, j) => j !== i).map((r) => r.id));
        checked++;
      }
      // both delete -> gone, no conflict
      {
        const smaller = base.filter((_, j) => j !== i);
        const { result, conflicts } = mergeDatasets(toMap(base), toMap(smaller), toMap(clone(smaller)));
        assert.deepEqual(conflicts, []);
        assert.deepEqual(result.map((r) => r.id), smaller.map((r) => r.id));
        checked++;
      }
      // left deletes, right modifies one field -> R5 (or ILLEGAL_TRANSITION on jump)
      for (const [field, values] of Object.entries(CANDIDATES)) {
        for (const value of values) {
          if (Object.is(base[i][field], value)) continue;
          const left = base.filter((_, j) => j !== i);
          const right = clone(base);
          right[i] = { ...right[i], [field]: value };
          const ctx = `trial=${trial} rec=${i} delete-vs-${field}=${JSON.stringify(value)}`;
          if (field === 'status' && rank(value) - rank(base[i].status) > 1) {
            assert.throws(
              () => mergeDatasets(toMap(base), toMap(left), toMap(right)),
              (err) => err instanceof MergeError && err.code === 'ILLEGAL_TRANSITION',
              `${ctx}: expected ILLEGAL_TRANSITION`,
            );
          } else {
            const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(right));
            assert.deepEqual(rulesFor(conflicts, base[i].id), ['R5'], `${ctx}: R5 expected`);
            assert.ok(!result.some((r) => r.id === base[i].id), `${ctx}: conflicted id withheld`);
          }
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 500, 'expected substantial deletion coverage');
});

test('brute force: addition matrix', () => {
  const rng = mulberry32(99);
  for (let trial = 0; trial < 20; trial++) {
    const n = 1 + Math.floor(rng() * 8);
    const base = Array.from({ length: n }, (_, i) => randomRecord(rng, `id${i}`));
    const added = randomRecord(rng, 'new0');
    // one side adds -> present
    {
      const left = [...clone(base), added];
      const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(clone(base)));
      assert.deepEqual(conflicts, []);
      assert.deepEqual(result.find((r) => r.id === 'new0'), added);
    }
    // both add identical -> present
    {
      const both = [...clone(base), added];
      const { result, conflicts } = mergeDatasets(toMap(base), toMap(clone(both)), toMap(clone(both)));
      assert.deepEqual(conflicts, []);
      assert.deepEqual(result.find((r) => r.id === 'new0'), added);
    }
    // both add differently -> R6
    {
      const left = [...clone(base), added];
      const right = [...clone(base), { ...added, amount: added.amount + 1 }];
      const { result, conflicts } = mergeDatasets(toMap(base), toMap(left), toMap(right));
      assert.deepEqual(rulesFor(conflicts, 'new0'), ['R6']);
      assert.ok(!result.some((r) => r.id === 'new0'));
    }
  }
});
