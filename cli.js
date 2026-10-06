#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runToollife, ToolLifeError, INPUT_ERROR } = require('./src/toollife');

function usage() {
  console.error('usage: node cli.js toollife --in <dir> --out <dir>');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--in' || argv[i] === '--out') {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ToolLifeError(`cannot read/parse ${file}: ${err.message}`);
  }
}

function readJsonl(file, { optional = false } = {}) {
  if (!fs.existsSync(file)) {
    if (optional) return [];
    throw new ToolLifeError(`missing input file: ${file}`);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      throw new ToolLifeError(`${file}:${idx + 1}: invalid JSON: ${err.message}`);
    }
  });
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'toollife' || !args.in || !args.out) {
    usage();
    process.exit(1);
  }

  try {
    const inDir = args.in;
    const toolsConfig = readJson(path.join(inDir, 'tools.json'));
    const operations = readJsonl(path.join(inDir, 'operations.jsonl'));
    const undos = readJsonl(path.join(inDir, 'undo.jsonl'), { optional: true });

    const ledger = runToollife(toolsConfig, operations, undos);

    fs.mkdirSync(args.out, { recursive: true });
    fs.writeFileSync(
      path.join(args.out, 'tools_state.json'),
      JSON.stringify(ledger.state(), null, 2) + '\n',
    );
    fs.writeFileSync(
      path.join(args.out, 'history.jsonl'),
      ledger.history.map((h) => JSON.stringify(h)).join('\n') + '\n',
    );
    console.log(`processed ${ledger.history.length} history records -> ${args.out}`);
  } catch (err) {
    if (err instanceof ToolLifeError) {
      fs.writeSync(2, `error: ${err.message}\n`);
      process.exit(err.code);
    }
    fs.writeSync(2, `fatal: ${err.stack || err.message}\n`);
    process.exit(1);
  }
}

main();
