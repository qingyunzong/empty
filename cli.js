#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { RcError } = require('./src/errors');
const { tokenizeTx, TOKEN_INDEX } = require('./src/tokens');
const { loadRulesFile } = require('./src/ruleset');
const { checkEquivalence } = require('./src/automata');
const { compileSearchDFA, evaluateTokens } = require('./src/engine');
const state = require('./src/state');

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[++i];
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function fail(err) {
  const code = err.code || 'INTERNAL';
  const out = { error: code, message: err.message };
  if (err.point) out.point = err.point;
  process.stderr.write(JSON.stringify(out) + '\n');
  process.exit(code === 'FAULT_INJECTED' ? 70 : 1);
}

function cmdEquiv(args) {
  const { positional } = parseFlags(args);
  if (positional.length !== 2) {
    throw new RcError('USAGE', 'usage: node cli.js equiv <a.re> <b.re>');
  }
  const astsA = loadRulesFile(positional[0]);
  const astsB = loadRulesFile(positional[1]);
  const result = checkEquivalence(astsA, astsB);
  const out = {
    equiv: result.equiv,
    certA: result.certA,
    certB: result.certB,
    witness: result.witness
      ? { tokens: result.witness, text: result.witness.join(''), length: result.witness.length }
      : null,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function readTxlog(path) {
  const txs = [];
  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      txs.push(JSON.parse(line));
    } catch {
      throw new RcError('TXLOG_PARSE', `invalid JSON at ${path}:${i + 1}`);
    }
  }
  return txs;
}

function decide(txs, searchDfa) {
  const tokens = new Array(txs.length);
  const errors = new Array(txs.length).fill(null);
  for (let i = 0; i < txs.length; i++) {
    try {
      tokens[i] = tokenizeTx(txs[i]);
    } catch (e) {
      if (e.code === 'TOKEN_UNKNOWN') {
        tokens[i] = null;
        errors[i] = e.message;
      } else throw e;
    }
  }
  // evaluate only the well-formed prefix stream; unknown tokens break the stream
  const hits = new Array(txs.length).fill(false);
  let state = searchDfa.start;
  for (let i = 0; i < txs.length; i++) {
    if (tokens[i] === null) continue; // error tx: no stream advancement
    state = searchDfa.trans[state][TOKEN_INDEX.get(tokens[i])];
    hits[i] = searchDfa.accept.has(state);
  }
  return txs.map((tx, i) => {
    if (errors[i]) {
      return { id: tx.id ?? i, account: tx.account, amount: tx.amount, token: null, decision: 'ERROR', code: 'TOKEN_UNKNOWN', reason: errors[i] };
    }
    return {
      id: tx.id ?? i,
      account: tx.account,
      amount: tx.amount,
      token: tokens[i],
      decision: hits[i] ? 'REJECT' : 'ACCEPT',
      ...(hits[i] ? { reason: 'RULE_HIT' } : {}),
    };
  });
}

function cmdRun(args) {
  const { flags, positional } = parseFlags(args);
  if (positional.length !== 2) {
    throw new RcError('USAGE', 'usage: node cli.js run <rules.re> <tx.jsonl> [--mode dry-run|apply] [--state p] [--fail-at f] [--quota n]');
  }
  const mode = flags.mode || 'dry-run';
  const quota = flags.quota ? Number(flags.quota) : 50000;
  const asts = loadRulesFile(positional[0]);
  const searchDfa = compileSearchDFA(asts);
  const txs = readTxlog(positional[1]);
  const decisions = decide(txs, searchDfa);

  if (mode === 'dry-run') {
    const working = flags.state ? state.loadState(flags.state) : state.emptyState();
    simulateQuota(working, decisions, quota);
    printRun(mode, decisions, state.stateHash(working));
    return;
  }
  if (mode === 'apply') {
    if (!flags.state) throw new RcError('USAGE', '--state is required for --mode apply');
    const failAt = flags['fail-at'] || process.env.RC_FAIL_AT || null;
    const result = state.applyRun({ statePath: flags.state, decisions, quota, failAt });
    printRun(mode, result.decisions, state.stateHash(result.state), result.runId);
    return;
  }
  throw new RcError('USAGE', `unknown mode: ${mode}`);
}

function simulateQuota(working, decisions, quota) {
  for (const d of decisions) {
    if (d.decision !== 'ACCEPT') continue;
    if (!working.accounts[d.account]) working.accounts[d.account] = { quota, used: 0 };
    const acct = working.accounts[d.account];
    if (acct.used + d.amount > acct.quota) {
      d.decision = 'REJECT';
      d.reason = 'QUOTA_EXCEEDED';
    } else {
      acct.used += d.amount;
    }
  }
}

function printRun(mode, decisions, hash, runId) {
  const summary = { ACCEPT: 0, REJECT: 0, ERROR: 0 };
  for (const d of decisions) summary[d.decision]++;
  const out = { mode, decisions, summary, stateHash: hash };
  if (runId) out.runId = runId;
  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdUndo(args) {
  const { flags } = parseFlags(args);
  if (!flags.state) throw new RcError('USAGE', 'usage: node cli.js undo --state <p>');
  const result = state.undo(flags.state);
  process.stdout.write(JSON.stringify({ undoneRun: result.undoneRun, stateHash: state.stateHash(result.state) }) + '\n');
}

function cmdRecover(args) {
  const { flags } = parseFlags(args);
  if (!flags.state) throw new RcError('USAGE', 'usage: node cli.js recover --state <p>');
  const result = state.recover(flags.state);
  process.stdout.write(JSON.stringify({ recovered: result.recovered, stateHash: state.stateHash(result.state) }) + '\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'equiv': return cmdEquiv(rest);
    case 'run': return cmdRun(rest);
    case 'undo': return cmdUndo(rest);
    case 'recover': return cmdRecover(rest);
    default:
      throw new RcError('USAGE', 'commands: equiv | run | undo | recover');
  }
}

try {
  main();
} catch (err) {
  fail(err);
}
