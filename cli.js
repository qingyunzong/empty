#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runProtocol, recoverProtocol } from './src/engine.js';
import { EngineError, CrashError } from './src/errors.js';

const USAGE = `usage:
  node cli.js run     --protocol p.json --journal run.jsonl [--state dir] [--result f]
                      [--crash-at step:point] [--abort-at step] [--now ms] [--run-id id]
  node cli.js recover --journal run.jsonl [--state dir] [--result f] [--report f]
                      [--abort-at step] [--now ms]

fault-injection points: <step>:before-effect | <step>:after-effect | <step>:during-checkpoint
exit codes: 0 completed, 1 aborted (compensated), 2 consistency/usage error, 70 simulated crash`;

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run' && command !== 'recover') throw new EngineError('USAGE', USAGE);
  const { values } = parseArgs({
    args: rest,
    options: {
      protocol: { type: 'string' },
      journal: { type: 'string' },
      state: { type: 'string' },
      result: { type: 'string' },
      report: { type: 'string' },
      now: { type: 'string' },
      'crash-at': { type: 'string' },
      'abort-at': { type: 'string' },
      'run-id': { type: 'string' },
    },
  });
  if (!values.journal) throw new EngineError('USAGE', `--journal is required\n${USAGE}`);
  const journalPath = values.journal;
  const baseDir = path.dirname(journalPath);
  const opts = {
    journalPath,
    stateDir: values.state ?? path.join(baseDir, 'state'),
    resultPath: values.result ?? path.join(baseDir, 'result.json'),
    reportPath: values.report ?? path.join(baseDir, 'recovery_report.json'),
    crashAt: values['crash-at'] ?? null,
    abortAt: values['abort-at'] ?? null,
    runId: values['run-id'],
  };
  if (values.now != null) {
    opts.now = Number(values.now);
    if (Number.isNaN(opts.now)) throw new EngineError('USAGE', '--now must be a number (ms epoch)');
  }
  let outcome;
  if (command === 'run') {
    if (!values.protocol) throw new EngineError('USAGE', `--protocol is required for run\n${USAGE}`);
    outcome = runProtocol({ ...opts, protocolPath: values.protocol });
  } else {
    outcome = recoverProtocol(opts);
  }
  console.log(JSON.stringify({ status: outcome.status }));
  return outcome.status === 'completed' ? 0 : 1;
}

let exitCode;
try {
  exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof CrashError) {
    console.error(`crash: ${e.message}`);
    exitCode = 70;
  } else if (e instanceof EngineError) {
    console.error(`error[${e.code}]: ${e.message}`);
    exitCode = 2;
  } else {
    console.error(e);
    exitCode = 2;
  }
}
// Set exitCode instead of process.exit() so piped stdout/stderr flush fully.
process.exitCode = exitCode;
