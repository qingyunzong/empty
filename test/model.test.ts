import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RULES,
  parseSpec,
  possibleDecisions,
  possibleDecisionsBrute,
  type Policy,
} from "../src/model.js";
import { enumerateRecursive } from "../src/enumerate.js";

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOMAINS = [
  ["x", "y"],
  ["1", "2", "3"],
];

test("空策略: 任何赋值只有 default 决议", () => {
  const policy: Policy = { defaultDecision: "deny", rules: [] };
  const decisions = possibleDecisions(policy, DOMAINS, [-1, -1]);
  assert.deepEqual([...decisions], ["deny"]);
});

test("首条存活规则确定时决议唯一", () => {
  const policy: Policy = {
    defaultDecision: "deny",
    rules: [{ when: [[0, 0]], decision: "permit" }],
  };
  assert.deepEqual([...possibleDecisions(policy, DOMAINS, [0, -1])], ["permit"]);
});

test("首条存活规则不确定时决议集合含后续可能", () => {
  const policy: Policy = {
    defaultDecision: "deny",
    rules: [{ when: [[0, 0], [1, 0]], decision: "permit" }],
  };
  const decisions = possibleDecisions(policy, DOMAINS, [0, -1]);
  assert.deepEqual([...decisions].sort(), ["deny", "permit"]);
});

test("域大小为 1 时不确定规则退化为确定", () => {
  const policy: Policy = {
    defaultDecision: "deny",
    rules: [{ when: [[0, 0]], decision: "permit" }],
  };
  const decisions = possibleDecisions(policy, [["only"]], [-1]);
  assert.deepEqual([...decisions], ["permit"]);
});

test("精确求值器与暴力补全求值器在随机策略上全部一致", () => {
  const rand = mulberry32(20261005);
  for (let trial = 0; trial < 40; trial++) {
    const attrCount = 1 + Math.floor(rand() * 3);
    const domains: string[][] = [];
    for (let a = 0; a < attrCount; a++) {
      const size = 1 + Math.floor(rand() * 3);
      domains.push(Array.from({ length: size }, (_, i) => `v${i}`));
    }
    const decisionsPool = ["allow", "deny", "audit"];
    const policies: Policy[] = [];
    for (let p = 0; p < 2; p++) {
      const ruleCount = Math.floor(rand() * 5);
      const rules = [];
      for (let r = 0; r < ruleCount; r++) {
        const when: [number, number][] = [];
        for (let a = 0; a < attrCount; a++) {
          if (rand() < 0.5) when.push([a, Math.floor(rand() * domains[a]!.length)]);
        }
        rules.push({ when, decision: decisionsPool[Math.floor(rand() * 3)]! });
      }
      policies.push({ defaultDecision: decisionsPool[Math.floor(rand() * 3)]!, rules });
    }
    for (const assignment of enumerateRecursive(domains)) {
      for (const policy of policies) {
        const exact = possibleDecisions(policy, domains, assignment);
        const brute = possibleDecisionsBrute(policy, domains, assignment);
        assert.deepEqual([...exact].sort(), [...brute].sort());
      }
    }
  }
});

test("parseSpec 拒绝超过 20 条规则的策略", () => {
  const rules = Array.from({ length: MAX_RULES + 1 }, () => ({ when: {}, decision: "x" }));
  assert.throws(() =>
    parseSpec({
      attributes: { a: ["v"] },
      policies: {
        A: { default: "x", rules },
        B: { default: "x", rules: [] },
      },
    })
  );
});

test("parseSpec 接受恰好 20 条规则", () => {
  const rules = Array.from({ length: MAX_RULES }, () => ({ when: {}, decision: "x" }));
  const spec = parseSpec({
    attributes: { a: ["v"] },
    policies: {
      A: { default: "x", rules },
      B: { default: "x", rules: [] },
    },
  });
  assert.equal(spec.policies[0].rules.length, MAX_RULES);
});

test("parseSpec 校验策略数量、未知属性、域外取值、空域、重复域值", () => {
  const base = {
    attributes: { a: ["v1", "v2"] },
    policies: { A: { default: "x", rules: [] }, B: { default: "x", rules: [] } },
  };
  assert.throws(() => parseSpec({ ...base, policies: { A: { default: "x", rules: [] } } }));
  assert.throws(() =>
    parseSpec({
      ...base,
      policies: {
        A: { default: "x", rules: [{ when: { ghost: "v1" }, decision: "y" }] },
        B: { default: "x", rules: [] },
      },
    })
  );
  assert.throws(() =>
    parseSpec({
      ...base,
      policies: {
        A: { default: "x", rules: [{ when: { a: "nope" }, decision: "y" }] },
        B: { default: "x", rules: [] },
      },
    })
  );
  assert.throws(() => parseSpec({ ...base, attributes: { a: [] } }));
  assert.throws(() => parseSpec({ ...base, attributes: { a: ["v", "v"] } }));
  assert.throws(() => parseSpec({ ...base, budget: 0 }));
});
