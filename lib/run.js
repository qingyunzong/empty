'use strict';

const fs = require('fs');
const { Engine } = require('./core');
const { Link } = require('./link');
const { AppendOnlyLog } = require('./log');
const { CorruptFrameError } = require('./frame');
const { formatEntry } = require('./format');

const EXIT_OK = 0;
const EXIT_CORRUPT_FRAME = 2;
const EXIT_OVER_BUDGET = 3;
const EXIT_UNKNOWN_REQID = 4;
const EXIT_CRASH = 75; // simulated crash; restart the same command to recover

// Thrown at a crash point selected with GW_CRASH_AT=pre:N|log:N|ack:N.
// Everything already appended to the log survives; everything not yet
// appended is recomputed deterministically on recovery.
class CrashError extends Error {
  constructor(point, n) {
    super(`simulated crash at ${point}:${n}`);
    this.code = 'CRASH';
    this.exitCode = EXIT_CRASH;
  }
}

// Runs the gateway over a frame file. Returns the process exit code.
// `write`/`errWrite` default to stdout/stderr so tests can capture output.
function runGateway({ input, budget = 1000, ttl = 100, fresh = false, crashAt = '', write, errWrite }) {
  write = write || ((s) => process.stdout.write(s));
  errWrite = errWrite || ((s) => process.stderr.write(s));

  const logPath = input + '.log';
  if (fresh && fs.existsSync(logPath)) fs.unlinkSync(logPath);

  let log;
  try {
    log = new AppendOnlyLog(logPath); // an existing log means crash recovery
  } catch (err) {
    if (err.code === 'CORRUPT_LOG') {
      errWrite(`error: ${err.message}\n`);
      return EXIT_CORRUPT_FRAME;
    }
    throw err;
  }

  const crashSpec = /^([a-z]+):(\d+)$/.exec(crashAt || '');
  const crashHook = (point, n) => {
    if (crashSpec && crashSpec[1] === point && Number(crashSpec[2]) === n) throw new CrashError(point, n);
  };

  const engine = new Engine({
    budgetCap: budget,
    ttl,
    log,
    crashHook,
    emit: (entry) => write(formatEntry(entry) + '\n'),
  });
  if (log.entries.length) engine.replay(log.entries);

  const link = new Link();
  let frames;
  try {
    frames = [...link.push(fs.readFileSync(input)), ...link.end()];
  } catch (err) {
    if (err instanceof CorruptFrameError) {
      errWrite(`error: corrupt frame: ${err.message}\n`);
      return EXIT_CORRUPT_FRAME;
    }
    throw err;
  }

  for (const frame of frames) engine.ingest(frame);
  engine.flush();

  write(
    `summary requests=${engine.reqCount} used=${engine.used} reserved=${engine.reservedTotal()}` +
    ` remaining=${engine.remainingBudget()} merkle=${log.root()}\n`,
  );
  return engine.firstError || EXIT_OK;
}

module.exports = {
  runGateway, CrashError,
  EXIT_OK, EXIT_CORRUPT_FRAME, EXIT_OVER_BUDGET, EXIT_UNKNOWN_REQID, EXIT_CRASH,
};
