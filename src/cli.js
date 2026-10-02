#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Store, LedgerError, toJSON, fromJSON } = require('./store');

function parseArgs(argv, readStdin) {
  let db = 'ledger.json';
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--db') db = argv[++i];
    else if (arg.startsWith('--db=')) db = arg.slice('--db='.length);
    else rest.push(arg);
  }
  if (rest[0] === 'query') {
    const command = { cmd: 'query' };
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--account') command.account = rest[++i];
      else if (rest[i] === '--status') command.status = rest[++i];
      else if (rest[i] === '--due-before') command.dueBefore = rest[++i];
      else throw new LedgerError('E_BAD_ARGS', `unknown flag ${rest[i]}`);
    }
    return { db, command };
  }
  if (rest.length === 1) return { db, command: JSON.parse(rest[0]) };
  if (rest.length === 0) {
    const input = readStdin().trim();
    if (!input) throw new LedgerError('E_BAD_ARGS', 'no command given');
    return { db, command: JSON.parse(input) };
  }
  throw new LedgerError('E_BAD_ARGS', 'cannot parse arguments');
}

function runCommand(store, command) {
  const tx = store.begin();
  let result;
  switch (command.cmd) {
    case 'createAccount':
      result = tx.createAccount(command.account, command.total);
      break;
    case 'freeze':
      result = tx.freeze(command);
      break;
    case 'pay':
      result = tx.pay(command);
      break;
    case 'release':
      result = tx.release(command);
      break;
    case 'cancelPay':
      result = tx.cancelPay(command);
      break;
    default:
      throw new LedgerError('E_BAD_COMMAND', `unknown command ${command.cmd}`);
  }
  tx.commit();
  return result;
}

// Programmatic entry: returns { ok, result? , error? } and persists on success.
function execute(argv, { readStdin } = {}) {
  const { db, command } = parseArgs(argv, readStdin || (() => fs.readFileSync(0, 'utf8')));
  const store = fs.existsSync(db)
    ? fromJSON(JSON.parse(fs.readFileSync(db, 'utf8')))
    : new Store();
  try {
    if (command.cmd === 'query') {
      const result = store.queryHolds({
        account: command.account,
        status: command.status,
        dueBefore: command.dueBefore,
      });
      return { ok: true, result };
    }
    const result = runCommand(store, command);
    fs.writeFileSync(db, JSON.stringify(toJSON(store), null, 2) + '\n');
    return { ok: true, result };
  } catch (err) {
    if (err instanceof LedgerError) {
      return { ok: false, error: err.code, message: err.message };
    }
    throw err;
  }
}

function main() {
  const out = execute(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!out.ok) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { execute, parseArgs, runCommand };
