#!/usr/bin/env node
/**
 * JSON-command CLI for the offline credit ledger.
 *
 * Usage:
 *   node src/cli.js [--state FILE] '<json-command | json-array>'
 *   echo '<json>' | node src/cli.js [--state FILE]
 *
 * Commands (one JSON object, or an array executed in order):
 *   {"cmd":"createAccount","account":"A","total":1000}
 *   {"cmd":"freeze","account":"A","amount":100,"dueDate":"2026-01-01","holdId":"h1"}
 *   {"cmd":"pay","holdId":"h1","payId":"p1"}
 *   {"cmd":"release","holdId":"h1"}
 *   {"cmd":"cancelPay","payId":"p1"}
 *   {"cmd":"query","account":"A","status":"ACTIVE","dueBefore":"2026-06-01"}
 *     (query flags mirror: --account A --status S --due-before D)
 *   {"cmd":"account","account":"A"}
 *
 * Each command runs in its own transaction. One JSON result is printed per
 * command: {"ok":true,"result":...} or {"ok":false,"error":{"code","message"}}.
 * With --state, the ledger is loaded from and saved to FILE around the batch.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { Ledger, LedgerError } from './ledger.js';

function normalizeQuery(cmd) {
  return {
    account: cmd.account,
    status: cmd.status,
    dueBefore: cmd.dueBefore ?? cmd['due-before'],
  };
}

export function execute(ledger, cmd) {
  switch (cmd.cmd) {
    case 'createAccount':
      return ledger.createAccount(cmd);
    case 'freeze':
      return ledger.run((tx) => tx.freeze(cmd));
    case 'pay':
      return ledger.run((tx) => tx.pay(cmd));
    case 'release':
      return ledger.run((tx) => tx.release(cmd));
    case 'cancelPay':
      return ledger.run((tx) => tx.cancelPay(cmd));
    case 'query':
      return ledger.query(normalizeQuery(cmd));
    case 'account':
      return ledger.account(cmd.account);
    default:
      throw new LedgerError('E_VALIDATION', `unknown command: ${cmd.cmd}`);
  }
}

/** Run a batch of parsed commands against a ledger; never throws. */
export function executeBatch(ledger, commands) {
  return commands.map((cmd) => {
    try {
      return { ok: true, result: execute(ledger, cmd) };
    } catch (err) {
      const code = err instanceof LedgerError ? err.code : 'E_INTERNAL';
      return { ok: false, error: { code, message: err.message } };
    }
  });
}

export function main(argv, { stdout = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const args = [...argv];
  let stateFile = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--state') {
      stateFile = args[++i];
    } else {
      positional.push(args[i]);
    }
  }

  const input = positional.length > 0 ? positional.join(' ') : readFileSync(0, 'utf8');
  const parsed = JSON.parse(input);
  const commands = Array.isArray(parsed) ? parsed : [parsed];

  let ledger = new Ledger();
  if (stateFile && existsSync(stateFile)) {
    ledger = Ledger.fromJSON(JSON.parse(readFileSync(stateFile, 'utf8')));
  }

  const results = executeBatch(ledger, commands);

  if (stateFile) writeFileSync(stateFile, JSON.stringify(ledger.toJSON(), null, 2));

  for (const r of results) stdout(JSON.stringify(r));
  return results.every((r) => r.ok) ? 0 : 1;
}

const isEntryPoint =
  process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname);
if (isEntryPoint) {
  process.exitCode = main(process.argv.slice(2));
}
