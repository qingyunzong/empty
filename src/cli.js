#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parse } = require('./parser');
const { buildLedger } = require('./build');
const { verifyChain } = require('./ledger');
const { CLAIM } = require('./term');

const USAGE = [
  'usage:',
  '  node src/cli.js run <script.txt> --key <hmac-key>     build ledger, print JSON verdict',
  '  node src/cli.js verify <ledger.json> --key <hmac-key> verify certificate chain, print JSON verdict',
  '',
  'use "-" as the file name to read from stdin',
].join('\n');

function parseArgs(argv) {
  const [mode, file, ...rest] = argv;
  let key;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--key') {
      key = rest[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument "${rest[i]}"\n${USAGE}`);
    }
  }
  if (mode !== 'run' && mode !== 'verify') throw new Error(USAGE);
  if (!file) throw new Error(`missing input file\n${USAGE}`);
  if (key === undefined) throw new Error(`missing required --key <hmac-key>\n${USAGE}`);
  return { mode, file, key };
}

function readInput(file, stdin) {
  if (file === '-') {
    return stdin !== undefined ? stdin : fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(file, 'utf8');
}

// Returns the process exit code; all output goes through the io hooks.
function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text));
  const stderr = io.stderr || ((text) => process.stderr.write(text));
  try {
    const { mode, file, key } = parseArgs(argv);
    if (mode === 'run') {
      const program = parse(readInput(file, io.stdin));
      const ledger = buildLedger(program, key);
      stdout(`${JSON.stringify(ledger.verdict(), null, 2)}\n`);
      return 0;
    }
    const ledgerFile = JSON.parse(readInput(file, io.stdin));
    const commits = Array.isArray(ledgerFile) ? ledgerFile : ledgerFile.commits;
    const symbols = verifyChain(commits, key);
    const claims = {};
    for (const [id, sym] of symbols) {
      if (sym.type === CLAIM) {
        claims[id] = { valid: true, dependencies: [...sym.deps].sort() };
      }
    }
    stdout(`${JSON.stringify({ ok: true, claims }, null, 2)}\n`);
    return 0;
  } catch (err) {
    stderr(`error: ${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run, USAGE };
