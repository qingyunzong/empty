#!/usr/bin/env node
// Reads a JSON command batch from stdin, writes one JSON line to stdout.
//
// Input:  {"ops": [ <op>, ... ]}  (a bare op object or an array also works)
// Ops:
//   {"op":"import",     "id":"e1", "a":0, "b":10, "f":{"c0":0,"c1":1,"c2":0}}
//   {"op":"correct",    "id":"e1", "f":[0, 1, "1/2"]}
//   {"op":"constrain",  "before":"e1", "after":"e2"}
//   {"op":"compare",    "x":"e1", "y":"e2"}
//   {"op":"linearize",  "ids":["e1","e2"]}   // ids optional, n <= 7
//   {"op":"undo"} / {"op":"redo"} / {"op":"snapshot"}
// Rationals: integer, decimal, "p/q", or {"num":p,"den":q}.
// Output: {"results":[ ... ]} on a single line; errors are
// {"ok":false,"error":"E_RATIONAL"|"E_RANGE"|"E_UNSAT"|...}.

import { runCli } from '../src/cli-core.js';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const { line, exitCode } = runCli(raw);
  process.stdout.write(line);
  process.exit(exitCode);
});
