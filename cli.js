#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { analyze, InfeasibleError } from "./src/index.js";
import { ValidationError } from "./src/dfa.js";
import { PlanError, PlanStore, loadPlan } from "./src/plan.js";

const EXIT_OK = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_USAGE = 2;
const EXIT_VALIDATION = 7;
const EXIT_INFEASIBLE = 8;

function usage() {
  console.error("usage:");
  console.error("  node cli.js <old.json> <new.json> <budget> [--m N] [--save plan.json]");
  console.error("  node cli.js load <plan.json>");
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ValidationError(`cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(`${path}: invalid JSON`);
  }
}

function main(argv) {
  if (argv[0] === "load") {
    if (argv.length !== 2) {
      usage();
      return EXIT_USAGE;
    }
    const plan = loadPlan(argv[1]);
    console.log(JSON.stringify(plan, null, 2));
    return EXIT_OK;
  }

  const positional = [];
  let m;
  let savePath;
  let flagError = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--m") {
      m = argv[++i];
      if (m === undefined) flagError = true;
    } else if (argv[i] === "--save") {
      savePath = argv[++i];
      if (savePath === undefined) flagError = true;
    } else if (argv[i].startsWith("--")) {
      usage();
      return EXIT_USAGE;
    } else {
      positional.push(argv[i]);
    }
  }
  if (positional.length !== 3 || flagError) {
    usage();
    return EXIT_USAGE;
  }

  const [oldPath, newPath, budgetArg] = positional;
  const options = {};
  if (m !== undefined) {
    const parsed = Number(m);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new ValidationError(`--m must be a non-negative integer, got ${JSON.stringify(m)}`);
    }
    options.m = parsed;
  }

  const oldRaw = readJson(oldPath);
  const newRaw = readJson(newPath);
  const result = analyze(oldRaw, newRaw, budgetArg, options);

  if (savePath !== undefined) {
    const store = new PlanStore(savePath);
    store.save(result);
  }
  console.log(JSON.stringify(result, null, 2));
  return EXIT_OK;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (err instanceof InfeasibleError) {
    console.log("INFEASIBLE");
    console.error(err.message);
    process.exitCode = EXIT_INFEASIBLE;
  } else if (err instanceof ValidationError || err instanceof PlanError) {
    console.error(`error: ${err.message}`);
    process.exitCode = EXIT_VALIDATION;
  } else {
    console.error(`unexpected error: ${err.stack || err.message}`);
    process.exitCode = EXIT_UNEXPECTED;
  }
}
