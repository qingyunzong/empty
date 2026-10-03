#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Genealogy, GenealogyError } = require('./genealogy');

const USAGE = [
  'usage: node src/cli.js trace <events.json> [-o result.json]',
  '',
  'events.json: an array of operations (or {"operations": [...]}):',
  '  {"op":"define","batch":"A","kind":"input"}',
  '  {"op":"transform","output":"P","inputs":["A","B"]}',
  '  {"op":"hold"|"release"|"ship","batch":"A"}',
  '  {"op":"correct","index":2,"event":{...mutation...}}',
  '  {"op":"undo"}',
  '  {"op":"query","batch":"P"}',
].join('\n');

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    return { help: true };
  }
  const [command, input, ...rest] = argv;
  if (command !== 'trace') {
    throw new GenealogyError('USAGE', `unknown command: ${command}\n${USAGE}`);
  }
  if (!input) {
    throw new GenealogyError('USAGE', `missing events file\n${USAGE}`);
  }
  let output = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-o') {
      output = rest[i + 1];
      i += 1;
    } else {
      throw new GenealogyError('USAGE', `unexpected argument: ${rest[i]}\n${USAGE}`);
    }
  }
  return { command, input, output };
}

function loadOperations(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new GenealogyError('BAD_INPUT', `cannot read/parse ${file}: ${err.message}`);
  }
  const ops = Array.isArray(parsed) ? parsed : parsed.operations;
  if (!Array.isArray(ops)) {
    throw new GenealogyError('BAD_INPUT', 'events file must be an array or {"operations": [...]}');
  }
  return ops;
}

function applyMutation(genealogy, op) {
  switch (op.op) {
    case 'define':
      return genealogy.define(op.batch, op.kind);
    case 'transform':
      return genealogy.transform(op.output, op.inputs || []);
    case 'hold':
      return genealogy.hold(op.batch);
    case 'release':
      return genealogy.release(op.batch);
    case 'ship':
      return genealogy.ship(op.batch);
    case 'correct':
      return genealogy.correct(op.index, op.event);
    case 'undo':
      return genealogy.undo();
    default:
      throw new GenealogyError('UNKNOWN_OP', `unknown operation: ${op.op}`);
  }
}

function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const operations = loadOperations(args.input);
  const genealogy = new Genealogy();
  const result = {
    ok: true,
    input: path.basename(args.input),
    finalVersion: 0,
    versions: [],
    queries: [],
    errors: [],
  };
  for (let i = 0; i < operations.length; i += 1) {
    const op = operations[i];
    try {
      if (op.op === 'query') {
        result.queries.push({ opIndex: i, certificate: genealogy.query(op.batch) });
      } else {
        const diff = applyMutation(genealogy, op);
        result.versions.push({ opIndex: i, op: op.op, diff });
      }
    } catch (err) {
      result.ok = false;
      result.errors.push({
        opIndex: i,
        op: op && op.op,
        code: err.code || 'INTERNAL',
        message: err.message,
      });
      break;
    }
  }
  result.finalVersion = genealogy.version;
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    fs.writeFileSync(args.output, json);
    process.stdout.write(
      `trace ${result.ok ? 'ok' : 'FAILED'}: ${result.versions.length} mutations, ` +
        `${result.queries.length} queries, ${result.errors.length} errors -> ${args.output}\n`,
    );
  } else {
    process.stdout.write(json);
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.name}: ${err.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { run, parseArgs };
