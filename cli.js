#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadProtocol } = require('./lib/protocol');
const { Engine } = require('./lib/engine');

const USAGE = `Usage:
  node cli.js run     --protocol p.json --journal run.jsonl [--state dir] [--result f]
                      [--crash-at before-effect|after-effect|during-checkpoint:<step>]
                      [--abort-step id] [--now ms]
  node cli.js recover --journal run.jsonl [--protocol p.json] [--state dir]
                      [--report f] [--result f] [--now ms]
  node cli.js abort   --journal run.jsonl --step id [--state dir] [--reason r]

Exit codes: 0 ok, 1 usage/io, 2 consistency error (missing product,
timeout-but-joined, abort of completed join), 75 injected crash.`;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    }
  }
  return flags;
}

function fail(code, message, exitCode) {
  const err = new Error(message);
  err.code = code;
  err.exitCode = exitCode;
  return err;
}

function parseCrashAt(value) {
  if (!value || value === true) return null;
  const idx = value.indexOf(':');
  if (idx === -1) throw fail('USAGE', `--crash-at must be <point>:<step>, got ${value}`, 1);
  const point = value.slice(0, idx);
  if (!['before-effect', 'after-effect', 'during-checkpoint'].includes(point)) {
    throw fail('USAGE', `unknown crash point ${point}`, 1);
  }
  return { point, step: value.slice(idx + 1) };
}

function resolvePaths(flags) {
  if (!flags.journal) throw fail('USAGE', '--journal is required', 1);
  const journalPath = path.resolve(flags.journal);
  const dir = path.dirname(journalPath);
  return {
    journalPath,
    stateDir: path.resolve(flags.state || path.join(dir, 'state')),
    resultPath: path.resolve(flags.result || path.join(dir, 'result.json')),
    reportPath: path.resolve(flags.report || path.join(dir, 'recovery_report.json')),
  };
}

function loadProtocolForRecover(flags, stateDir) {
  if (flags.protocol) return loadProtocol(flags.protocol);
  const snapshot = path.join(stateDir, 'protocol.json');
  if (!fs.existsSync(snapshot)) {
    throw fail('USAGE', `no --protocol given and no snapshot at ${snapshot}`, 1);
  }
  return loadProtocol(snapshot);
}

function cmdRun(flags) {
  if (!flags.protocol) throw fail('USAGE', '--protocol is required', 1);
  const { journalPath, stateDir, resultPath } = resolvePaths(flags);
  const protocolPath = path.resolve(flags.protocol);
  const protocol = loadProtocol(protocolPath);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.copyFileSync(protocolPath, path.join(stateDir, 'protocol.json'));
  const engine = new Engine({
    protocol,
    journalPath,
    stateDir,
    now: flags.now == null ? undefined : Number(flags.now),
    crashAt: parseCrashAt(flags['crash-at']),
    abortStep: flags['abort-step'] || null,
  });
  const { result } = engine.run();
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`run ${result.status} -> ${resultPath}`);
  return 0;
}

function cmdRecover(flags) {
  const { journalPath, stateDir, resultPath, reportPath } = resolvePaths(flags);
  const protocol = loadProtocolForRecover(flags, stateDir);
  const engine = new Engine({
    protocol,
    journalPath,
    stateDir,
    now: flags.now == null ? undefined : Number(flags.now),
  });
  const { report, result } = engine.run();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`recovered (${result.status}) -> ${reportPath}`);
  return 0;
}

function cmdAbort(flags) {
  if (!flags.step) throw fail('USAGE', '--step is required', 1);
  const { journalPath, stateDir } = resolvePaths(flags);
  const protocol = loadProtocolForRecover(flags, stateDir);
  const engine = new Engine({ protocol, journalPath, stateDir });
  const { abort, compensations } = engine.abort(flags.step, flags.reason || 'operator');
  console.log(
    `aborted ${flags.step} (attempt ${abort.attempt}); compensations: ${compensations.length}`,
  );
  return 0;
}

function main(argv) {
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  try {
    switch (cmd) {
      case 'run':
        return cmdRun(flags);
      case 'recover':
        return cmdRecover(flags);
      case 'abort':
        return cmdAbort(flags);
      default:
        console.error(USAGE);
        return 1;
    }
  } catch (err) {
    if (err && err.exitCode != null) {
      console.error(`error[${err.code}]: ${err.message}`);
      return err.exitCode;
    }
    console.error(`error: ${err && err.message ? err.message : err}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
