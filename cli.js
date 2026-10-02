#!/usr/bin/env node
// Reads a JSON document from stdin: either an array of commands or
// { "commands": [...] }. Executes them against a fresh AllocationEngine and
// writes { results, report } as JSON to stdout. All coordinates are exact
// rationals: "p/q" strings, decimal strings, integers, or { num, den }.
//
// Commands:
//   { "op": "addDevice",    "id": "devA", "rect": { "x1": 0, "y1": 0, "x2": 4, "y2": 2 } }
//   { "op": "removeDevice", "id": "devA" }
//   { "op": "addDefect",    "id": "d1",   "rect": { ... } }
//   { "op": "removeDefect", "id": "d1" }
//   { "op": "moveDefect",   "id": "d1", "dx": "1/2", "dy": 0 }
//   { "op": "scaleDefect",  "id": "d1", "sx": 2, "sy": "3/2" }
//   { "op": "splitDefect",  "id": "d1", "axis": "x", "at": "5/2", "blockIndex": 0 }
//   { "op": "undo" } / { "op": "redo" } / { "op": "report" }
import { runJson } from './src/run-commands.js';

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

readStdin()
  .then((text) => {
    process.stdout.write(`${JSON.stringify(runJson(text), null, 2)}\n`);
  })
  .catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  });
