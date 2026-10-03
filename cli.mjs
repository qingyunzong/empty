#!/usr/bin/env node
// Usage: node cli.mjs <input.json> [--all]
//   Reads the instance from a file (or stdin when the path is "-"), solves it,
//   and prints a JSON result. Exit codes: 0 = solved (FEASIBLE/UNSAT/UNKNOWN),
//   2 = schema/IO error (ERR_SCHEMA / ERR_INPUT on stderr).

import { readFileSync } from 'node:fs';
import { runCli } from './src/cli-main.mjs';

const { code, stdout, stderr } = runCli(process.argv.slice(2), {
  readStdin: () => readFileSync(0, 'utf8'),
  readFile: (path) => readFileSync(path, 'utf8'),
});
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
