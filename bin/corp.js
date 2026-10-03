#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from '../src/parser.js';
import { compile } from '../src/compiler.js';
import { VM } from '../src/vm.js';
import { CaError } from '../src/errors.js';
import { formatJournal, formatState } from '../src/report.js';

const USAGE = 'usage: corp apply <actions.ca> <lots.json> [--ledger]\n       corp compile <actions.ca>';

export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const args = rest.filter((a) => !a.startsWith('--'));

  try {
    if (cmd === 'apply') {
      const [caFile, lotsFile] = args;
      if (!caFile || !lotsFile) {
        io.err(USAGE);
        return 2;
      }
      const src = readFileSync(caFile, 'utf8');
      const lotsInput = JSON.parse(readFileSync(lotsFile, 'utf8'));
      const program = parse(src);
      const { instructions } = compile(program);
      const vm = new VM(lotsInput);
      vm.run(instructions);
      if (flags.has('--ledger')) io.out(formatJournal(vm));
      io.out(formatState(vm));
      return 0;
    }
    if (cmd === 'compile') {
      const [caFile] = args;
      if (!caFile) {
        io.err(USAGE);
        return 2;
      }
      const { instructions } = compile(parse(readFileSync(caFile, 'utf8')));
      io.out(JSON.stringify(instructions, null, 2));
      return 0;
    }
    io.err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof CaError) {
      io.err(`${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
