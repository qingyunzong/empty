#!/usr/bin/env node
'use strict';

const { Store } = require('../src/store');
const { ArchiveError } = require('../src/errors');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        if (args[key] === undefined) args[key] = argv[++i];
        else if (Array.isArray(args[key])) args[key].push(argv[++i]);
        else args[key] = [args[key], argv[++i]];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function num(v) {
  return v === undefined || v === true ? undefined : Number(v);
}

function requireArchive(args) {
  if (!args.archive || args.archive === true) {
    throw new ArchiveError('E_WINDOW', 'missing --archive DIR');
  }
  return new Store(args.archive);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  let out;
  switch (cmd) {
    case 'append': {
      const store = requireArchive(args);
      out = store.append({
        device: args.device,
        ts: num(args.ts),
        text: args.text,
      });
      break;
    }
    case 'freeze': {
      out = requireArchive(args).freeze();
      break;
    }
    case 'merge': {
      out = requireArchive(args).mergeWindow(num(args.from), num(args.to));
      break;
    }
    case 'retain': {
      const opts = {};
      if (args.before !== undefined) opts.before = num(args.before);
      if (args.until !== undefined) opts.until = num(args.until);
      out = requireArchive(args).retain(opts);
      break;
    }
    case 'query': {
      const store = requireArchive(args);
      if (args.phrase !== undefined) {
        out = store.query({ phrase: args.phrase });
      } else {
        const nearArgs = [
          ...(typeof args.near === 'string'
            ? [args.near]
            : Array.isArray(args.near)
              ? args.near
              : []),
          ...args._,
        ];
        out = store.query({
          near: { a: nearArgs[0], b: nearArgs[1], k: num(args.k) },
        });
      }
      break;
    }
    case 'stats': {
      out = requireArchive(args).stats();
      break;
    }
    default:
      process.stderr.write(
        'usage: shift-archive <append|freeze|merge|retain|query|stats> --archive DIR [options]\n',
      );
      process.exit(2);
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

try {
  main();
} catch (err) {
  if (err instanceof ArchiveError) {
    process.stderr.write(`${err.code}: ${err.message}\n`);
    process.exit(1);
  }
  throw err;
}
