#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseHistory, judge, JudgeError } from '../src/judge.js';

const USAGE = 'usage: judge <history.jsonl> [--explain out.json]';

function main(argv) {
  let file = null;
  let explain = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--explain') {
      explain = argv[i + 1];
      if (explain === undefined) {
        console.error(USAGE);
        return 2;
      }
      i++;
    } else if (file === null) {
      file = argv[i];
    } else {
      console.error(USAGE);
      return 2;
    }
  }
  if (file === null) {
    console.error(USAGE);
    return 2;
  }

  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`judge: cannot read ${file}: ${err.message}`);
    return 2;
  }

  try {
    const commands = parseHistory(text);
    const outcome = judge(commands);
    if (explain !== null) {
      writeFileSync(explain, JSON.stringify(outcome, null, 2) + '\n');
    }
    if (outcome.result === 'SAT') {
      console.log(`SAT witness: ${outcome.witness.join(' ')}`);
      return 0;
    }
    console.log(`UNSAT conflict: ${outcome.conflict.join(' ')}`);
    return 1;
  } catch (err) {
    if (err instanceof JudgeError) {
      if (explain !== null) {
        writeFileSync(
          explain,
          JSON.stringify({ result: 'ERROR', code: err.code, message: err.message }, null, 2) + '\n',
        );
      }
      console.error(`judge: ${err.message}`);
      return err.code;
    }
    throw err;
  }
}

process.exitCode = main(process.argv.slice(2));
