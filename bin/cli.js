#!/usr/bin/env node
// causallint CLI
//
//   causallint check <rules.dsl> <history.jsonl> [--json out.json]
//   causallint verify <out.json>
//
// Exit codes:
//   0  check: LINEARIZABLE        verify: certificate valid
//   1  check: NON_LINEARIZABLE    verify: certificate invalid
//   2  format/usage error (messages carry file and line numbers)
//   3  check: UNKNOWN (required events missing)

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseDsl } from '../src/parser.js';
import { typeCheck } from '../src/types.js';
import { compileProgram } from '../src/bytecode.js';
import { parseHistory } from '../src/history.js';
import { runCheck } from '../src/checker.js';
import { buildReport, verifyReport } from '../src/verify.js';

export const EXIT = { LINEARIZABLE: 0, NON_LINEARIZABLE: 1, FORMAT: 2, UNKNOWN: 3 };

function usage(io) {
  io.stderr('usage: causallint check <rules.dsl> <history.jsonl> [--json out.json]');
  io.stderr('       causallint verify <out.json>');
  return EXIT.FORMAT;
}

function reportError(io, e) {
  if (e && e.file !== undefined && e.line !== undefined) {
    const col = e.col !== undefined ? `:${e.col}` : '';
    io.stderr(`${e.file}:${e.line}${col}: error: ${e.message}`);
  } else {
    io.stderr(`error: ${e.message}`);
  }
}

function cmdCheck(args, io) {
  let jsonOut = null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      if (i + 1 >= args.length) return usage(io);
      jsonOut = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 2) return usage(io);
  const [rulesFile, historyFile] = positional;

  let rulesSource;
  let historySource;
  try {
    rulesSource = readFileSync(rulesFile, 'utf8');
  } catch (e) {
    io.stderr(`${rulesFile}: error: cannot read file: ${e.message}`);
    return EXIT.FORMAT;
  }
  try {
    historySource = readFileSync(historyFile, 'utf8');
  } catch (e) {
    io.stderr(`${historyFile}: error: cannot read file: ${e.message}`);
    return EXIT.FORMAT;
  }

  try {
    const program = typeCheck(parseDsl(rulesSource, rulesFile));
    const compiled = compileProgram(program);
    const events = parseHistory(historySource, historyFile);
    const result = runCheck(events, compiled, historyFile);
    const report = buildReport({ rulesSource, historySource, result });

    if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    for (const v of result.versions) {
      io.stdout(`version ${v.version}: ${v.verdict} (${v.status})`);
    }
    io.stdout(result.verdict);
    return EXIT[result.verdict];
  } catch (e) {
    reportError(io, e);
    return EXIT.FORMAT;
  }
}

function cmdVerify(args, io) {
  if (args.length !== 1) return usage(io);
  const file = args[0];
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    io.stderr(`${file}: error: cannot parse report: ${e.message}`);
    return EXIT.FORMAT;
  }
  try {
    const r = verifyReport(report);
    if (r.ok) {
      io.stdout(`OK (${r.verdict})`);
      return 0;
    }
    for (const m of r.mismatches) io.stderr(`${file}: mismatch: ${m}`);
    io.stdout('INVALID');
    return 1;
  } catch (e) {
    reportError(io, e);
    return EXIT.FORMAT;
  }
}

// Programmatic entry: returns the exit code.
export function main(argv, io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) }) {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') return cmdCheck(rest, io);
  if (cmd === 'verify') return cmdVerify(rest, io);
  return usage(io);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
