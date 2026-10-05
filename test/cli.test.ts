import { test } from "node:test";
import { equal, ok } from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";

interface CliOut {
  code: number;
  // Parsed stdout JSON; shape varies per command.
  // eslint-disable-next-line
  json: any;
  stderr: string;
}

function run(args: string[]): CliOut {
  const res = runCli(args);
  return { code: res.code, json: JSON.parse(res.stdout), stderr: res.stderr };
}

function writeRule(dir: string, name: string, rule: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(rule));
  return path;
}

const RULE_A = {
  name: "A",
  protocols: ["https"],
  ports: [443],
  exactDomains: ["status.example.com"],
  wildcardDomains: ["*.example.com"],
  allowSubdomains: ["api.partner.net"],
  excludeSubdomains: ["evil.example.com"],
  maxRedirects: 2,
};

const RULE_B = {
  name: "B",
  protocols: ["https"],
  ports: [443],
  wildcardDomains: ["*.api.example.com", "*.partner.net"],
  allowSubdomains: ["status.example.com"],
  excludeSubdomains: ["staging.api.example.com"],
  maxRedirects: 3,
};

test("cli intersect: canonical rule, witness and cross-checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-cli-"));
  const a = writeRule(dir, "a.json", RULE_A);
  const b = writeRule(dir, "b.json", RULE_B);
  const out = run(["intersect", a, b]);
  equal(out.code, 0, out.stderr);
  equal(out.json.status, "ok");
  equal(out.json.witnessAcceptedByAll, true);
  ok(out.json.urlCrossCheck.ok);
  ok(out.json.chainCrossCheck.ok);
  // Canonical intersection: deeper wildcard root + shared exact hosts, min budget.
  ok(out.json.intersection.wildcardDomains.includes("api.example.com"));
  ok(out.json.intersection.exactDomains.includes("status.example.com"));
  ok(out.json.intersection.exactDomains.includes("api.partner.net"));
  equal(out.json.intersection.maxRedirects, 2);
  // The witness must not be an excluded host.
  ok(!out.json.witness.includes("evil.example.com"));
  ok(!out.json.witness.includes("staging.api.example.com"));
});

test("cli intersect: empty intersection is explicitly forbidden (exit 2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-cli-"));
  const a = writeRule(dir, "a.json", RULE_A);
  const c = writeRule(dir, "c.json", {
    protocols: ["http"],
    ports: [8080],
    exactDomains: ["other.org"],
    maxRedirects: 1,
  });
  const out = run(["intersect", a, c]);
  equal(out.code, 2);
  equal(out.json.status, "empty-intersection");
  equal(out.json.forbidden, true);
  ok(out.json.reasons.length > 0);
  ok(/empty intersection/.test(out.stderr));
});

test("cli equiv: equivalent, not-equivalent and unknown outcomes", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-cli-"));
  const a = writeRule(dir, "a.json", RULE_A);
  const aCopy = writeRule(dir, "a-copy.json", RULE_A);
  const b = writeRule(dir, "b.json", RULE_B);
  const open = writeRule(dir, "open.json", { ...RULE_B, maxRedirects: null });

  const same = run(["equiv", a, aCopy]);
  equal(same.code, 0, same.stderr);
  equal(same.json.status, "equivalent");
  equal(same.json.proof.type, "finite-state-equivalence-proof");
  ok(same.json.proof.chainCrossCheck.ok);

  const diff = run(["equiv", a, b]);
  equal(diff.code, 0, diff.stderr);
  equal(diff.json.status, "not-equivalent");
  ok(Array.isArray(diff.json.distinguishingChain));
  ok(diff.json.distinguishingChain.length >= 1);
  ok(["A", "B"].includes(diff.json.acceptedBy));

  const unknown = run(["equiv", a, open]);
  equal(unknown.code, 0, unknown.stderr);
  equal(unknown.json.status, "unknown");
  ok(/unclosed redirect budget/.test(unknown.json.reason));
});

test("cli match and usage errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-cli-"));
  const a = writeRule(dir, "a.json", RULE_A);
  equal(run(["match", a, "https://api.example.com/"]).json.match, true);
  equal(
    run(["match", a, "https://example.com/"]).json.match,
    false,
    "wildcard must not match the root domain"
  );
  equal(run(["match", a, "https://evil.example.com/"]).json.match, false);
  const noArgs = runCli([]);
  equal(noArgs.code, 1);
  ok(/usage:/.test(noArgs.stderr));
  equal(runCli(["intersect", a, join(dir, "missing.json")]).code, 1);
});
