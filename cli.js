#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Engine } = require('./src/engine');
const { MonitorError, EXIT_USAGE } = require('./src/errors');

const USAGE = 'usage: node cli.js <input.jsonl> [--wal PATH] [--chk PATH] [--pattern REGEX]';

class UsageError extends Error {}

function parseArgs(argv) {
  const args = { wal: null, chk: null, pattern: null, input: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wal') args.wal = argv[++i];
    else if (a === '--chk') args.chk = argv[++i];
    else if (a === '--pattern') args.pattern = argv[++i];
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else if (args.input === null) args.input = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!args.input) throw new UsageError('missing input file');
  if (!args.wal) args.wal = `${args.input}.wal`;
  if (!args.chk) args.chk = `${args.input}.chk`;
  return args;
}

// Runs the monitor over an input JSONL file. Returns the process exit code.
// `io` lets tests capture output in-process: { stdout(line), stderr(line) }.
function run(argv, io = { stdout: (l) => process.stdout.write(`${l}\n`), stderr: (l) => process.stderr.write(`${l}\n`) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`error: ${err.message}`);
      io.stderr(USAGE);
      return EXIT_USAGE;
    }
    throw err;
  }

  try {
    const text = fs.readFileSync(args.input, 'utf8');
    const lines = text.split('\n');
    let engine = null;
    let pattern = args.pattern;

    const openEngine = () => {
      if (!pattern) {
        throw new MonitorError('BAD_INPUT', 'no pattern: provide an init record or --pattern');
      }
      if (!engine) {
        engine = Engine.open({ walPath: args.wal, chkPath: args.chk, pattern });
      }
    };

    lines.forEach((raw, idx) => {
      const line = raw.trim();
      if (line === '') return;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        throw new MonitorError('BAD_INPUT', `line ${idx + 1}: invalid JSON`);
      }
      switch (cmd.type) {
        case 'init': {
          if (typeof cmd.pattern !== 'string' || cmd.pattern.trim() === '') {
            throw new MonitorError('BAD_INPUT', `line ${idx + 1}: init requires a non-empty "pattern"`);
          }
          if (pattern && pattern !== cmd.pattern) {
            throw new MonitorError('PATTERN_MISMATCH', `line ${idx + 1}: init pattern conflicts with --pattern`);
          }
          pattern = cmd.pattern;
          openEngine();
          io.stdout(JSON.stringify({ type: 'init', pattern, seq: engine.seq, hash: engine.hash }));
          break;
        }
        case 'batch': {
          openEngine();
          io.stdout(JSON.stringify({ type: 'batch', ...engine.batch(cmd.events) }));
          break;
        }
        case 'checkpoint': {
          openEngine();
          io.stdout(JSON.stringify({ type: 'checkpoint', ...engine.checkpoint() }));
          break;
        }
        case 'crash': {
          openEngine();
          io.stdout(JSON.stringify({ type: 'recovered', ...engine.crash({ torn: Boolean(cmd.torn) }) }));
          break;
        }
        case 'status': {
          openEngine();
          io.stdout(JSON.stringify({ type: 'status', ...engine.status() }));
          break;
        }
        default:
          throw new MonitorError('BAD_INPUT', `line ${idx + 1}: unknown command type ${JSON.stringify(cmd.type)}`);
      }
    });

    if (engine) engine.close();
    return 0;
  } catch (err) {
    if (err instanceof MonitorError) {
      io.stderr(`error[${err.code}]: ${err.message}`);
      return err.exitCode;
    }
    if (err && err.code === 'ENOENT') {
      io.stderr(`error: cannot read ${args.input}: ${err.message}`);
      return EXIT_USAGE;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
