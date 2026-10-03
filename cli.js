#!/usr/bin/env node
// CLI: reads a JSON array or JSON Lines session from a file argument or stdin,
// executes each operation against a fresh Engine, and prints one JSON result
// per line. Exit code is 1 if any operation reported an error (including
// E_UNSAT), else 0.

import { readFileSync } from 'node:fs';
import { runSession, parseSession } from './src/session.js';

const input = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
const { results, failed } = runSession(parseSession(input));
for (const res of results) console.log(JSON.stringify(res));
process.exitCode = failed ? 1 : 0;
