#!/usr/bin/env node
import fs from 'node:fs';
import { runCli } from '../src/cli.js';

const code = runCli(process.argv.slice(2), {
  readStdin: () => fs.readFileSync(0, 'utf8'),
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
});
process.exit(code);
