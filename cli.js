#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildReport, verifyReport, NaiveMismatchError } from './src/audit.js';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_NAIVE_MISMATCH = 3;
export const EXIT_VERIFY_FAILED = 4;

function usage(io) {
  io.error(
    [
      'usage:',
      '  node cli.js audit build  --in events.jsonl --out report.json [--window-size ms] [--lateness ms] [--naive]',
      '  node cli.js audit verify --in report.json',
    ].join('\n'),
  );
}

function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body === 'naive') {
        flags.naive = true;
      } else {
        i += 1;
        if (i >= args.length) throw new Error(`missing value for --${body}`);
        flags[body] = args[i];
      }
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

function readJsonl(path) {
  const text = readFileSync(path, 'utf8');
  const events = [];
  text.split('\n').forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      throw new Error(`${path}:${idx + 1}: invalid JSON line`);
    }
  });
  return events;
}

export function main(argv, io = { log: console.log, error: console.error }) {
  const [scope, command, ...rest] = argv;
  if (scope !== 'audit' || (command !== 'build' && command !== 'verify')) {
    usage(io);
    return EXIT_USAGE;
  }
  let flags;
  try {
    flags = parseFlags(rest);
  } catch (err) {
    io.error(`error: ${err.message}`);
    usage(io);
    return EXIT_USAGE;
  }

  if (command === 'build') {
    if (!flags.in || !flags.out) {
      usage(io);
      return EXIT_USAGE;
    }
    try {
      const events = readJsonl(flags.in);
      const opts = {
        windowSize: flags['window-size'] !== undefined ? Number(flags['window-size']) : undefined,
        allowedLateness: flags.lateness !== undefined ? Number(flags.lateness) : undefined,
        naive: Boolean(flags.naive),
      };
      const report = buildReport(events, opts);
      writeFileSync(flags.out, JSON.stringify(report, null, 2) + '\n');
      io.log(
        `built report: windows=${report.windows.length} appendix=${report.appendix.length} ` +
          `errors=${report.errors.length} root=${report.root}`,
      );
      return EXIT_OK;
    } catch (err) {
      if (err instanceof NaiveMismatchError) {
        io.error(`naive mismatch: ${err.message}`);
        return EXIT_NAIVE_MISMATCH;
      }
      io.error(`error: ${err.message}`);
      return EXIT_USAGE;
    }
  }

  // verify
  if (!flags.in) {
    usage(io);
    return EXIT_USAGE;
  }
  let report;
  try {
    report = JSON.parse(readFileSync(flags.in, 'utf8'));
  } catch (err) {
    io.error(`error: cannot read report: ${err.message}`);
    return EXIT_USAGE;
  }
  const failures = verifyReport(report);
  if (failures.length > 0) {
    for (const f of failures) io.error(`MISMATCH ${f}`);
    io.error(`verify failed: ${failures.length} problem(s)`);
    return EXIT_VERIFY_FAILED;
  }
  io.log(`verify OK root=${report.root}`);
  return EXIT_OK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
