#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { RecallStore } = require('./store');

function errorEntry(op, err) {
  return {
    type: op && op.op ? op.op : 'input',
    id: op && op.id !== undefined ? op.id : null,
    error: { code: err.code || 'ERR_INTERNAL', message: err.message },
  };
}

function run(input) {
  const store = new RecallStore(input.conversion || []);
  const results = [];
  const ops = Array.isArray(input.ops) ? input.ops : [];
  for (const op of ops) {
    try {
      switch (op.op) {
        case 'batch':
          store.addBatch(op);
          results.push({ type: 'batch', id: op.id, status: 'ok' });
          break;
        case 'record':
          store.addRecord(op);
          results.push({ type: 'record', id: op.id, status: 'ok', version: 1 });
          break;
        case 'correct': {
          const r = store.correctRecord(op);
          results.push({ type: 'correct', id: op.id, status: 'ok', version: r.version });
          break;
        }
        case 'snapshot':
          store.snapshot(op.name);
          results.push({ type: 'snapshot', name: op.name, status: 'ok' });
          break;
        case 'rollback':
          store.rollback(op.name);
          results.push({ type: 'rollback', name: op.name, status: 'ok' });
          break;
        case 'query': {
          const out = store.query(op);
          results.push({ type: 'query', id: op.id !== undefined ? op.id : null, ...out });
          break;
        }
        default:
          throw Object.assign(new Error(`unknown op: ${op.op}`), { code: 'ERR_UNKNOWN_OP' });
      }
    } catch (err) {
      results.push(errorEntry(op, err));
    }
  }
  return { results };
}

function main(argv) {
  let raw;
  const file = argv[2];
  try {
    raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(`cannot read input: ${err.message}\n`);
    process.exit(1);
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`invalid JSON input: ${err.message}\n`);
    process.exit(1);
  }
  let output;
  try {
    output = run(input);
  } catch (err) {
    process.stderr.write(`${err.code || 'ERR_INTERNAL'}: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { run };
