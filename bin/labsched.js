#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { Engine } = require("../src/engine");
const { Journal } = require("../src/journal");
const { LabError, EXIT_DATA_ERROR } = require("../src/errors");

const USAGE = `Usage: node bin/labsched.js [--journal PATH] [--config JSON] [input.jsonl]

Reads JSONL ops (enqueue/correct/budget/abort/undo) from a file or stdin,
prints channel timelines, failure codes and the deterministic log root as
JSON. Exits 5 on VOLUME_EXCEEDS_PLATE, BUDGET_NEGATIVE, COOLDOWN_CONFLICT.
With --journal, ops are appended to a hash-chained log; an existing log is
recovered first (torn tail truncated, already-applied op ids skipped).`;

function parseArgs(argv) {
  const args = { config: {}, journalPath: null, inputFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--journal") args.journalPath = argv[++i];
    else if (a === "--config") args.config = JSON.parse(argv[++i]);
    else if (a === "--help" || a === "-h") {
      process.stdout.write(USAGE + "\n");
      process.exit(0);
    } else if (!a.startsWith("--")) args.inputFile = a;
    else {
      process.stderr.write(`unknown option: ${a}\n`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.inputFile ? fs.readFileSync(args.inputFile, "utf8") : fs.readFileSync(0, "utf8");
  const engine = new Engine(args.config);
  if (args.journalPath) {
    const journal = new Journal(args.journalPath);
    journal.recoverInto(engine);
    engine.journal = journal;
  }
  let fatal = null;
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let op;
    try {
      op = JSON.parse(trimmed);
    } catch {
      engine.failures.push({ code: "INVALID_JSON", message: "could not parse line", line: trimmed.slice(0, 120) });
      continue;
    }
    try {
      engine.applyOp(op);
    } catch (err) {
      if (err instanceof LabError) {
        fatal = err;
        break;
      }
      throw err;
    }
  }
  engine.finish();
  const out = engine.getOutput();
  if (fatal) out.error = { code: fatal.code, message: fatal.message };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  if (fatal) {
    process.stderr.write(`${fatal.code}: ${fatal.message}\n`);
    process.exitCode = EXIT_DATA_ERROR;
  }
}

main();
