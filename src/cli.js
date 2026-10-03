#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { analyze, ReconError } from './recon.js';

const USAGE = 'usage: node src/cli.js minimize <recon.json>';

export function run(argv, stdout = process.stdout, stderr = process.stderr) {
  const [command, file] = argv;
  if (command !== 'minimize' || !file || argv.length !== 2) {
    stderr.write(`${USAGE}\n`);
    return 2;
  }
  let input;
  try {
    input = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    stderr.write(`${JSON.stringify({ error: 'INVALID_RECON', reason: `cannot read recon file: ${err.message}` })}\n`);
    return 1;
  }
  try {
    stdout.write(`${JSON.stringify(analyze(input), null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ReconError) {
      stderr.write(`${JSON.stringify({ error: 'INVALID_RECON', reason: err.message })}\n`);
      return 1;
    }
    throw err;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
