#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { buildReport, verifyReport, NAIVE_MAX_EVENTS } = require('./src/ledger');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_TAMPERED = 4;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function readJsonl(path, stderr) {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line);
    } catch {
      stderr(`error: invalid JSON on line ${idx + 1} of ${path}`);
      return null;
    }
  });
}

function main(argv, io = {}) {
  const stdout = io.stdout || ((msg) => console.log(msg));
  const stderr = io.stderr || ((msg) => console.error(msg));
  const args = parseArgs(argv);
  const [scope, command] = args._;
  if (scope !== 'audit' || (command !== 'build' && command !== 'verify')) {
    stderr('usage:');
    stderr('  node cli.js audit build  --in <events.jsonl> --out <report.json> [--window-size N] [--lateness N] [--naive]');
    stderr('  node cli.js audit verify --in <report.json>');
    return EXIT_USAGE;
  }

  if (command === 'build') {
    if (!args.in || !args.out) {
      stderr('error: build requires --in and --out');
      return EXIT_USAGE;
    }
    let events;
    try {
      events = readJsonl(args.in, stderr);
    } catch (err) {
      stderr(`error: cannot read input: ${err.message}`);
      return EXIT_USAGE;
    }
    if (events.some((e) => e === null)) return EXIT_USAGE;
    const windowSize = args['window-size'] !== undefined ? Number(args['window-size']) : 3600;
    const lateness = args.lateness !== undefined ? Number(args.lateness) : 0;
    if (args.naive && events.length > NAIVE_MAX_EVENTS) {
      stderr(`error: --naive supports at most ${NAIVE_MAX_EVENTS} events, got ${events.length}`);
      return EXIT_USAGE;
    }
    let report;
    try {
      report = buildReport(events, { windowSize, lateness, naive: !!args.naive });
    } catch (err) {
      stderr(`error: build failed: ${err.message}`);
      return EXIT_USAGE;
    }
    fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    stdout(`built ${report.windows.length} window(s), ${report.appendix.length} appendix entrie(s), ${report.errors.length} error(s)`);
    if (args.naive) stdout('naive cross-check: OK');
    stdout(`root: ${report.root}`);
    return EXIT_OK;
  }

  if (!args.in) {
    stderr('error: verify requires --in <report.json>');
    return EXIT_USAGE;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  } catch (err) {
    stderr(`error: cannot read report: ${err.message}`);
    return EXIT_USAGE;
  }
  const result = verifyReport(report);
  if (result.ok) {
    stdout(`OK: report verified, root=${report.root}`);
    return EXIT_OK;
  }
  for (const failure of result.failures) {
    stderr(`MISMATCH at ${failure.where}: ${failure.detail}`);
  }
  return EXIT_TAMPERED;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, parseArgs, EXIT_OK, EXIT_USAGE, EXIT_TAMPERED };
