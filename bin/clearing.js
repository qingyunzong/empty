#!/usr/bin/env node
// JSONL CLI: one JSON command per line on stdin, one JSON response per line
// on stdout. BigInt values are serialized as decimal strings.
//
// Commands:
//   {cmd:"account", id, funds:{num,den}|int}
//   {cmd:"order", id, account, symbol, side:"buy"|"sell", qty, limit:{num,den}}
//   {cmd:"correct_account", id, funds}
//   {cmd:"correct_order", id, qty?, limit?}
//   {cmd:"trial", window, prices:{SYM:{num,den}}, budget?}
//   {cmd:"check", trial}
//   {cmd:"commit", id, trial}
//   {cmd:"undo", trial}
//   {cmd:"compensate", id, commit}
//   {cmd:"state"} | {cmd:"reset"}

import readline from 'node:readline';
import { Engine } from '../src/engine.js';

let engine = new Engine();

const stringify = (v) =>
  JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));

function dispatch(msg) {
  switch (msg.cmd) {
    case 'account':
      return engine.setAccount(msg);
    case 'order':
      return engine.setOrder(msg);
    case 'correct_account':
      return engine.correctAccount(msg);
    case 'correct_order':
      return engine.correctOrder(msg);
    case 'trial':
      return engine.trial(msg);
    case 'check':
      return engine.checkTrial(msg);
    case 'commit':
      return engine.commit(msg);
    case 'undo':
      return engine.undo(msg);
    case 'compensate':
      return engine.compensate(msg);
    case 'state':
      return engine.state();
    case 'reset':
      engine = new Engine();
      return { status: 'reset' };
    default: {
      const e = new Error(`unknown cmd '${msg.cmd}'`);
      e.code = 'E_UNKNOWN_CMD';
      throw e;
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let out;
  try {
    out = { ok: true, result: dispatch(JSON.parse(trimmed)) };
  } catch (e) {
    out = { ok: false, error: { code: e.code ?? 'E_INTERNAL', message: e.message } };
  }
  process.stdout.write(stringify(out) + '\n');
}
