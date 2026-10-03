#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { processHistory, HistoryError } from './src/engine.js';

function errorPayload(code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return JSON.stringify({ error }) + '\n';
}

export async function run(argv, io) {
  if (argv.length !== 1) {
    io.stderr(errorPayload('USAGE', 'usage: node cli.js <history.json>'));
    return 1;
  }

  let history;
  try {
    const text = await readFile(argv[0], 'utf8');
    history = JSON.parse(text);
  } catch (err) {
    io.stderr(errorPayload('INPUT_ERROR', `cannot read or parse history file "${argv[0]}": ${err.message}`));
    return 1;
  }

  try {
    const certificate = processHistory(history);
    io.stdout(JSON.stringify(certificate, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof HistoryError) {
      io.stderr(errorPayload(err.code, err.message, err.details));
      return 1;
    }
    throw err;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const exitCode = await run(process.argv.slice(2), {
    stdout: (chunk) => process.stdout.write(chunk),
    stderr: (chunk) => process.stderr.write(chunk),
  });
  process.exit(exitCode);
}
