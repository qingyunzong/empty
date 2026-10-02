#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const wx = require('./lib/wxblk');

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

function num(opts, key, { required = false } = {}) {
  if (opts[key] === undefined) {
    if (required) throw new CliError('ERR_RANGE', `missing required option --${key}`);
    return undefined;
  }
  const n = Number(opts[key]);
  if (!Number.isFinite(n)) {
    throw new CliError('ERR_RANGE', `option --${key} must be a number, got "${opts[key]}"`);
  }
  return n;
}

function readPayload(opts) {
  if (opts['payload-file'] !== undefined) {
    try {
      return fs.readFileSync(opts['payload-file']);
    } catch (e) {
      throw new CliError('ERR_FORMAT', `cannot read payload file: ${e.message}`);
    }
  }
  if (opts.payload === undefined) {
    throw new CliError('ERR_FORMAT', 'missing --payload (or --payload-file)');
  }
  return String(opts.payload);
}

const USAGE = `usage:
  node cli.js append  <file> --payload STR [--payload-file P] [--ts MS]
  node cli.js correct <file> --id N --payload STR [--payload-file P] [--ts MS]
  node cli.js undo    <file> --correct-id N [--ts MS]
  node cli.js scan    <file>
  node cli.js verify  <file>
  node cli.js decode  <file> [--from N --to N] [--since MS --until MS]`;

// Runs one CLI invocation. Returns the exit code; output goes to io.stdout /
// io.stderr (strings). Errors are reported as JSON on stderr with a non-zero
// exit code.
function run(argv, io) {
  try {
    const { positional, opts } = parseArgs(argv);
    const [cmd, file] = positional;
    if (!cmd || !file) {
      io.stderr(USAGE + '\n');
      return 2;
    }
    const ts = num(opts, 'ts');
    let result;
    switch (cmd) {
      case 'append':
        result = wx.append(file, readPayload(opts), { ts });
        break;
      case 'correct':
        result = wx.correct(file, num(opts, 'id', { required: true }), readPayload(opts), { ts });
        break;
      case 'undo':
        result = wx.undo(file, num(opts, 'correct-id', { required: true }), { ts });
        break;
      case 'scan':
        result = wx.scan(file);
        break;
      case 'verify':
        result = wx.verify(file);
        break;
      case 'decode':
        result = wx.decode(file, {
          from: num(opts, 'from'), to: num(opts, 'to'),
          since: num(opts, 'since'), until: num(opts, 'until'),
        });
        break;
      default:
        throw new CliError('ERR_FORMAT', `unknown command: ${cmd}`);
    }
    io.stdout(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (e) {
    const code = e instanceof wx.WxError || e instanceof CliError ? e.code : 'ERR_FORMAT';
    const out = { error: code, message: e.message };
    if (e.details !== undefined) out.details = e.details;
    io.stderr(JSON.stringify(out) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

module.exports = { run };
