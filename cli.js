#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLine, DataError } from "./lib/parse.js";
import { settle } from "./lib/engine.js";
import { naiveSettle, recordsEqual } from "./lib/naive.js";

const NAIVE_LIMIT = 200;

function usage() {
  return "usage: node cli.js settle --in <events.jsonl> --wm <lagMs> --out <out.jsonl> [--naive]";
}

function parseArgs(argv) {
  if (argv[0] !== "settle") return null;
  const opts = { naive: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--naive") {
      opts.naive = true;
    } else if (arg === "--in" || arg === "--wm" || arg === "--out") {
      if (i + 1 >= argv.length) return null;
      opts[arg.slice(2)] = argv[++i];
    } else {
      return null;
    }
  }
  if (!opts.in || !opts.out || opts.wm === undefined) return null;
  opts.wm = Number(opts.wm);
  if (!Number.isFinite(opts.wm) || opts.wm < 0) return null;
  return opts;
}

// Runs the CLI and returns the process exit code. I/O is injectable for tests.
export function run(argv, io = {}) {
  const read = io.readFile ?? ((path) => readFileSync(path, "utf8"));
  const write = io.writeFile ?? ((path, text) => writeFileSync(path, text));
  const stderr = io.stderr ?? ((msg) => console.error(msg));

  const opts = parseArgs(argv);
  if (!opts) {
    stderr(usage());
    return 1;
  }

  let text;
  try {
    text = read(opts.in);
  } catch (err) {
    stderr(`error: cannot read ${opts.in}: ${err.message}`);
    return 1;
  }

  const lines = text.split("\n");
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    try {
      events.push(parseLine(lines[i], i + 1));
    } catch (err) {
      if (err instanceof DataError) {
        stderr(`error: line ${err.line}: ${err.message}`);
        return 2;
      }
      throw err;
    }
  }

  const records = settle(events, opts.wm);
  write(opts.out, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));

  if (opts.naive) {
    if (events.length > NAIVE_LIMIT) {
      stderr(`naive-check: skipped (${events.length} events > ${NAIVE_LIMIT} limit)`);
    } else {
      const naiveRecords = naiveSettle(events, opts.wm);
      if (!recordsEqual(records, naiveRecords)) {
        stderr("naive-check: MISMATCH between streaming engine and naive replay");
        return 3;
      }
      stderr(`naive-check: OK (${records.length} records, ${events.length} events)`);
    }
  }
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  process.exit(run(process.argv.slice(2)));
}
