#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { loadRuleSet } = require('./src/rules');
const { equivalence } = require('./src/equiv');
const { evaluate } = require('./src/engine');
const { StateStore } = require('./src/state');
const { RiskError } = require('./src/errors');

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function cmdEquiv(aPath, bPath) {
  const setA = loadRuleSet(fs.readFileSync(aPath, 'utf8'));
  const setB = loadRuleSet(fs.readFileSync(bPath, 'utf8'));
  const { equiv, witness } = equivalence(setA.combined, setB.combined);
  return {
    equiv,
    witness,
    certA: setA.certificate,
    certB: setB.certificate,
  };
}

function cmdRun(rulesPath, txPath, flags) {
  const ruleSet = loadRuleSet(fs.readFileSync(rulesPath, 'utf8'));
  const txs = fs
    .readFileSync(txPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  const mode = flags.mode || 'dry-run';
  const stateDir = flags.state || '.risk-state';
  const store = new StateStore(stateDir);
  const batchId =
    flags.batch || crypto.createHash('sha256').update(fs.readFileSync(txPath)).digest('hex').slice(0, 16);

  if (mode === 'undo') {
    const { undone } = store.undo();
    return { mode, undone, stateHash: store.stateHash() };
  }

  const decisions = evaluate(ruleSet, txs);

  if (mode === 'dry-run') {
    return { mode, decisions, stateHash: store.stateHash() };
  }
  if (mode === 'apply') {
    const fault = flags.fault || null;
    const result = store.apply(batchId, txs, decisions, fault);
    return { mode, batchId, decisions: result.decisions, stateHash: store.stateHash() };
  }
  throw new RiskError('RULE_PARSE', `unknown mode ${mode}`);
}

function cmdRecover(flags) {
  const store = new StateStore(flags.state || '.risk-state');
  return store.recover();
}

function main(argv) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseFlags(rest);
  let out;
  switch (command) {
    case 'equiv':
      out = cmdEquiv(positional[0], positional[1]);
      break;
    case 'run':
      out = cmdRun(positional[0], positional[1], flags);
      break;
    case 'recover':
      out = cmdRecover(flags);
      break;
    default:
      console.error('usage:');
      console.error('  node cli.js equiv a.re b.re');
      console.error('  node cli.js run rules.re tx.jsonl [--mode dry-run|apply|undo] [--state DIR] [--batch ID] [--fault FP1|FP2|FP3]');
      console.error('  node cli.js recover [--state DIR]');
      throw new RiskError('RULE_PARSE', 'unknown command');
  }
  return out;
}

if (require.main === module) {
  try {
    const out = main(process.argv.slice(2));
    console.log(JSON.stringify(out, null, 2));
  } catch (err) {
    if (err instanceof RiskError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(1);
    }
    throw err;
  }
}

module.exports = { main };
