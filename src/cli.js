'use strict';

const fs = require('fs');
const { EXIT, JudgeError } = require('./model');
const { judgeText } = require('./judge');

const USAGE = [
  'usage: judge <history.jsonl> [--explain out.json] [--balance account=amount ...]',
  '',
  'Judges whether a command history admits a serializable schedule.',
  'Exit codes: 0 judgment made (SAT or UNSAT), 2 usage/IO error,',
  '            12 invalid interval, 13 depends cycle, 14 unknown command',
].join('\n');

function parseArgs(argv) {
  const args = { file: null, explain: null, balances: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--explain') {
      i += 1;
      if (i >= argv.length) throw new JudgeError(EXIT.USAGE, '--explain requires a path');
      args.explain = argv[i];
    } else if (arg === '--balance') {
      i += 1;
      if (i >= argv.length) throw new JudgeError(EXIT.USAGE, '--balance requires account=amount');
      const eq = argv[i].indexOf('=');
      const amount = Number(argv[i].slice(eq + 1));
      if (eq <= 0 || !Number.isFinite(amount)) {
        throw new JudgeError(EXIT.USAGE, `invalid --balance "${argv[i]}" (want account=amount)`);
      }
      args.balances[argv[i].slice(0, eq)] = amount;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg.startsWith('-')) {
      throw new JudgeError(EXIT.USAGE, `unknown option "${arg}"`);
    } else if (args.file === null) {
      args.file = arg;
    } else {
      throw new JudgeError(EXIT.USAGE, `unexpected argument "${arg}"`);
    }
  }
  return args;
}

function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n${USAGE}\n`);
    return err.code || EXIT.USAGE;
  }
  if (args.help || args.file === null) {
    (args.help ? stdout : stderr).write(`${USAGE}\n`);
    return args.help ? EXIT.OK : EXIT.USAGE;
  }
  let text;
  try {
    text = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    stderr.write(`cannot read ${args.file}: ${err.message}\n`);
    return EXIT.USAGE;
  }
  let result;
  try {
    result = judgeText(text, { balances: args.balances });
  } catch (err) {
    if (err instanceof JudgeError) {
      stderr.write(`error: ${err.message}\n`);
      return err.code;
    }
    throw err;
  }
  if (result.verdict === 'SAT') {
    stdout.write(`SAT\nwitness: ${result.witness.join(' ')}\n`);
  } else {
    stdout.write(`UNSAT\nconflict: ${result.conflict.join(' ')}\n`);
  }
  if (args.explain) {
    fs.writeFileSync(args.explain, `${JSON.stringify(result, null, 2)}\n`);
  }
  return EXIT.OK;
}

module.exports = { main, parseArgs };
