#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

const stateFile = process.env.AUDIT_STATE_FILE || join(process.cwd(), 'audit-state.json');

process.exitCode = runCli(process.argv.slice(2), {
  stateFile,
  readStdin: () => readFileSync(0, 'utf8'),
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
});
