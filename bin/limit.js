#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Ledger, applyOp } from '../src/limit.js';
import { checkLinearizable } from '../src/linearize.js';

function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const ops = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      ops.push(JSON.parse(trimmed));
    } catch {
      console.error(`line ${i + 1}: invalid JSON`);
      process.exit(2);
    }
  });
  return ops;
}

function cmdRun(args) {
  const explain = args.includes('--explain');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: limit run <ops.jsonl> [--explain]');
    process.exit(2);
  }
  const ops = readJsonl(path);
  if (ops.length > 20000) {
    console.error(`too many operations: ${ops.length} > 20000`);
    process.exit(2);
  }
  const ledger = new Ledger();
  let failures = 0;
  ops.forEach((op, i) => {
    const result = applyOp(ledger, op);
    if (result !== 'ok') failures++;
    if (explain) {
      console.log(`#${i} ${JSON.stringify(op)} -> ${result}`);
    }
  });
  console.log(JSON.stringify({ ok: failures === 0, failures, ...ledger.snapshot() }, null, 2));
  process.exitCode = failures === 0 ? 0 : 1;
}

function cmdCheck(args) {
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: limit check <log.jsonl>');
    process.exit(2);
  }
  const log = readJsonl(path);
  const { linearizable, witness, incomplete } = checkLinearizable(log);
  if (linearizable) {
    console.log(`LINEARIZABLE witness=${JSON.stringify(witness)}`);
    return;
  }
  console.log(`NOT_LINEARIZABLE${incomplete ? ' (incomplete: search budget exhausted)' : ''}`);
  process.exitCode = 1;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'run') cmdRun(rest);
else if (cmd === 'check') cmdCheck(rest);
else {
  console.error('usage: limit <run|check> ...');
  process.exit(2);
}
