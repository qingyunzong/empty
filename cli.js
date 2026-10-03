#!/usr/bin/env node
// Usage: node cli.js check <history.json> [--initial-balance N]
//
// Exit codes:
//   0  history is well-formed; result JSON printed to stdout
//      ({"linearizable":true,"witness":[...]} or {"linearizable":false,"reason":...})
//   1  INVALID_HISTORY (structural error, time inversion, negative amount,
//      duplicate opId, unreadable/invalid JSON)
//   2  CLI usage error

import { runCli } from './src/cliMain.js';

const { code, stdout, stderr } = runCli(process.argv.slice(2));
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(code);
