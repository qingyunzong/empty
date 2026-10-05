#!/usr/bin/env node
// policy-intersect: compute the intersection of two URL policies.
//
// Usage:
//   node dist/src/cli.js <input.json>     read { "policyA": ..., "policyB": ... } from a file
//   node dist/src/cli.js -                read the same JSON from stdin
//
// Exit codes:
//   0  intersection computed (redirect verdict may be equivalent|different|unknown)
//   1  bad input / usage
//   2  empty intersection (explicitly forbidden)
//   3  internal cross-check failure

import { readFileSync } from "node:fs";
import { normalizePolicy, PolicyInput } from "./types.js";
import { intersectPolicies, isEmpty, policyToJSON, witnessUrl } from "./intersect.js";
import { buildUniverse, crossCheck } from "./enumerate.js";
import { verifyRedirectEquivalence } from "./chains.js";

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: policy-intersect <input.json | ->");
    process.exit(1);
  }

  let raw: string;
  try {
    raw = arg === "-" ? readFileSync(0, "utf8") : readFileSync(arg, "utf8");
  } catch {
    console.error(`cannot read input: ${arg}`);
    process.exit(1);
  }

  let doc: { policyA?: PolicyInput; policyB?: PolicyInput };
  try {
    doc = JSON.parse(raw);
  } catch {
    console.error("input is not valid JSON");
    process.exit(1);
  }
  if (!doc.policyA || !doc.policyB) {
    console.error('input must contain "policyA" and "policyB"');
    process.exit(1);
  }

  let a, b;
  try {
    a = normalizePolicy(doc.policyA, "A");
    b = normalizePolicy(doc.policyB, "B");
  } catch (err) {
    console.error(`invalid policy: ${(err as Error).message}`);
    process.exit(1);
  }

  const result = intersectPolicies(a, b);
  if (isEmpty(result)) {
    console.log(
      JSON.stringify(
        { status: "empty-intersection", reasons: result.emptyReasons },
        null,
        2
      )
    );
    process.exit(2);
  }

  const witness = witnessUrl(result, a, b);
  const universe = buildUniverse([a, b, result.policy]);
  const check = crossCheck(a, b, result.policy, universe);
  const redirect = verifyRedirectEquivalence(a, b, result.policy, universe);

  const ok = check.mismatches.length === 0 && redirect.status !== "different";
  console.log(
    JSON.stringify(
      {
        status: ok ? "ok" : "internal-mismatch",
        intersection: policyToJSON(result.policy),
        witness,
        smallDomainCheck: {
          universeSize: check.universeSize,
          urlsChecked: check.urlsChecked,
          mismatches: check.mismatches,
        },
        redirect,
      },
      null,
      2
    )
  );
  process.exit(ok ? 0 : 3);
}

main();
