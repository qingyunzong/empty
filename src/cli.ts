#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { normalize, Problem } from "./types";
import { enumerateAll, solve } from "./solver";
import { buildReport } from "./certify";
import { verifyReport } from "./verify";

function usage(): never {
  console.error(`depcycle - minimum-cost dependency cycle repair (<=18 edges)

usage:
  depcycle solve <problem.json> [--out report.json]   solve and print the repair report
  depcycle verify <problem.json> <report.json>        independently verify a report
  depcycle enumerate <problem.json>                   exhaustive cross-check only

problem format:
  {
    "edges": [{"id","from","to","cost","locked"?,"group"?}],   // <= 18 edges
    "budget": number?,                    // max total deletion cost
    "reachability": [{"from","to"}]?,     // entry->exit relations to preserve
    "groups": {"<g>": {"requires": ["<h>"]}}?  // deleting from g forces deleting all of h
  }`);
  process.exit(2);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`cannot read ${path}: ${(err as Error).message}`);
    process.exit(2);
  }
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  if (!cmd) usage();
  if (cmd === "solve") {
    const file = args[0];
    if (!file) usage();
    const outIdx = args.indexOf("--out");
    const problem = normalize(readJson(file) as Problem);
    const result = solve(problem);
    const report = buildReport(problem, result);
    const text = JSON.stringify(report, null, 2);
    if (outIdx !== -1 && args[outIdx + 1]) {
      writeFileSync(args[outIdx + 1]!, text + "\n");
      console.error(`report written to ${args[outIdx + 1]}`);
    } else {
      console.log(text);
    }
    return report.status === "optimal" ? 0 : 1;
  }
  if (cmd === "verify") {
    const [file, reportFile] = args;
    if (!file || !reportFile) usage();
    const problem = normalize(readJson(file) as Problem);
    const report = readJson(reportFile) as Parameters<typeof verifyReport>[1];
    const res = verifyReport(problem, report);
    for (const c of res.checks) {
      console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    }
    console.log(res.ok ? "VERIFY OK" : "VERIFY FAILED");
    return res.ok ? 0 : 1;
  }
  if (cmd === "enumerate") {
    const file = args[0];
    if (!file) usage();
    const problem = normalize(readJson(file) as Problem);
    const en = enumerateAll(problem);
    console.log(
      JSON.stringify(
        {
          feasible: en.bestMask !== -1,
          bestCost: en.bestMask === -1 ? null : en.bestCost,
          deletedEdges:
            en.bestMask === -1
              ? null
              : problem.edges.filter((_, i) => en.bestMask & (1 << i)).map((e) => e.id),
          subsetsChecked: en.checked,
        },
        null,
        2
      )
    );
    return en.bestMask === -1 ? 1 : 0;
  }
  usage();
}

process.exit(main(process.argv.slice(2)));
