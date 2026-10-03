#!/usr/bin/env node
// Offline CLI for the chargeback evidence store. State lives in a JSON file.
//
// Usage:
//   evidence add         --db f.json --id E1 --case C1 --amount 120.5 --text "..."
//   evidence correct     --db f.json --id E1 [--amount N] [--text "..."] [--revision 2]
//   evidence revoke      --db f.json --id E1 --revision 2
//   evidence query       --db f.json --case C1 (--phrase "a b" | --near "a b" [--slop 2])
//                        [--at-revision 1]
//   evidence certificate --db f.json --case C1 (--phrase "a b" | --near "a b" [--slop 2])
//   evidence amount      --db f.json --case C1

import { runCli } from '../src/cli.js';

const { code, stdout, stderr } = runCli(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
