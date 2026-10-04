'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AuditError } = require('./lib/errors');
const { runAudit, compareRuleSets, minimizeRules } = require('./lib/audit');
const { applyRules, snapshot, undo, status } = require('./lib/state');

const USAGE = [
  'usage:',
  '  node cli.js audit <rules.json> <ledger.jsonl>   audit a ledger against rules',
  '  node cli.js equiv <rulesA.json> <rulesB.json>   equivalence of two rule sets',
  '  node cli.js minimize <rules.json>               minimized DFA + certificate',
  '  node cli.js apply <rules.json> [--state FILE]   apply a new rule version',
  '  node cli.js snapshot [--state FILE]             record an explicit snapshot',
  '  node cli.js undo [--state FILE]                 revert to latest snapshot',
  '  node cli.js status [--state FILE]               show current version hash',
].join('\n');

function readJson(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new AuditError('BAD_LINE', `cannot read file: ${file}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AuditError('BAD_REGEX', `invalid JSON in ${file}`);
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let statePath = path.join(process.cwd(), '.audit-state.json');
  const args = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state') {
      statePath = rest[++i];
    } else {
      args.push(rest[i]);
    }
  }

  switch (cmd) {
    case 'audit': {
      if (args.length !== 2) throw new AuditError('USAGE', USAGE);
      const rules = readJson(args[0]);
      const ledger = fs.readFileSync(args[1], 'utf8');
      return runAudit(rules, ledger);
    }
    case 'equiv': {
      if (args.length !== 2) throw new AuditError('USAGE', USAGE);
      return compareRuleSets(readJson(args[0]), readJson(args[1]));
    }
    case 'minimize': {
      if (args.length !== 1) throw new AuditError('USAGE', USAGE);
      return minimizeRules(readJson(args[0]));
    }
    case 'apply': {
      if (args.length !== 1) throw new AuditError('USAGE', USAGE);
      return applyRules(statePath, readJson(args[0]));
    }
    case 'snapshot': {
      return snapshot(statePath);
    }
    case 'undo': {
      return undo(statePath);
    }
    case 'status': {
      return status(statePath);
    }
    default:
      throw new AuditError('USAGE', USAGE);
  }
}

try {
  const out = main(process.argv.slice(2));
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
} catch (err) {
  const code = err instanceof AuditError ? err.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ error: { code, message: err.message } }) + '\n');
  process.exit(1);
}
