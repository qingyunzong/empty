#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const store = require('./src/store');

const EXIT_CODES = {
  ERR_FORMAT: 2,
  ERR_CRC: 3,
  ERR_CHAIN: 4,
  ERR_RANGE: 5,
  ERR_CONFLICT: 6,
};

const USAGE = `usage:
  node cli.js append  <file> --payload <str> | --payload-file <path> [--ts <ms>]
  node cli.js correct <file> <id> --payload <str> | --payload-file <path> [--ts <ms>]
  node cli.js undo    <file> <correctId>
  node cli.js scan    <file>
  node cli.js verify  <file>
  node cli.js decode  <file> [--start <ms>] [--end <ms>]`;

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 >= argv.length) throw new CliError('ERR_USAGE', `missing value for ${a}`);
      opt[key] = argv[++i];
    } else {
      pos.push(a);
    }
  }
  return { pos, opt };
}

function toInt(name, value, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw new CliError('ERR_USAGE', `missing required argument: ${name}`);
    return undefined;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new CliError('ERR_RANGE', `invalid integer for ${name}: ${value}`);
  }
  return n;
}

function readPayload(opt) {
  if (opt.payload !== undefined && opt['payload-file'] !== undefined) {
    throw new CliError('ERR_USAGE', 'use either --payload or --payload-file, not both');
  }
  if (opt['payload-file'] !== undefined) {
    try {
      return fs.readFileSync(opt['payload-file']);
    } catch (err) {
      throw new CliError('ERR_FORMAT', `cannot read payload file: ${err.message}`);
    }
  }
  if (opt.payload !== undefined) return Buffer.from(opt.payload, 'utf8');
  throw new CliError('ERR_USAGE', 'missing --payload or --payload-file');
}

function formatPayload(buf) {
  const s = buf.toString('utf8');
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e\n\r\t]*$/.test(s) ? s : { base64: buf.toString('base64') };
}

function dispatch(cmd, pos, opt, out) {
  switch (cmd) {
    case 'append': {
      const [file] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'append: missing <file>');
      const ts = toInt('--ts', opt.ts);
      const res = store.append(file, readPayload(opt), ts === undefined ? {} : { timestamp: ts });
      out({ ok: true, ...res });
      return 0;
    }
    case 'correct': {
      const [file, id] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'correct: missing <file>');
      const ts = toInt('--ts', opt.ts);
      const res = store.correct(file, toInt('id', id, { required: true }), readPayload(opt),
        ts === undefined ? {} : { timestamp: ts });
      out({ ok: true, ...res });
      return 0;
    }
    case 'undo': {
      const [file, id] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'undo: missing <file>');
      out({ ok: true, ...store.undo(file, toInt('correctId', id, { required: true })) });
      return 0;
    }
    case 'scan': {
      const [file] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'scan: missing <file>');
      out(store.scan(file));
      return 0;
    }
    case 'verify': {
      const [file] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'verify: missing <file>');
      const report = store.verify(file);
      out(report);
      if (!report.ok) {
        const first = report.errors[0];
        throw new CliError(first.code, `verify failed: ${first.message}`, { errors: report.errors.length });
      }
      return 0;
    }
    case 'decode': {
      const [file] = pos;
      if (!file) throw new CliError('ERR_USAGE', 'decode: missing <file>');
      const start = toInt('--start', opt.start);
      const end = toInt('--end', opt.end);
      const res = store.decode(file, { start, end });
      out({ ...res, records: res.records.map((r) => ({ ...r, payload: formatPayload(r.payload) })) });
      return 0;
    }
    default:
      throw new CliError('ERR_USAGE', cmd ? `unknown command: ${cmd}` : 'missing command');
  }
}

// Runs the CLI programmatically; returns { status, stdout, stderr }.
function run(argv) {
  const chunks = [];
  const out = (value) => chunks.push(JSON.stringify(value, null, 2) + '\n');
  try {
    const [cmd, ...rest] = argv;
    const { pos, opt } = parseArgs(rest);
    const status = dispatch(cmd, pos, opt, out);
    return { status, stdout: chunks.join(''), stderr: '' };
  } catch (err) {
    let code = 'ERR_INTERNAL';
    let message = String((err && err.message) || err);
    let details;
    if (err instanceof CliError || (err && err.code && EXIT_CODES[err.code])) {
      code = err.code;
      details = err.details;
    }
    const error = { code, message };
    if (details !== undefined) error.details = details;
    let stderr = '';
    if (code === 'ERR_USAGE') stderr += USAGE + '\n';
    stderr += JSON.stringify({ error }) + '\n';
    return { status: EXIT_CODES[code] || 1, stdout: chunks.join(''), stderr };
  }
}

if (require.main === module) {
  const r = run(process.argv.slice(2));
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exitCode = r.status;
}

module.exports = { run, EXIT_CODES };
