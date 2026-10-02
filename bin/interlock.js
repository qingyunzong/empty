#!/usr/bin/env node
import fs from "node:fs";
import { replay } from "../src/replay.js";

const USAGE = `Usage: interlock replay --in <dir> --out <dir> [options]

Options:
  --in <dir>               input directory with *.jsonl event files
  --out <dir>              output directory (states.jsonl, proof.json, late.log, snapshot.json)
  --pressure-tag <tag>     pressure sensor tag (default PT-101)
  --temp-tag <tag>         temperature sensor tag (default TT-201)
  --pressure-limit <n>     pressure limit (default 1000)
  --temp-limit <n>         temperature limit (default 180)
  --window-ms <n>          sliding window length in ms (default 5000)
  --hold-ms <n>            sustained duration required to ARM in ms (default 3000)
  --watermark-lag-ms <n>   watermark = maxEventTs - lag (default 1000)
  --batch-delay-ms <n>     artificial delay per event-time batch (default 0)

Exit codes: 0 ok, 1 generic error, 2 UNIT_MISSING (sensor event without unit).
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function numOpt(opts, name) {
  if (opts[name] === undefined) return undefined;
  const n = Number(opts[name]);
  if (!Number.isFinite(n)) throw new Error(`invalid numeric value for --${name}: ${opts[name]}`);
  return n;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd] = opts._;
  if (cmd !== "replay" || !opts.in || !opts.out) {
    fs.writeSync(2, USAGE);
    process.exit(1);
  }
  const config = {};
  if (opts["pressure-tag"] !== undefined) config.pressureTag = opts["pressure-tag"];
  if (opts["temp-tag"] !== undefined) config.tempTag = opts["temp-tag"];
  for (const [flag, key] of [
    ["pressure-limit", "pressureLimit"],
    ["temp-limit", "tempLimit"],
    ["window-ms", "windowMs"],
    ["hold-ms", "holdMs"],
    ["watermark-lag-ms", "watermarkLagMs"],
  ]) {
    const v = numOpt(opts, flag);
    if (v !== undefined) config[key] = v;
  }
  const batchDelayMs = numOpt(opts, "batch-delay-ms") ?? 0;

  try {
    const res = await replay({
      inDir: opts.in,
      outDir: opts.out,
      config,
      batchDelayMs,
    });
    const proof = JSON.parse(fs.readFileSync(res.proofPath, "utf8"));
    fs.writeSync(
      1,
      `replay complete: ${res.linesCommitted} events, ` +
        `${proof.summary.armCount} ARM, ${proof.summary.tripCount} TRIP\n` +
        `outputs: ${res.statesPath} ${res.proofPath} ${res.latePath}\n`,
    );
  } catch (err) {
    if (err && err.code === "UNIT_MISSING") {
      fs.writeSync(2, `UNIT_MISSING: ${err.message}\n`);
      process.exit(2);
    }
    fs.writeSync(2, `${err && err.stack ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}

main();
