'use strict';

const fs = require('node:fs');
const { Engine, FrameError } = require('./engine');
const { Framer } = require('./framer');

const USAGE = [
  'usage: node cli.js <ops.jsonl|-> [options]',
  '',
  'options:',
  '  --limit=N         credit limit (default 1000)',
  '  --ttl=MS          default auth ttl in virtual-clock units (default 1000)',
  '  --wal=PATH        WAL file for crash recovery (default: in-memory)',
  '  --fresh           truncate the WAL before starting',
  '  --crash-after=N   simulate a crash after the Nth WAL append (exit 1)',
  '',
  'exit codes: 0 ok, 2 frame error, 3 state conflict (see certificate.rejected)',
].join('\n');

class CrashError extends Error {
  constructor() {
    super('simulated crash after WAL append, before reply');
    this.name = 'CrashError';
  }
}

function parseArgs(argv) {
  const opts = { input: null, limit: 1000, ttl: 1000, wal: null, fresh: false, crashAfter: null };
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) opts.limit = Number(arg.slice('--limit='.length));
    else if (arg.startsWith('--ttl=')) opts.ttl = Number(arg.slice('--ttl='.length));
    else if (arg.startsWith('--wal=')) opts.wal = arg.slice('--wal='.length);
    else if (arg === '--fresh') opts.fresh = true;
    else if (arg.startsWith('--crash-after=')) opts.crashAfter = Number(arg.slice('--crash-after='.length));
    else if (arg === '--help' || arg === '-h') return { help: true };
    else if (!arg.startsWith('--') && opts.input === null) opts.input = arg;
    else return { error: 'unknown argument: ' + arg };
  }
  if (opts.input === null) return { error: 'missing input file' };
  if (!Number.isFinite(opts.limit) || opts.limit < 0) return { error: 'invalid --limit' };
  if (!Number.isFinite(opts.ttl) || opts.ttl <= 0) return { error: 'invalid --ttl' };
  if (opts.crashAfter !== null && (!Number.isInteger(opts.crashAfter) || opts.crashAfter < 1)) {
    return { error: 'invalid --crash-after' };
  }
  return { opts };
}

async function* chunksOf(input, stdin) {
  if (input === '-') {
    if (stdin === undefined || stdin === null) return;
    if (typeof stdin === 'string' || Buffer.isBuffer(stdin)) {
      yield stdin;
    } else {
      for await (const chunk of stdin) yield chunk;
    }
  } else {
    const stream = fs.createReadStream(input, { encoding: 'utf8' });
    for await (const chunk of stream) yield chunk;
  }
}

// Runs the CLI logic in-process. Returns { code, stdout, stderr }.
// Exit codes: 0 ok, 1 crash simulation, 2 frame/usage error, 3 state conflict.
async function run(argv, { stdin } = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { code: 0, stdout: USAGE + '\n', stderr: '' };
  if (parsed.error) return { code: 2, stdout: '', stderr: parsed.error + '\n' + USAGE + '\n' };
  const opts = parsed.opts;

  const engine = new Engine({
    limit: opts.limit,
    ttl: opts.ttl,
    walPath: opts.wal,
    fresh: opts.fresh,
    onAppend: opts.crashAfter === null
      ? null
      : (n) => { if (n === opts.crashAfter) throw new CrashError(); },
  });

  const framer = new Framer();
  const replies = [];
  try {
    for await (const chunk of chunksOf(opts.input, stdin)) {
      for (const msg of framer.push(chunk)) {
        replies.push(engine.apply(msg));
      }
    }
    framer.end();
  } catch (err) {
    if (err instanceof CrashError) {
      // WAL already contains the record; the reply was never sent.
      return { code: 1, stdout: '', stderr: 'crash: ' + err.message + '\n' };
    }
    if (err instanceof FrameError) {
      return { code: 2, stdout: '', stderr: 'frame error: ' + err.message + '\n' };
    }
    throw err;
  }

  const report = engine.finalize();
  report.replies = replies;
  return {
    code: report.conflicted ? 3 : 0,
    stdout: JSON.stringify(report, null, 2) + '\n',
    stderr: '',
  };
}

module.exports = { run, USAGE };
