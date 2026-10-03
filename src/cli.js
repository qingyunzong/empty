#!/usr/bin/env node
// JSON-lines CLI. One command per line on stdin, one JSON result per line on
// stdout:
//   {"cmd":"addItem","id":"a","claimedNum":100,"claimedDen":1}
//   {"cmd":"audit","id":"a","actualNum":95,"actualDen":1}
//   {"cmd":"correct","id":"a","newClaimed":"97/1"}
//   {"cmd":"bound","confidenceNum":19,"confidenceDen":20}
//   {"cmd":"explain"}
// Success: {"ok":true,"result":...}  Failure: {"ok":false,"error":{...}}

import readline from 'node:readline';
import { AuditLedger, AuditError } from './ledger.js';

const COMMANDS = new Set(['addItem', 'audit', 'correct', 'bound', 'explain']);

export function createSession(ledger = new AuditLedger()) {
  return {
    ledger,
    handle(line) {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return { ok: false, error: { code: 'E_PARSE', message: 'invalid JSON' } };
      }
      const { cmd, ...args } = msg ?? {};
      if (!COMMANDS.has(cmd)) {
        return { ok: false, error: { code: 'E_CMD', message: `unknown command: ${cmd}` } };
      }
      try {
        return { ok: true, result: ledger[cmd](args) };
      } catch (err) {
        const code = err instanceof AuditError ? err.code : 'E_INTERNAL';
        return { ok: false, error: { code, message: err.message } };
      }
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = createSession();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    process.stdout.write(`${JSON.stringify(session.handle(line))}\n`);
  });
}
