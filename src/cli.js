#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { run } from "./interpreter.js";
import { minimalCounterexample } from "./counterexample.js";
import { InterpreterError } from "./events.js";

const USAGE = [
  "Usage:",
  "  node src/cli.js run <mode-events.jsonl|-> [--out-dir DIR]",
  "  node src/cli.js counterexample <mode-events.jsonl|->",
  "",
  "Exit codes: 0 ok, 2 usage/parse error, 13 unknown mode,",
  "14 non-monotonic clock, 15 door contradiction.",
].join("\n");

function parseJsonl(text) {
  const events = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      throw new InterpreterError(`line ${i + 1}: invalid JSON`, 2);
    }
  }
  return events;
}

function readInput(file) {
  return file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
}

function writeJsonl(file, records) {
  const body = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(file, records.length ? `${body}\n` : "");
}

function cmdRun(args) {
  const file = args[0];
  if (!file) throw new InterpreterError("missing input file", 2);
  let outDir = process.cwd();
  const idx = args.indexOf("--out-dir");
  if (idx !== -1) {
    outDir = args[idx + 1];
    if (!outDir) throw new InterpreterError("--out-dir requires a value", 2);
  }
  const events = parseJsonl(readInput(file));
  const { transitions, violations, state } = run(events);
  mkdirSync(outDir, { recursive: true });
  writeJsonl(path.join(outDir, "transition.jsonl"), transitions);
  writeJsonl(path.join(outDir, "violations.jsonl"), violations);
  const summary = {
    events: events.length,
    transitions: transitions.length,
    violations: violations.length,
    final: {
      mode: state.mode,
      door: state.door,
      curtain: state.curtain,
      production: state.production,
      speed: state.speed,
      decel: state.decel,
      keys: [...state.keys.keys()].sort(),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

function cmdCounterexample(args) {
  const file = args[0];
  if (!file) throw new InterpreterError("missing input file", 2);
  const events = parseJsonl(readInput(file));
  const result = minimalCounterexample(events);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.found) process.exitCode = 1;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "run") return cmdRun(rest);
  if (command === "counterexample") return cmdCounterexample(rest);
  throw new InterpreterError(USAGE, 2);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof InterpreterError) {
    process.stderr.write(`${err.name}: ${err.message}\n`);
    process.exitCode = err.exitCode;
  } else {
    process.stderr.write(`${err.stack ?? err}\n`);
    process.exitCode = 2;
  }
}
