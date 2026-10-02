#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseLog, evaluate, HistError } = require('./index');

const USAGE =
  'usage: node cli.js <hist.jsonl> --as-of <ts:seq> [--branch <name>] [--account <name>]\n' +
  '\n' +
  'Evaluates whether the credit account must be frozen at the given\n' +
  'historical point over a (possibly branching) offline event log.\n' +
  'Prints a JSON verdict { frozen, rule, explanation } on stdout.\n' +
  'Exits 1 with E_FORK / E_TIME / E_PARSE on stderr for invalid input.\n';

function parseArgs(args) {
  const opts = { file: null, asOf: null, branch: undefined, account: undefined, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const takeValue = (name) => {
      if (inlineValue !== null) return inlineValue;
      if (i + 1 >= args.length) throw new HistError('E_USAGE', `option ${name} needs a value`);
      return args[++i];
    };
    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--as-of':
        opts.asOf = takeValue('--as-of');
        break;
      case '--branch':
        opts.branch = takeValue('--branch');
        break;
      case '--account':
        opts.account = takeValue('--account');
        break;
      default:
        if (arg.startsWith('-')) throw new HistError('E_USAGE', `unknown option ${arg}`);
        if (opts.file !== null) throw new HistError('E_USAGE', `unexpected argument ${arg}`);
        opts.file = arg;
    }
  }
  if (opts.help) return opts;
  if (opts.file === null) throw new HistError('E_USAGE', 'missing <hist.jsonl> path');
  if (opts.asOf === null) throw new HistError('E_TIME', 'missing --as-of <ts:seq>');
  return opts;
}

// Returns { code, stdout, stderr } so it can be tested in-process.
function run(args, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  try {
    const opts = parseArgs(args);
    if (opts.help) return { code: 0, stdout: USAGE, stderr: '' };
    let text;
    try {
      text = readFile(opts.file);
    } catch (err) {
      throw new HistError('E_IO', `cannot read ${opts.file}: ${err.message}`);
    }
    const events = parseLog(text);
    const result = evaluate(events, { asOf: opts.asOf, branch: opts.branch, account: opts.account });
    return { code: 0, stdout: JSON.stringify(result, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : 'E_INTERNAL';
    const message = err && err.message ? err.message : String(err);
    const stderr = `${code}: ${message}\n` + (code === 'E_USAGE' ? USAGE : '');
    return { code: 1, stdout: '', stderr };
  }
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

module.exports = { run, parseArgs, USAGE };
