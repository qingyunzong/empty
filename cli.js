#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { RuleBase, RuleError, RegexSyntaxError } = require('./src/engine');

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(2);
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    fail(`${path}: cannot read file: ${err.message}`);
  }
}

function applyLog(base, path) {
  const content = readFile(path);
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = lines[i].trim();
    if (text === '') continue;
    let op;
    try {
      op = JSON.parse(text);
    } catch (err) {
      fail(`${path}:${lineNo}: invalid JSON: ${err.message}`);
    }
    if (op === null || typeof op !== 'object' || typeof op.op !== 'string') {
      fail(`${path}:${lineNo}: expected an object with a string "op" field`);
    }
    try {
      switch (op.op) {
        case 'add':
          base.add(op.id, op.level, op.pattern);
          break;
        case 'del':
          base.del(op.id);
          break;
        case 'undo':
          base.undo(op.k === undefined ? 1 : op.k);
          break;
        case 'redo':
          base.redo(op.k === undefined ? 1 : op.k);
          break;
        default:
          fail(`${path}:${lineNo}: unknown op: ${JSON.stringify(op.op)}`);
      }
    } catch (err) {
      if (err instanceof RegexSyntaxError) {
        fail(`${path}:${lineNo}:${err.index + 1}: regex syntax error in rule ${op.id}: ${err.message}`);
      }
      if (err instanceof RuleError) {
        fail(`${path}:${lineNo}: ${err.message}`);
      }
      throw err;
    }
  }
}

function main(argv) {
  const positional = [];
  let equivPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--equiv') {
      equivPath = argv[++i];
      if (!equivPath) fail('cli.js: --equiv requires a rules.jsonl path');
    } else {
      positional.push(argv[i]);
    }
  }
  const [rulesPath, planPath] = positional;
  if (!rulesPath || !planPath) {
    process.stderr.write('usage: node cli.js <rules.jsonl> <plan.txt> [--equiv <other-rules.jsonl>]\n');
    process.exit(64);
  }

  const base = new RuleBase();
  applyLog(base, rulesPath);

  const plan = readFile(planPath).replace(/\s+/g, '');
  const result = base.classify(plan);
  const out = {
    status: result.status,
    matchedRuleIds: result.matchedRuleIds,
    witness: result.witness,
    snapshotHash: base.snapshotHash(),
  };

  if (equivPath) {
    const other = new RuleBase();
    applyLog(other, equivPath);
    out.equivalence = base.equivalentTo(other);
  }

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main(process.argv.slice(2));
