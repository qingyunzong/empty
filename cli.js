#!/usr/bin/env node
// NDJSON CLI: one JSON command per line on stdin, one JSON response per line on stdout.
// Commands: loadCurve{segments:[{from,to,coefs:[[num,den]...]}]}
//           post{day,amountNum,amountDen}
//           backdate{day,newAmount}        newAmount: integer | {num,den}
//           undoPost{id}
//           certify{from,to}
//           verify{cert}
//           root{}                         current committed state root
import readline from 'node:readline';
import { createHandler, handleLine } from './src/cliCore.js';

const handle = createHandler();
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  process.stdout.write(JSON.stringify(handleLine(handle, line)) + '\n');
}
