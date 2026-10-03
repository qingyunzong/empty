#!/usr/bin/env node
'use strict';

// Offline single-node CLI. Reads JSONL commands from stdin, applies them to a
// persistent JSON state file, and prints one JSON result per line to stdout.
//
//   node src/cli.js <stateFile>
//
// Commands (one JSON object per line):
//   {"op":"insert","id":"a1","deviceId":"d1","alarmTime":10,"state":"unacked"}
//   {"op":"confirm","deviceId":"d1","from":0,"to":20,"by":"op1","at":100,"note":"..."}
//   {"op":"begin","tx":"t1"}   {"op":"commit","tx":"t1"}   {"op":"rollback","tx":"t1"}
//   {"op":"insert","tx":"t1",...}  {"op":"confirm","tx":"t1",...}   (inside a named txn)
//   {"op":"dump"}
//
// insert/confirm without "tx" run in their own auto-commit transaction.
// Transactions still open at end of input are rolled back.
//
// Exit codes: 0 = every command succeeded; 1 = a domain error occurred
// (E_PHANTOM, E_DUP_ID, E_TXN_CLOSED, E_TXN_EXISTS, E_UNKNOWN_TXN);
// 2 = usage/structural error (bad args, invalid JSON, unknown op, bad fields).

const fs = require('node:fs');
const { Store, StoreError } = require('./store');

const STRUCTURAL = new Set(['E_USAGE', 'E_VALIDATION', 'E_PARSE', 'E_IO']);

function fail(code, message, exit) {
  return { out: { ok: false, error: code, message }, exit };
}

function ok(out) {
  return { out, exit: 0 };
}

function requireTxName(cmd) {
  if (typeof cmd.tx !== 'string' || cmd.tx.length === 0) {
    throw new StoreError('E_USAGE', 'command requires a non-empty string field "tx"');
  }
  return cmd.tx;
}

function getActiveTxn(txns, cmd) {
  const name = requireTxName(cmd);
  const txn = txns.get(name);
  if (!txn || txn.status !== 'active') {
    throw new StoreError('E_UNKNOWN_TXN', `no active transaction named "${name}"`);
  }
  return txn;
}

// Resolve the target transaction: the named one, or a fresh auto-commit txn.
function resolveTxn(store, txns, cmd) {
  if (cmd.tx !== undefined) {
    return { txn: getActiveTxn(txns, cmd), auto: false };
  }
  return { txn: store.begin(), auto: true };
}

function runCommand(store, txns, cmd) {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd) || typeof cmd.op !== 'string') {
    return fail('E_USAGE', 'command must be a JSON object with a string field "op"', 2);
  }
  try {
    switch (cmd.op) {
      case 'begin': {
        const name = requireTxName(cmd);
        const existing = txns.get(name);
        if (existing && existing.status === 'active') {
          throw new StoreError('E_TXN_EXISTS', `transaction "${name}" is already active`);
        }
        txns.set(name, store.begin());
        return ok({ ok: true });
      }
      case 'insert': {
        const { txn, auto } = resolveTxn(store, txns, cmd);
        try {
          txn.insertAlarm({
            id: cmd.id,
            deviceId: cmd.deviceId,
            alarmTime: cmd.alarmTime,
            state: cmd.state,
          });
          if (auto) txn.commit();
        } catch (e) {
          if (auto && txn.status === 'active') txn.rollback();
          throw e;
        }
        return ok({ ok: true });
      }
      case 'confirm': {
        const { txn, auto } = resolveTxn(store, txns, cmd);
        let result;
        try {
          result = txn.ackWindow({
            deviceId: cmd.deviceId,
            from: cmd.from,
            to: cmd.to,
            by: cmd.by,
            at: cmd.at,
            note: cmd.note,
          });
          if (auto) txn.commit();
        } catch (e) {
          if (auto && txn.status === 'active') txn.rollback();
          throw e;
        }
        return ok({ ok: true, count: result.count });
      }
      case 'commit': {
        getActiveTxn(txns, cmd).commit();
        return ok({ ok: true });
      }
      case 'rollback': {
        getActiveTxn(txns, cmd).rollback();
        return ok({ ok: true });
      }
      case 'dump': {
        return ok({ ok: true, alarms: store.listAlarms(), acks: store.listAcks() });
      }
      default:
        return fail('E_USAGE', `unknown op "${cmd.op}"`, 2);
    }
  } catch (e) {
    if (e instanceof StoreError) {
      return fail(e.code, e.message, STRUCTURAL.has(e.code) ? 2 : 1);
    }
    throw e;
  }
}

// Execute one JSONL command session against `store`. Returns the per-command
// output objects plus the session exit code. Pure with respect to process
// state: no IO, no process.exit — used by both the CLI entrypoint and tests.
function runSession(store, input) {
  const txns = new Map();
  const results = [];
  let exitCode = 0;

  const note = (r) => {
    if (r.exit === 2) exitCode = 2;
    else if (r.exit === 1 && exitCode === 0) exitCode = 1;
    results.push(r.out);
  };

  const lines = String(input).split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch (e) {
      note(fail('E_PARSE', `invalid JSON: ${e.message}`, 2));
      continue;
    }
    note(runCommand(store, txns, cmd));
  }

  // Transactions still open at end of input are rolled back.
  for (const txn of txns.values()) {
    if (txn.status === 'active') txn.rollback();
  }

  return { exitCode, results };
}

function loadStore(stateFile) {
  if (stateFile === undefined) {
    return new Store();
  }
  if (!fs.existsSync(stateFile)) {
    return new Store();
  }
  return Store.fromJSON(JSON.parse(fs.readFileSync(stateFile, 'utf8')));
}

function saveStore(store, stateFile) {
  if (stateFile === undefined) return;
  fs.writeFileSync(stateFile, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write('usage: alarm-cli <stateFile>  (reads JSONL commands from stdin)\n');
    process.exit(2);
  }
  const stateFile = args[0];

  let store;
  try {
    store = loadStore(stateFile);
  } catch (e) {
    process.stderr.write(`cannot load state file: ${e.message}\n`);
    process.exit(2);
  }

  let input;
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read stdin: ${e.message}\n`);
    process.exit(2);
  }

  const { exitCode, results } = runSession(store, input);
  for (const out of results) {
    process.stdout.write(JSON.stringify(out) + '\n');
  }

  try {
    saveStore(store, stateFile);
  } catch (e) {
    process.stderr.write(`cannot write state file: ${e.message}\n`);
    process.exit(2);
  }
  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = { runSession, runCommand, loadStore, saveStore };
