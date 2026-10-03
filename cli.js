#!/usr/bin/env node
import fs from 'node:fs';
import { execute, CliError, CRASH_EXIT_CODE } from './src/workflow.js';

function fail(code, message) {
  process.stdout.write(JSON.stringify({ error: code, message }) + '\n');
  process.exit(1);
}

function main(argv) {
  const [commandArg, stateDir] = argv;
  if (!commandArg || !stateDir) {
    fail('INVALID_INPUT', 'usage: node cli.js <command.json|inline-json> <stateDir>');
  }

  let command;
  try {
    const raw = fs.existsSync(commandArg) ? fs.readFileSync(commandArg, 'utf8') : commandArg;
    command = JSON.parse(raw);
  } catch {
    fail('INVALID_INPUT', 'command is not valid JSON');
  }

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const result = execute(stateDir, command);
    if (result.crash) {
      process.stdout.write(JSON.stringify({ crash: result.crash }) + '\n');
      process.exit(CRASH_EXIT_CODE);
    }
    process.stdout.write(JSON.stringify(result.certificate) + '\n');
  } catch (err) {
    if (err instanceof CliError) {
      fail(err.code, err.message);
    }
    fail('INTERNAL', String(err && err.message ? err.message : err));
  }
}

main(process.argv.slice(2));
