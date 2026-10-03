#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { Tracker } from "./tracker.js";

export const USAGE =
  "Usage: node src/cli.js tracks --in <events.jsonl> [--out <actions.jsonl>]";

function parseArgs(args) {
  const [command, ...rest] = args;
  if (command !== "tracks") return null;
  const options = { in: null, out: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--in") options.in = rest[++i];
    else if (rest[i] === "--out") options.out = rest[++i];
    else return null;
  }
  return options.in ? options : null;
}

// Runs the CLI. IO sinks are injectable so tests can run in-process.
// Returns the process exit code.
export function run(args, io = {}) {
  const writeOut = io.stdout ?? ((text) => stdout.write(text));
  const writeErr = io.stderr ?? ((text) => stderr.write(text));

  const options = parseArgs(args);
  if (!options) {
    writeErr(`${USAGE}\n`);
    return 1;
  }

  const tracker = new Tracker();
  const lines = readFileSync(options.in, "utf8").split("\n");
  const emitted = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      emitted.push(
        tracker.error("MALFORMED", { reason: "invalid JSON line", raw: trimmed }),
      );
      continue;
    }
    emitted.push(...tracker.processEvent(event));
  }

  const text = emitted.length ? `${emitted.map((a) => JSON.stringify(a)).join("\n")}\n` : "";
  if (options.out) writeFileSync(options.out, text);
  else writeOut(text);
  return 0;
}

function invokedAsScript() {
  try {
    return argv[1] && realpathSync(argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  exit(run(argv.slice(2)));
}
