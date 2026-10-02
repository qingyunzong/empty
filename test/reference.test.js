import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl, typeCheck, compileProgram, checkVersion } from '../src/index.js';
import { referenceLinearizable } from './reference.js';

// Seeded PRNG (mulberry32) for reproducible random histories.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RULE_VARIANTS = [
  `rule R { op write(key: string, value: int) -> string; op read(key: string) -> int; }`,
  `rule R {
     op write(key: string, value: int) -> string; op read(key: string) -> int;
     commutes(a, b): a.op == op"write" and b.op == op"write" and a.key == b.key;
   }`,
  `rule R {
     op write(key: string, value: int) -> string; op read(key: string) -> int;
     commutes(a, b): a.op == op"write" and b.op == op"write";
     concurrent(a, b): a.key != b.key;
   }`,
  `rule R {
     op write(key: string, value: int) -> string; op read(key: string) -> int;
     happens-before(a, b): a.op == op"write" and b.op == op"read"
       and a.node == b.node and a.key == b.key and a.value == b.value;
   }`,
];

function randomHistory(rand, n) {
  const keys = ['x', 'y'];
  const ops = [];
  let clock = 0;
  for (let i = 0; i < n; i += 1) {
    const tInv = clock + Math.floor(rand() * 3);
    const tRes = tInv + 1 + Math.floor(rand() * 3);
    clock = rand() < 0.5 ? tInv + 1 : tRes; // mix concurrent and sequential
    const prev = [];
    if (i > 0 && rand() < 0.25) {
      // Causal link to an earlier op (always acyclic by construction).
      prev.push(ops[Math.floor(rand() * i)].inv);
    }
    const isWrite = rand() < 0.5;
    ops.push({
      kind: 'op',
      inv: `e${i}`,
      res: `r${i}`,
      node: `n${Math.floor(rand() * 3)}`,
      prev,
      tInv,
      tRes,
      op: isWrite ? 'write' : 'read',
      key: keys[Math.floor(rand() * keys.length)],
      value: Math.floor(rand() * 3),
      line: i + 1,
    });
  }
  return ops;
}

test('acceptance 5: <= 8 ops agree with all-permutations reference', () => {
  const compiledRules = RULE_VARIANTS.map((src) => compileProgram(typeCheck(parseDsl(src, 'test.dsl'))));
  const rand = rng(20261003);
  let compared = 0;
  let linearizable = 0;
  for (let trial = 0; trial < 400; trial += 1) {
    const n = 2 + Math.floor(rand() * 7); // 2..8 operations
    const ops = randomHistory(rand, n);
    const compiled = compiledRules[Math.floor(rand() * compiledRules.length)];
    const expected = referenceLinearizable(ops, compiled);
    const result = checkVersion(ops, compiled);
    assert.notEqual(result.verdict, 'UNKNOWN', 'complete random history must never be UNKNOWN');
    assert.equal(
      result.verdict === 'LINEARIZABLE',
      expected,
      `disagreement on trial ${trial}: ${JSON.stringify(ops)}`,
    );
    if (expected) linearizable += 1;
    compared += 1;
  }
  // Sanity: the random corpus must exercise both outcomes.
  assert.ok(linearizable > 0, 'corpus has linearizable cases');
  assert.ok(linearizable < compared, 'corpus has non-linearizable cases');
  console.log(`    compared ${compared} random histories (${linearizable} linearizable)`);
});
