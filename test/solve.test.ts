import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSpec } from "../src/model.js";
import { solve } from "../src/solve.js";

test("找到差异: 已指定字段更少的见证优先", () => {
  const spec = parseSpec({
    attributes: { a: ["0", "1"], b: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [{ when: { a: "0" }, decision: "X" }] },
      B: { default: "Y", rules: [] },
    },
  });
  const result = solve(spec);
  assert.equal(result.verdict, "DIFFERENT");
  assert.deepEqual(result.witness!.assignment, { a: "0" });
  assert.equal(result.witness!.specifiedFields, 1);
  assert.deepEqual(result.witness!.decisions, { A: "X", B: "Y" });
  assert.equal(result.crossCheck.enumeration, "ok");
  assert.equal(result.crossCheck.evaluation, "ok");
});

test("找到差异: 部分赋值下未确定的策略不构成见证", () => {
  const spec = parseSpec({
    attributes: { role: ["admin", "user"], mfa: ["on", "off"] },
    policies: {
      A: { default: "deny", rules: [{ when: { role: "admin" }, decision: "permit" }] },
      B: { default: "deny", rules: [{ when: { role: "admin", mfa: "on" }, decision: "permit" }] },
    },
  });
  const result = solve(spec);
  assert.equal(result.verdict, "DIFFERENT");
  assert.deepEqual(result.witness!.assignment, { mfa: "off", role: "admin" });
  assert.deepEqual(result.witness!.decisions, { A: "permit", B: "deny" });
});

test("同层多个见证按取值序取先", () => {
  const spec = parseSpec({
    attributes: { a: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [{ when: { a: "0" }, decision: "X" }] },
      B: { default: "Y", rules: [{ when: { a: "1" }, decision: "X" }] },
    },
  });
  const result = solve(spec);
  assert.equal(result.verdict, "DIFFERENT");
  assert.deepEqual(result.witness!.assignment, { a: "0" });
});

test("同层多个见证按字段取值元组序取先", () => {
  const spec = parseSpec({
    attributes: { a: ["0", "1"], b: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [{ when: { a: "0" }, decision: "X" }] },
      B: { default: "Y", rules: [{ when: { b: "0" }, decision: "X" }] },
    },
  });
  const result = solve(spec);
  assert.equal(result.verdict, "DIFFERENT");
  assert.equal(result.witness!.specifiedFields, 2);
  assert.deepEqual(result.witness!.assignment, { a: "0", b: "1" });
  assert.equal(result.evaluated, 7);
});

test("无差异: 穷尽后给出 EQUIVALENT 结论", () => {
  const spec = parseSpec({
    attributes: { role: ["admin", "user"], mfa: ["on", "off"] },
    policies: {
      A: { default: "deny", rules: [{ when: { role: "admin" }, decision: "permit" }] },
      B: {
        default: "deny",
        rules: [
          { when: { role: "admin", mfa: "on" }, decision: "permit" },
          { when: { role: "admin", mfa: "off" }, decision: "permit" },
        ],
      },
    },
  });
  const result = solve(spec);
  assert.equal(result.verdict, "EQUIVALENT");
  assert.equal(result.witness, null);
  assert.equal(result.evaluated, 9);
  assert.equal(result.spaceSize, "9");
});

test("预算耗尽: 给出 UNDECIDED 且已求值数等于预算", () => {
  const spec = parseSpec({
    attributes: { a: ["0", "1"], b: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [{ when: { a: "1", b: "1" }, decision: "X" }] },
      B: { default: "Y", rules: [] },
    },
    budget: 3,
  });
  const result = solve(spec);
  assert.equal(result.verdict, "UNDECIDED");
  assert.equal(result.evaluated, 3);
  assert.equal(result.spaceSize, "9");
});

test("预算恰好覆盖整个空间时仍为穷尽结论", () => {
  const spec = parseSpec({
    attributes: { a: ["0", "1"] },
    policies: {
      A: { default: "Y", rules: [] },
      B: { default: "Y", rules: [{ when: { a: "0" }, decision: "Y" }] },
    },
    budget: 3,
  });
  const result = solve(spec);
  assert.equal(result.verdict, "EQUIVALENT");
  assert.equal(result.evaluated, 3);
});

test("默认预算生效", () => {
  const spec = parseSpec({
    attributes: { a: ["0"] },
    policies: {
      A: { default: "X", rules: [] },
      B: { default: "X", rules: [] },
    },
  });
  assert.equal(spec.budget, 1_000_000);
  assert.equal(solve(spec).verdict, "EQUIVALENT");
});
