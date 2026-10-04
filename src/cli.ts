// Reading CLI: parse a binary file with a JSON format description.
//
//   node dist/src/cli.js --format format.json --input data.bin
//
// Exit codes: 0 = parsed, 1 = parse error, 2 = usage/format error.

import * as fs from "node:fs";
import { Format, FormatError } from "./format";
import { ParseError, Parser, compileFormat } from "./parser";

function usage(): void {
  console.error("usage: node cli.js --format <format.json> --input <data.bin>");
}

// Convert parsed values to JSON-friendly form; bytes become "hex:...".
// (A pre-pass is needed because Buffer's toJSON would otherwise win over a
// JSON.stringify replacer.)
function toJsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    const hex = Array.from(value, (b: number) => b.toString(16).padStart(2, "0")).join("");
    return `hex:${hex}`;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonValue(v);
    }
    return out;
  }
  return value;
}

function main(argv: string[]): number {
  let formatPath: string | undefined;
  let inputPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--format") {
      formatPath = argv[(i += 1)];
    } else if (arg === "--input") {
      inputPath = argv[(i += 1)];
    } else if (arg === "--help" || arg === "-h") {
      usage();
      return 0;
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      return 2;
    }
  }
  if (formatPath === undefined || inputPath === undefined) {
    usage();
    return 2;
  }

  let format: Format;
  try {
    format = JSON.parse(fs.readFileSync(formatPath, "utf8")) as Format;
  } catch (err) {
    console.error(`cannot read format: ${(err as Error).message}`);
    return 2;
  }

  let plan;
  try {
    plan = compileFormat(format);
  } catch (err) {
    if (err instanceof FormatError) {
      console.error(`format error: ${err.message}`);
      return 2;
    }
    throw err;
  }

  const data = fs.readFileSync(inputPath) as Uint8Array;
  const parser = new Parser(data);
  let value: Record<string, unknown>;
  try {
    value = parser.run(plan);
  } catch (err) {
    if (err instanceof ParseError) {
      console.error(`parse error at offset ${err.offset}: ${err.message}`);
      return 1;
    }
    throw err;
  }

  process.stdout.write(`${JSON.stringify(toJsonValue(value), null, 2)}\n`);
  console.error(`parsed ${parser.offset} of ${data.length} bytes`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
