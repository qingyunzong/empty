import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQuery, randomTables, hashesOf } from './helpers.js';

const QUERIES = [
  `SELECT u.name, COUNT(o.id) AS n, SUM(o.amount) AS total
   FROM users u JOIN orders o ON o.uid = u.id
   WHERE u.age >= 18 GROUP BY u.name HAVING COUNT(o.id) >= 1`,
  `SELECT o.id, o.amount FROM orders o WHERE o.amount > 100 AND o.status = 'paid'`,
  `SELECT u.region, AVG(u.age) AS avg_age, COUNT(*) AS c
   FROM users u GROUP BY u.region HAVING AVG(u.age) > 25`,
  `SELECT u.name, o.amount FROM users u JOIN orders o ON o.uid = u.id WHERE o.amount IS NOT NULL`,
  `SELECT o.status, MIN(o.amount) AS lo, MAX(o.amount) AS hi FROM orders o GROUP BY o.status`,
  `SELECT COUNT(*) AS total_rows, SUM(o.amount) AS s FROM orders o`,
];

// Acceptance 1: optimized plans match direct enumeration for inputs up to 300 rows.
test('optimized physical plans match direct enumeration up to 300 rows', () => {
  const sizes = [
    [0, 0], [1, 0], [2, 3], [10, 20], [40, 60], [100, 150], [120, 180],
  ];
  for (const [nu, no] of sizes) {
    assert.ok(nu + no <= 300, 'test inputs stay within the 300-row limit');
    for (let seed = 1; seed <= 3; seed++) {
      const tables = randomTables(seed * 1000 + nu * 10 + no, nu, no);
      for (const sql of QUERIES) {
        const { direct, physicalResults, best, certificate } = runQuery(sql, tables);
        const expected = hashesOf(direct);
        for (const res of physicalResults) {
          assert.equal(hashesOf(res), expected,
            `mismatch for ${nu} users/${no} orders seed=${seed}: ${sql.slice(0, 40)}`);
        }
        assert.ok(best.length >= 1);
        assert.equal(certificate.fullCheck.equal, true, 'certificate full check must pass');
        assert.equal(certificate.fullCheck.directHash, certificate.fullCheck.optimizedHash);
      }
    }
  }
});

test('certificate records rewrite rule sequence and sampled input hashes', () => {
  const tables = randomTables(7, 30, 50);
  const { certificate } = runQuery(QUERIES[0], tables);
  const ruleNames = certificate.rules.map((r) => r.rule);
  assert.ok(ruleNames.includes('predicate_pushdown'));
  assert.ok(ruleNames.includes('projection_pruning'));
  assert.ok(ruleNames.includes('aggregate_pushdown'));
  assert.equal(certificate.inputs.length, 2);
  for (const inp of certificate.inputs) {
    assert.match(inp.sampleHash, /^[0-9a-f]{64}$/);
    assert.ok(inp.sampledRows <= 32);
  }
});
