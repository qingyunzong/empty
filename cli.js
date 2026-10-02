#!/usr/bin/env node
'use strict';

const path = require('node:path');
const hist = require('./lib/history');

function parseArgs(argv) {
  const opts = { dir: process.env.HIST_DIR || './.history', author: undefined };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--author') opts.author = argv[++i];
    else if (arg === '--parents') opts.parents = argv[++i].split(',').filter(Boolean);
    else if (arg === '--payload') opts.payload = argv[++i];
    else pos.push(arg);
  }
  return { opts, pos };
}

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function main() {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  const dir = path.resolve(opts.dir);
  const cmd = pos[0];
  switch (cmd) {
    case 'init':
      out(hist.init(dir));
      break;
    case 'append': {
      if (!opts.author) throw new hist.HistError('ERR_HEAD', 'append requires --author');
      const payload = opts.payload === undefined ? null : JSON.parse(opts.payload);
      out(hist.append(dir, { author: opts.author, payload, parents: opts.parents }));
      break;
    }
    case 'merge': {
      const [, a, b] = pos;
      if (!a || !b) throw new hist.HistError('ERR_HEAD', 'merge requires two head ids');
      out(hist.merge(dir, a, b, opts.author ? { author: opts.author } : {}));
      break;
    }
    case 'heads':
      out(hist.heads(dir));
      break;
    case 'is-ancestor': {
      const [, a, b] = pos;
      if (!a || !b) throw new hist.HistError('ERR_HEAD', 'is-ancestor requires two ids');
      out({ a, b, result: hist.isAncestor(dir, a, b) });
      break;
    }
    case 'checkout': {
      const [, head] = pos;
      if (!head) throw new hist.HistError('ERR_HEAD', 'checkout requires a head id');
      out(hist.checkout(dir, head));
      break;
    }
    case 'undo': {
      const [, target] = pos;
      if (!target) throw new hist.HistError('ERR_HEAD', 'undo requires a head id');
      out(hist.undo(dir, target, opts.author ? { author: opts.author } : {}));
      break;
    }
    default:
      throw new hist.HistError('ERR_HEAD', `unknown command ${cmd ?? '(none)'}; expected init|append|merge|heads|is-ancestor|checkout|undo`);
  }
}

try {
  main();
} catch (err) {
  const code = err && typeof err.code === 'string' && err.code.startsWith('ERR_') ? err.code : 'ERR_INTERNAL';
  const body = { error: code, message: err.message };
  if (err.details !== undefined) body.details = err.details;
  process.stderr.write(JSON.stringify(body) + '\n');
  process.exit(1);
}
