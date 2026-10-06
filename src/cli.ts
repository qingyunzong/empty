#!/usr/bin/env node
/**
 * proto-diff: protocol testing CLI.
 *
 *   proto-diff <automatonA.json> <automatonB.json> [--budget N] [--verify-depth D]
 *
 * Exit codes: 0 equivalent, 1 distinguished, 2 unknown (budget exceeded,
 * equivalence NOT established), 3 usage or input error.
 */

import { run } from "./app.js";

const result = run(process.argv.slice(2));
if (result.stdout.length > 0) process.stdout.write(result.stdout);
if (result.stderr.length > 0) process.stderr.write(result.stderr);
process.exitCode = result.code;
