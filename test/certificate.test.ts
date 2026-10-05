import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSequence,
  verifyCertificate,
  type Grammar,
} from "../src/index.ts";

// S -> f(S) (2) | a (5);  input "f a" has the unique derivation [0, 1], cost 7.
const G: Grammar = {
  arity: { a: 0, f: 1 },
  nonterminals: ["S"],
  start: "S",
  rules: [
    { id: 0, lhs: "S", symbol: "f", children: ["S"], cost: 2 },
    { id: 1, lhs: "S", symbol: "a", children: [], cost: 5 },
  ],
};

function freshCertificate() {
  const result = parseSequence(G, ["f", "a"]);
  assert.ok(result.certificate);
  return { tree: result.tree, cert: result.certificate };
}

test("a genuine certificate verifies", () => {
  const { tree, cert } = freshCertificate();
  assert.deepEqual(cert, { ruleIds: [0, 1], cost: 7 });
  assert.deepEqual(verifyCertificate(G, tree, cert), { ok: true });
});

test("a wrong claimed cost is rejected", () => {
  const { tree, cert } = freshCertificate();
  const verdict = verifyCertificate(G, tree, { ruleIds: cert.ruleIds, cost: 6 });
  assert.equal(verdict.ok, false);
});

test("a reordered rule id sequence is rejected", () => {
  const { tree } = freshCertificate();
  const verdict = verifyCertificate(G, tree, { ruleIds: [1, 0], cost: 7 });
  assert.equal(verdict.ok, false);
});

test("a truncated rule id sequence is rejected", () => {
  const { tree } = freshCertificate();
  const verdict = verifyCertificate(G, tree, { ruleIds: [0], cost: 2 });
  assert.equal(verdict.ok, false);
});

test("extra rule ids are rejected", () => {
  const { tree } = freshCertificate();
  const verdict = verifyCertificate(G, tree, { ruleIds: [0, 1, 1], cost: 12 });
  assert.equal(verdict.ok, false);
});

test("unknown rule ids are rejected", () => {
  const { tree } = freshCertificate();
  const verdict = verifyCertificate(G, tree, { ruleIds: [0, 99], cost: 7 });
  assert.equal(verdict.ok, false);
});

test("a certificate is tied to its input tree", () => {
  const { cert } = freshCertificate();
  const other = parseSequence(G, ["a"]);
  const verdict = verifyCertificate(G, other.tree, cert);
  assert.equal(verdict.ok, false);
});
