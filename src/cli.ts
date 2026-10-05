import { readFileSync } from "node:fs";
import { parseInstance } from "./parse.js";
import { solve } from "./solve.js";
import { enumerateAll } from "./enumerate.js";
import { buildCertificate, type Certificate } from "./certificate.js";
import type { Candidate } from "./types.js";

function usage(): number {
  console.error("usage: teamforge <input.json | -> [--verify] [--json]");
  console.error("  --verify  cross-check against exhaustive enumeration (small instances)");
  console.error("  --json    emit machine-readable JSON report");
  return 2;
}

function renderReport(best: Candidate, certificate: Certificate): string {
  const lines: string[] = [];
  lines.push(`Optimal team: cost=${best.cost}, size=${best.size}`);
  lines.push(`Members: ${best.ids.join(", ")}`);
  lines.push("");
  lines.push("Skill counts:");
  for (const row of certificate.skills) {
    lines.push(`  ${row.skill}: ${row.count} (min ${row.required}) ${row.ok ? "OK" : "FAIL"}`);
  }
  lines.push("");
  const pairCount = certificate.forbiddenPairs.length;
  lines.push(`Forbidden-pair certificate (${pairCount} ${pairCount === 1 ? "pair" : "pairs"}):`);
  for (const row of certificate.forbiddenPairs) {
    const mark = row.ok ? "OK" : "FAIL";
    lines.push(`  ${row.a} ~ ${row.b}: ${row.a}=${row.aIn ? "in" : "out"}, ${row.b}=${row.bIn ? "in" : "out"} ${mark}`);
  }
  lines.push(`Certificate: ${certificate.ok ? "ALL CHECKS PASSED" : "CHECKS FAILED"}`);
  return lines.join("\n");
}

function main(): number {
  const args = process.argv.slice(2);
  let file: string | null = null;
  let verify = false;
  let jsonOut = false;
  for (const arg of args) {
    if (arg === "--verify") verify = true;
    else if (arg === "--json") jsonOut = true;
    else if (file === null) file = arg;
    else return usage();
  }
  if (file === null) return usage();

  let rawText: string;
  try {
    rawText = file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  } catch (error) {
    console.error(`error: cannot read ${file}: ${(error as Error).message}`);
    return 2;
  }

  let instance;
  try {
    instance = parseInstance(JSON.parse(rawText));
  } catch (error) {
    console.error(`error: invalid input: ${(error as Error).message}`);
    return 2;
  }

  const best = solve(instance);
  if (best === null) {
    const message = "no feasible team exists (skill minimums and forbidden pairs cannot be satisfied)";
    if (jsonOut) console.log(JSON.stringify({ feasible: false, message }, null, 2));
    else console.log(message);
    return 1;
  }

  const certificate = buildCertificate(instance, best.indices);

  let verification: { teamsEnumerated: number; feasibleTeams: number; matchesEnumeration: boolean } | null = null;
  if (verify) {
    const enumeration = enumerateAll(instance);
    const matches =
      enumeration.best !== null &&
      enumeration.best.cost === best.cost &&
      enumeration.best.size === best.size &&
      enumeration.best.ids.join(" ") === best.ids.join(" ");
    verification = {
      teamsEnumerated: enumeration.totalTeams,
      feasibleTeams: enumeration.feasibleTeams,
      matchesEnumeration: matches,
    };
    if (!matches) {
      console.error("error: branch-and-bound result disagrees with exhaustive enumeration");
      return 3;
    }
  }

  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          feasible: true,
          cost: best.cost,
          size: best.size,
          members: best.ids,
          certificate,
          verification,
        },
        null,
        2
      )
    );
  } else {
    console.log(renderReport(best, certificate));
    if (verification !== null) {
      console.log(
        `Exhaustive verification: ${verification.teamsEnumerated} teams enumerated, ` +
          `${verification.feasibleTeams} feasible, optimum confirmed`
      );
    }
  }
  return certificate.ok ? 0 : 3;
}

process.exitCode = main();
