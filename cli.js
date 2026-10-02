#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ExitError,
  normalizePolicy,
  normalizeStock,
  parseDefectsJsonl,
  decideAll,
  buildLedger,
  verifyLedger,
  violatedConstraints,
  minimalMissingConstraints,
} = require("./src");

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      opts[arg.slice(2)] = argv[++i];
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function required(opts, name) {
  if (!opts[name]) throw new ExitError(`missing required argument --${name}`, 2);
  return opts[name];
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function loadInputs(opts) {
  const policy = normalizePolicy(readJson(required(opts, "policy")));
  const stock = normalizeStock(readJson(required(opts, "stock")));
  const entries = parseDefectsJsonl(fs.readFileSync(required(opts, "defects"), "utf8"), policy);
  return { policy, stock, entries };
}

function cmdRun(opts) {
  const { policy, stock, entries } = loadInputs(opts);
  const defects = entries.filter((e) => e.kind === "defect").map((e) => e.defect);
  const decisions = decideAll(defects, policy, stock);
  const { entries: ledgerEntries, cancelled, final } = buildLedger(entries, decisions, policy, stock);

  const outdir = opts.outdir || ".";
  const decisionLines = defects.map((defect) => {
    const decision = { ...decisions.get(defect.id) };
    if (cancelled.has(defect.id)) decision.cancelled = true;
    return JSON.stringify(decision);
  });
  fs.writeFileSync(path.join(outdir, "decision.jsonl"), decisionLines.join("\n") + "\n");
  fs.writeFileSync(
    path.join(outdir, "ledger.jsonl"),
    ledgerEntries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  );
  console.log(
    JSON.stringify(
      {
        decisions: decisionLines.length,
        ledgerEntries: ledgerEntries.length,
        final,
      },
      null,
      2
    )
  );
}

function cmdAudit(opts) {
  const policy = normalizePolicy(readJson(required(opts, "policy")));
  const stock = normalizeStock(readJson(required(opts, "stock")));
  const ledgerEntries = readJsonl(required(opts, "ledger"));
  const result = verifyLedger(policy, stock, ledgerEntries);
  if (result.ok) {
    console.log("AUDIT OK");
    console.log(JSON.stringify({ final: result.final }, null, 2));
  } else {
    console.log("AUDIT FAILED");
    for (const violation of result.violations) console.log(` - ${violation}`);
    process.exitCode = 1;
  }
}

function cmdCounterexample(opts) {
  const { policy, stock, entries } = loadInputs(opts);
  const defectsById = new Map(
    entries.filter((e) => e.kind === "defect").map((e) => [e.defect.id, e.defect])
  );
  const proposed = readJsonl(required(opts, "decision"));
  const reworkIds = proposed.filter((d) => d.action === "rework").map((d) => d.id);
  const violated = violatedConstraints(reworkIds, defectsById, policy, stock);
  const minimalMissing = minimalMissingConstraints(reworkIds, defectsById, policy, stock);
  console.log(JSON.stringify({ reworkIds, violated, minimalMissing }, null, 2));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  switch (command) {
    case "run":
      return cmdRun(opts);
    case "audit":
      return cmdAudit(opts);
    case "counterexample":
      return cmdCounterexample(opts);
    default:
      console.error(
        "usage: node cli.js <run|audit|counterexample> " +
          "--defects defects.jsonl --policy policy.json --stock stock.json [--outdir .] [--ledger ledger.jsonl] [--decision decision.jsonl]"
      );
      process.exit(2);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ExitError) {
    console.error(err.message);
    process.exitCode = err.exitCode;
  } else {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  }
}
