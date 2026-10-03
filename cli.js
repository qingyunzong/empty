#!/usr/bin/env node
import readline from 'node:readline';
import { createSession } from './src/session.js';

// NDJSON session CLI: one JSON command per line on stdin, one JSON response
// per line on stdout.
//
//   {"cmd":"addItem","id":"a","claimedNum":3,"claimedDen":2}
//   {"cmd":"audit","id":"a","actualNum":1,"actualDen":1}
//   {"cmd":"correct","id":"a","newClaimed":"5/4"}
//   {"cmd":"bound","confidenceNum":19,"confidenceDen":20}
//   {"cmd":"explain"}

const session = createSession();

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  process.stdout.write(JSON.stringify(session.handleLine(trimmed)) + '\n');
});
