#!/usr/bin/env node
// repro-dag CLI. JSON input comes from --file or stdin; results are JSON on
// stdout; errors are JSON on stderr with exit code 1 and a fixed `code`
// (CYCLE | MISSING_INPUT | BAD_CERT).
//
//   repro-dag <add|run|invalidate|audit|gc|tombstone|register-runner>
//             [--state PATH] [--file INPUT.json]

import { readFileSync } from 'node:fs';
import { cliMain } from '../src/cli.js';

const code = cliMain(process.argv.slice(2), {
  readStdin: () => readFileSync(0, 'utf8'),
  writeOut: (s) => process.stdout.write(s),
  writeErr: (s) => process.stderr.write(s),
});
process.exit(code);
