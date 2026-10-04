#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createEngine } from "./engine.js";

export function processLines(lines) {
  const engine = createEngine();
  const output = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      output.push({ type: "ACTION", action: "INVALID_JSON", line: trimmed });
      continue;
    }
    output.push(...engine.processEvent(event));
  }
  output.push(engine.certificate());
  return output;
}

function usage() {
  console.error("usage: node src/cli.js batches --in <events.jsonl>");
  process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "batches") usage();
  const inIndex = args.indexOf("--in");
  if (inIndex === -1 || !args[inIndex + 1]) usage();
  const inputPath = args[inIndex + 1];

  const reader = createInterface({ input: createReadStream(inputPath, "utf8"), crlfDelay: Infinity });
  const lines = [];
  for await (const line of reader) lines.push(line);
  for (const record of processLines(lines)) {
    console.log(JSON.stringify(record));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
