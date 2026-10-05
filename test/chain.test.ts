import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadGraph } from "../src/graph";
import { runCli } from "../src/cli";
import {
  verify,
  selectChain,
  selectChainByEnumeration,
  enumeratePaths,
  compareIdSeq,
} from "../src/chain";
import { VerifyRequest } from "../src/types";

const FIXTURE = join(__dirname, "..", "..", "fixtures", "graph.json");
const AT = "2025-06-01T00:00:00Z";

const graph = loadGraph(FIXTURE);

function req(leaf: string, usage = "serverAuth"): VerifyRequest {
  return { leaf, usage, at: AT };
}

test("valid chain: leaf -> intermediate -> trusted root", () => {
  const r = verify(graph, req("leafA"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.chain, ["leafA", "inter1", "rootA"]);
  assert.equal(r.failures.length, 0);
  assert.equal(r.crossCheck.agree, true);
});

test("selection prefers the shortest chain", () => {
  const r = verify(graph, req("leafB"));
  assert.deepEqual(r.chain, ["leafB", "interShort", "rootA"]);
});

test("ties on length are broken by id-sequence order", () => {
  const r = verify(graph, req("leafC"));
  assert.deepEqual(r.chain, ["leafC", "interA", "rootA"]);
});

test("expired intermediate fails with an explicit reason", () => {
  const r = verify(graph, req("leafExpired"));
  assert.equal(r.ok, false);
  assert.equal(r.chain, null);
  assert.ok(
    r.failures.some((f) =>
      f.reasons.some(
        (x) => x.includes("interExpired") && x.includes("expired"),
      ),
    ),
  );
});

test("requested usage must be in the chain usage intersection", () => {
  const r = verify(graph, req("leafUsage"));
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) =>
      f.reasons.some(
        (x) => x.includes("serverAuth") && x.includes("interNoUsage"),
      ),
    ),
  );
});

test("untrusted root fails with an explicit reason", () => {
  const r = verify(graph, req("leafUntrusted"));
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) =>
      f.reasons.some((x) => x.includes("rootZ") && x.includes("not trusted")),
    ),
  );
});

test("chains longer than 12 certs are rejected", () => {
  const r = verify(graph, req("leafDeep"));
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) => f.reasons.some((x) => x.includes("max 12"))),
  );
  const { truncated } = enumeratePaths(graph, "leafDeep");
  assert.ok(truncated.every((p) => p.length === 12));
});

test("unknown leaf reports a failure reason", () => {
  const r = verify(graph, req("nope"));
  assert.equal(r.ok, false);
  assert.ok(
    r.failures.some((f) => f.reasons.some((x) => x.includes("unknown leaf"))),
  );
});

test("cross-check: BFS selection matches simple-path enumeration on all leaves", () => {
  for (const cert of graph.certs) {
    for (const usage of ["serverAuth", "clientAuth", "emailProtection"]) {
      const request = req(cert.id, usage);
      const a = selectChain(graph, request);
      const b = selectChainByEnumeration(graph, request);
      assert.deepEqual(a, b, `mismatch for leaf=${cert.id} usage=${usage}`);
    }
  }
});

test("compareIdSeq orders element by element", () => {
  assert.ok(compareIdSeq(["a", "b"], ["a", "c"]) < 0);
  assert.ok(compareIdSeq(["a", "c"], ["a", "b"]) > 0);
  assert.equal(compareIdSeq(["a"], ["a"]), 0);
});

test("cli: verifies a chain and matches an explicit expectation", () => {
  const { code, report } = runCli([
    "--graph", FIXTURE,
    "--leaf", "leafA",
    "--usage", "serverAuth",
    "--at", AT,
    "--expect-ok",
    "--expect-chain", "leafA,inter1,rootA",
  ]);
  assert.equal(code, 0);
  const out = report as any;
  assert.equal(out.ok, true);
  assert.equal(out.expectation.match, true);
  assert.equal(out.crossCheck.agree, true);
});

test("cli: exit 1 when explicit expectation mismatches", () => {
  const { code, report } = runCli([
    "--graph", FIXTURE,
    "--leaf", "leafA",
    "--usage", "serverAuth",
    "--at", AT,
    "--expect-chain", "leafA,inter1,rootZ",
  ]);
  assert.equal(code, 1);
  const out = report as any;
  assert.equal(out.expectation.match, false);
  assert.ok(out.expectation.mismatches.length > 0);
});

test("cli: failing verification reports reasons and matches expect-fail", () => {
  const { code, report } = runCli([
    "--graph", FIXTURE,
    "--leaf", "leafExpired",
    "--usage", "serverAuth",
    "--at", AT,
    "--expect-fail",
  ]);
  assert.equal(code, 0, "expect-fail matches a failed verification");
  const out = report as any;
  assert.equal(out.ok, false);
  assert.ok(out.failures.length > 0);
});

test("cli: invalid arguments exit with code 2", () => {
  assert.equal(runCli(["--graph", FIXTURE]).code, 2);
  assert.equal(
    runCli([
      "--graph", FIXTURE,
      "--leaf", "leafA",
      "--usage", "serverAuth",
      "--expect-ok",
      "--expect-fail",
    ]).code,
    2,
  );
  assert.equal(
    runCli([
      "--graph", join(FIXTURE, "..", "missing.json"),
      "--leaf", "leafA",
      "--usage", "serverAuth",
    ]).code,
    2,
  );
});
