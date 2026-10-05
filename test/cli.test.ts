import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync } from "node:fs";

const CLI = "dist/src/cli.js";

// The sandbox blocks spawnSync and swallows piped stdout of grandchildren,
// so the CLI is spawned asynchronously with stdout redirected to a file.
let counter = 0;
function runCli(args: string[], input: string | null = null): Promise<{ code: number; out: Record<string, unknown> }> {
  const outFile = `/tmp/policy-intersect-cli-${process.pid}-${counter++}.json`;
  return new Promise((resolve, reject) => {
    const fd = openSync(outFile, "w");
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: [input === null ? "ignore" : "pipe", fd, fd],
    });
    if (input !== null) child.stdin.end(input);
    child.on("error", reject);
    child.on("close", (code) => {
      closeSync(fd);
      const text = readFileSync(outFile, "utf8");
      unlinkSync(outFile);
      resolve({ code: code ?? -1, out: text.trim() === "" ? {} : JSON.parse(text) });
    });
  });
}

test("cli: ok case prints canonical intersection, witness and equivalence proof", async () => {
  const { code, out } = await runCli(["fixtures/ok.json"]);
  assert.equal(code, 0);
  assert.equal(out.status, "ok");
  const intersection = out.intersection as {
    protocols: string[];
    ports: number[];
    domains: { kind: string; domain: string; allow: string[] | null; exclude: string[] }[];
    redirectBudget: number;
  };
  assert.deepEqual(intersection.protocols, ["https"]);
  assert.deepEqual(intersection.ports, [443]);
  assert.deepEqual(intersection.redirectBudget, 2);
  assert.deepEqual(
    intersection.domains.map((d) => `${d.kind}:${d.domain}`),
    ["wildcard:example.com"]
  );
  assert.deepEqual(intersection.domains[0]!.allow, ["api"]);
  assert.deepEqual(intersection.domains[0]!.exclude, ["www"]);
  assert.equal(out.witness, "https://api.example.com/");
  const check = out.smallDomainCheck as { universeSize: number; mismatches: unknown[] };
  assert.ok(check.universeSize > 0);
  assert.deepEqual(check.mismatches, []);
  const redirect = out.redirect as { status: string; proof?: { chainsEnumerated: number } };
  assert.equal(redirect.status, "equivalent");
  assert.ok(redirect.proof!.chainsEnumerated > 0);
});

test("cli: empty intersection is an explicit error with exit code 2", async () => {
  const { code, out } = await runCli(["fixtures/empty.json"]);
  assert.equal(code, 2);
  assert.equal(out.status, "empty-intersection");
  const reasons = out.reasons as string[];
  assert.ok(reasons.includes("protocols are disjoint"));
});

test("cli: unbounded redirect budget yields an unknown verdict", async () => {
  const { code, out } = await runCli(["fixtures/unbounded.json"]);
  assert.equal(code, 0);
  assert.equal(out.status, "ok");
  const redirect = out.redirect as { status: string; reason: string };
  assert.equal(redirect.status, "unknown");
  assert.match(redirect.reason, /unbounded/);
});

test("cli: reads policies from stdin with '-'", async () => {
  const input = JSON.stringify({
    policyA: { protocols: ["https"], exactDomains: ["a.com"], redirectBudget: 1 },
    policyB: { protocols: ["https"], exactDomains: ["a.com"], redirectBudget: 1 },
  });
  const { code, out } = await runCli(["-"], input);
  assert.equal(code, 0);
  assert.equal(out.witness, "https://a.com/");
});
