#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EXIT, ReplayError } from './errors.js';
import { analyze, buildCompensation } from './analyze.js';

const USAGE = `usage:
  tool-life replay <log> [--config file]   replay events, print final state
  tool-life undo <log> --target <id> [--config file] [--append]
                                           emit a compensation event and the recovery path
  tool-life budget <log> [--config file]   print layered budget consumption
  tool-life audit <log> [--config file]    verify causal integrity, locks, conflicts, scraps

log: JSONL file (one event per line) or a JSON array; '-' reads stdin
exit codes: 0 ok, 2 usage, 12 budget exceeded, 13 illegal transition, 14 conflict`;

function readLog(path, stdin) {
  const text = path === '-' ? stdin() : readFileSync(path, 'utf8');
  const trimmed = text.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split('\n').map((line) => JSON.parse(line));
}

export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io.stderr ?? ((s) => process.stderr.write(s));
  const stdin = io.stdin ?? (() => readFileSync(0, 'utf8'));
  const print = (obj) => stdout(`${JSON.stringify(obj, null, 2)}\n`);
  try {
    const [cmd, ...rest] = argv;
    if (!['replay', 'undo', 'budget', 'audit'].includes(cmd)) {
      throw new ReplayError(EXIT.USAGE, USAGE);
    }
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        config: { type: 'string' },
        target: { type: 'string' },
        append: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const [logPath] = positionals;
    if (!logPath) throw new ReplayError(EXIT.USAGE, USAGE);
    const events = readLog(logPath, stdin);
    const config = values.config ? JSON.parse(readFileSync(values.config, 'utf8')) : {};

    if (cmd === 'undo') {
      if (!values.target) throw new ReplayError(EXIT.USAGE, 'undo requires --target <measureId>');
      const compensation = buildCompensation(events, values.target);
      const { outcome, error } = analyze([...events, compensation], config);
      const canAppend = values.append && logPath !== '-';
      if (canAppend) {
        const current = readFileSync(logPath, 'utf8');
        appendFileSync(logPath, `${current.endsWith('\n') || current === '' ? '' : '\n'}${JSON.stringify(compensation)}\n`);
      }
      print({
        compensation,
        appended: canAppend,
        recovery: outcome.recovery,
        compensations: outcome.compensations,
        scraps: outcome.scraps,
        locks: outcome.locks,
        layers: outcome.layers,
        tools: outcome.tools,
        analysisError: error,
      });
      return EXIT.OK;
    }

    const { outcome, conflict, error, canonical } = analyze(events, config);
    if (cmd === 'replay') {
      print({ order: canonical, ...outcome });
    } else if (cmd === 'budget') {
      print({ tools: outcome.tools, layers: outcome.layers });
    } else {
      print({
        ok: !error,
        error,
        conflict,
        order: canonical,
        overspendPoint: outcome.overspendPoint,
        locks: outcome.locks,
        scraps: outcome.scraps,
        compensations: outcome.compensations,
        recovery: outcome.recovery,
        errors: outcome.errors,
      });
    }
    if (error) {
      stderr(`${JSON.stringify({ error }, null, 2)}\n`);
      return error.code;
    }
    return EXIT.OK;
  } catch (err) {
    if (err instanceof ReplayError) {
      stderr(`${JSON.stringify({ error: { code: err.code, message: err.message, details: err.details } }, null, 2)}\n`);
      return err.code;
    }
    stderr(`${err?.message ?? err}\n`);
    return EXIT.USAGE;
  }
}

const invokedAsMain = (() => {
  try {
    return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  process.exitCode = run(process.argv.slice(2));
}
