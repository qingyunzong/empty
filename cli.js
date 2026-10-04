#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { audit } = require('./src/ledger');
const { equivPatterns, minimizePatterns, verifyMinimization } = require('./src/automata');
const { applyRules, snapshot, undo } = require('./src/state');
const { RegexError } = require('./src/regex');

const USAGE = `usage:
  node cli.js audit <rules.json> <ledger.jsonl>     audit a ledger, prints { match, summary }
  node cli.js equiv <rulesA.json> <rulesB.json>     rule-set equivalence, prints { equiv, witness }
  node cli.js minimize <rules.json>                 minimized DFA + verifiable partition certificate
  node cli.js apply <rules.json> --state <file>     install a new rule version (validated first)
  node cli.js snapshot --state <file>               record an explicit snapshot
  node cli.js undo --state <file>                   revert to the latest explicit snapshot

rules.json:   { "rules": [ { "id": "r1", "pattern": "...", "decision": "flag"|"pass" } ] }
ledger.jsonl: one JSON object per line with fields
              batch, account, currency, amount, direction, timestamp
patterns:     literals, [classes] / [^classes], concatenation, a|b, a*, a?, (...)
              matched against "batch|account|currency|amount|direction|timestamp"`;

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    const e = new Error(`cannot read ${path}: ${err.message}`);
    e.code = 'BAD_LINE';
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RegexError(`file ${path} is not valid JSON`);
  }
}

function ruleDefsOf(doc) {
  return Array.isArray(doc) ? doc : doc.rules;
}

function patternsOf(doc) {
  const defs = ruleDefsOf(doc);
  if (!Array.isArray(defs)) throw new RegexError('rules file must contain a "rules" array');
  return defs.map((d, i) => {
    if (!d || typeof d.pattern !== 'string') {
      throw new RegexError(`rule ${i} must have a string 'pattern'`);
    }
    return d.pattern;
  });
}

function statePathOf(flags) {
  if (!flags.state) {
    const e = new Error('missing required --state <file>');
    e.code = 'BAD_LINE';
    throw e;
  }
  return flags.state;
}

// Runs one CLI command in-process; returns { code, stdout, stderr }.
function run(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state') flags.state = rest[++i];
    else positional.push(rest[i]);
  }

  const emit = (obj) => ({ code: 0, stdout: JSON.stringify(obj, null, 2) + '\n', stderr: '' });

  try {
    switch (cmd) {
      case 'audit': {
        const [rulesPath, ledgerPath] = positional;
        const rules = ruleDefsOf(readJson(rulesPath));
        const text = fs.readFileSync(ledgerPath, 'utf8');
        const result = audit(rules, text);
        return emit({ match: result.match, summary: result.summary });
      }
      case 'equiv': {
        const [a, b] = positional;
        return emit(equivPatterns(patternsOf(readJson(a)), patternsOf(readJson(b))));
      }
      case 'minimize': {
        const { complete, certificate } = minimizePatterns(patternsOf(readJson(positional[0])));
        return emit({
          minimized: {
            states: certificate.blocks.length,
            blocks: certificate.blocks,
            certificateValid: verifyMinimization(complete, certificate).ok,
            certificate,
          },
        });
      }
      case 'apply': {
        const st = applyRules(statePathOf(flags), ruleDefsOf(readJson(positional[0])));
        return emit({ hash: st.hash, rules: st.rules.length, snapshots: st.snapshots.length });
      }
      case 'snapshot': {
        const st = snapshot(statePathOf(flags));
        return emit({ hash: st.hash, snapshots: st.snapshots.length });
      }
      case 'undo': {
        const st = undo(statePathOf(flags));
        return emit({ hash: st.hash, rules: st.rules.length, snapshots: st.snapshots.length });
      }
      default:
        return { code: 2, stdout: '', stderr: USAGE + '\n' };
    }
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL';
    const message = err && err.message ? err.message : String(err);
    return { code: 1, stdout: '', stderr: JSON.stringify({ error: { code, message } }) + '\n' };
  }
}

if (require.main === module) {
  const res = run(process.argv.slice(2));
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exitCode = res.code;
}

module.exports = { run };
