#!/usr/bin/env node
'use strict';

const lib = require('./index');

const USAGE = [
  'node cli.js build <src> <data> <idx> [blockSize] [N]',
  'node cli.js read <data> <idx> <offset> <len>',
  'node cli.js verify <data> <idx>',
  'node cli.js repair <data> <idx> [N]',
];

// Runs one CLI command. io = { out(Buffer|string), err(string) }.
// Returns the process exit code. All errors are reported as JSON on err.
function run(argv, io) {
  const emitErr = (code, details) => {
    io.err(JSON.stringify({ error: code, ...details }) + '\n');
    return 1;
  };
  try {
    const [cmd, ...args] = argv;
    switch (cmd) {
      case 'build': {
        const [src, data, idx, blockSize, n] = args;
        if (!src || !data || !idx) return emitErr('ERR_USAGE', { usage: USAGE });
        const stats = lib.build(src, data, idx, {
          blockSize: blockSize ? Number(blockSize) : undefined,
          n: n ? Number(n) : undefined,
        });
        io.out(JSON.stringify({ ok: true, ...stats }) + '\n');
        return 0;
      }
      case 'read': {
        const [data, idx, offset, len] = args;
        if (!data || !idx || offset === undefined || len === undefined) {
          return emitErr('ERR_USAGE', { usage: USAGE });
        }
        const h = lib.open(data, idx);
        try {
          const buf = h.read(Number(offset), Number(len));
          if (buf === null) {
            return emitErr('ERR_BLOOM', {
              offset: Number(offset), len: Number(len), reason: 'bloom negative',
            });
          }
          io.out(buf);
          return 0;
        } finally {
          h.close();
        }
      }
      case 'verify': {
        const [data, idx] = args;
        if (!data || !idx) return emitErr('ERR_USAGE', { usage: USAGE });
        const h = lib.open(data, idx);
        try {
          if (!h.verifyIndex()) return emitErr('ERR_INDEX', { reason: 'index does not match data' });
          io.out(JSON.stringify({ ok: true }) + '\n');
          return 0;
        } finally {
          h.close();
        }
      }
      case 'repair': {
        const [data, idx, n] = args;
        if (!data || !idx) return emitErr('ERR_USAGE', { usage: USAGE });
        const stats = lib.repair(data, idx, { n: n ? Number(n) : undefined });
        io.out(JSON.stringify({ ok: true, ...stats }) + '\n');
        return 0;
      }
      default:
        return emitErr('ERR_USAGE', { usage: USAGE });
    }
  } catch (err) {
    if (err && err.code && String(err.code).startsWith('ERR_')) {
      return emitErr(err.code, { message: err.message, ...(err.details || {}) });
    }
    return emitErr('ERR_INTERNAL', { message: String((err && err.message) || err) });
  }
}

module.exports = { run };

if (require.main === module) {
  const code = run(process.argv.slice(2), {
    out: (b) => process.stdout.write(b),
    err: (s) => process.stderr.write(s),
  });
  process.exitCode = code || 0;
}
