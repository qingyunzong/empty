#!/usr/bin/env node
/**
 * NDJSON CLI for the credit network. Reads one JSON command per line from
 * stdin and writes one JSON response per line to stdout.
 *
 * Commands:
 *   {"cmd":"add-edge","from":"A","to":"B","capacity":10}
 *   {"cmd":"set-capacity","from":"A","to":"B","capacity":5}
 *   {"cmd":"freeze","source":"S","target":"C","amount":7}
 *   {"cmd":"release","freezeId":"f1","amount":3}   (amount optional = all)
 *
 * A declined freeze prints {"ok":false,"reason":"insufficient-capacity",...}
 * with a min-cut certificate and processing continues (exit 0). Command
 * errors (bad input, unknown source/freeze, duplicate/over release, ...)
 * print {"ok":false,"code":...,"error":...} and exit with code 1.
 */
import * as readline from 'node:readline';
import { CliSession } from './lib/session.js';

const session = new CliSession();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const result = session.handleLine(line);
  if (result === null) continue;
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
