#!/usr/bin/env node
import { runPack } from '../src/pack.js';
import { CrashInjected, PackError } from '../src/errors.js';

const USAGE = `usage: pack quarantine --in <dir> --out <dir> [--crash before-rename|after-rename]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      args[key] = next !== undefined && !next.startsWith('--') ? (argv[++i], next) : true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args._[0] !== 'quarantine' || !args.in || !args.out) {
    console.error(USAGE);
    process.exit(64);
  }
  try {
    const { release, late } = runPack(args.in, args.out, { crashPoint: args.crash || null });
    console.log(`cases=${release.counts.total} release=${release.counts.RELEASE} quar=${release.counts.QUAR} conflict=${release.counts.CONFLICT} late=${late.length}`);
    console.log(`outputs written to ${args.out}: cases.jsonl release.json wal.jsonl late.log`);
  } catch (err) {
    if (err instanceof PackError) {
      console.error(`${err.code}: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof CrashInjected) {
      console.error(`CRASH_SIMULATED ${err.point}`);
      process.exit(2);
    }
    throw err;
  }
}

main();
