#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  SettlementError,
  executeCommand,
  initLogDir,
  loadLogDir,
  makeFileEmitter,
  computeHash,
} from './src/settlement.js';

function readJsonFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new SettlementError('INVALID_INPUT', `cannot read file: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new SettlementError('INVALID_INPUT', `file is not valid JSON: ${file}`);
  }
}

function usage() {
  throw new SettlementError(
    'INVALID_INPUT',
    'usage: cli.js init <logDir> <accounts.json> | submit <logDir> <command.json> | rebuild <logDir>',
  );
}

function dispatch(argv) {
  const [command, logDir, arg] = argv;
  if (!command || !logDir) usage();

  switch (command) {
    case 'init': {
      if (!arg) usage();
      initLogDir(logDir, readJsonFile(arg));
      return { ok: true };
    }
    case 'submit': {
      if (!arg) usage();
      const state = loadLogDir(logDir);
      return executeCommand(state, readJsonFile(arg), makeFileEmitter(logDir));
    }
    case 'rebuild': {
      const state = loadLogDir(logDir);
      return {
        accounts: state.accounts,
        settlements: state.settlements,
        seq: state.seq,
        hash: computeHash(state),
      };
    }
    default:
      usage();
  }
}

export function run(argv, write = (text) => process.stdout.write(text)) {
  try {
    write(`${JSON.stringify(dispatch(argv))}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof SettlementError ? error.code : 'INTERNAL';
    const message = error instanceof Error ? error.message : String(error);
    write(`${JSON.stringify({ error: code, message })}\n`);
    return 1;
  }
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  process.exit(run(process.argv.slice(2)));
}
