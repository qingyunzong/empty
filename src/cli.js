#!/usr/bin/env node
import {
  StoreError,
  initStore,
  applyLocalOps,
  mergeEvents,
  mergeFromStore,
  compactStore,
  status,
} from './store.js';
import { compareVclock } from './vclock.js';

const USAGE = `usage:
  obs init --dir D --node N [--nodes a,b,c]
  obs put|correct|delete --dir D [--node N]     # JSON lines on stdin
  obs merge --dir D [--other DIR]               # or event JSON lines on stdin
  obs status --dir D
  obs compact --dir D [--now MS] [--retention-ms MS]
  obs compare                                   # two vclock JSON lines on stdin`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[key] = argv[i + 1];
        i += 1;
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function requireOpt(opts, name) {
  if (opts[name] === undefined || opts[name] === true) {
    throw new StoreError('USAGE', `missing required option --${name}`);
  }
  return opts[name];
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function stdinLines(text) {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new StoreError('INVALID_INPUT', `invalid JSON line: ${line.slice(0, 80)}`);
  }
}

const RELATION = { eq: 'equal', lt: 'before', gt: 'after', concurrent: 'concurrent' };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (cmd) {
    case 'init': {
      const dir = requireOpt(opts, 'dir');
      const node = requireOpt(opts, 'node');
      const nodes = typeof opts.nodes === 'string' ? opts.nodes.split(',').filter(Boolean) : [];
      const meta = initStore(dir, { node, nodes });
      console.log(JSON.stringify({ ok: true, dir, node: meta.node, nodes: meta.nodes }));
      break;
    }
    case 'put':
    case 'correct':
    case 'delete': {
      const dir = requireOpt(opts, 'dir');
      const lines = stdinLines(await readStdin());
      if (lines.length === 0) {
        throw new StoreError('INVALID_INPUT', 'expected at least one JSON line on stdin');
      }
      const ops = lines.map((line) => {
        const o = parseJsonLine(line);
        const op = { ...o, kind: cmd };
        if (opts.node) op.node = opts.node;
        return op;
      });
      const events = applyLocalOps(dir, ops);
      for (const e of events) console.log(JSON.stringify(e));
      break;
    }
    case 'merge': {
      const dir = requireOpt(opts, 'dir');
      let result;
      if (opts.other) {
        result = mergeFromStore(dir, opts.other);
      } else {
        const lines = stdinLines(await readStdin());
        if (lines.length === 0) {
          throw new StoreError('INVALID_INPUT', 'expected event JSON lines on stdin (or --other DIR)');
        }
        result = mergeEvents(dir, lines.map(parseJsonLine));
      }
      console.log(JSON.stringify({ ok: true, ...result }));
      break;
    }
    case 'status': {
      const dir = requireOpt(opts, 'dir');
      console.log(JSON.stringify(status(dir)));
      break;
    }
    case 'compact': {
      const dir = requireOpt(opts, 'dir');
      const now = opts.now !== undefined ? Number(opts.now) : Date.now();
      const retentionMs = opts['retention-ms'] !== undefined ? Number(opts['retention-ms']) : 0;
      if (!Number.isFinite(now) || !Number.isFinite(retentionMs) || retentionMs < 0) {
        throw new StoreError('INVALID_INPUT', '--now and --retention-ms must be numbers (retention >= 0)');
      }
      const result = compactStore(dir, { now, retentionMs });
      console.log(JSON.stringify({ ok: true, ...result }));
      break;
    }
    case 'compare': {
      const lines = stdinLines(await readStdin());
      if (lines.length !== 2) {
        throw new StoreError('INVALID_INPUT', 'compare expects exactly two JSON lines (vclocks or events)');
      }
      const [x, y] = lines.map(parseJsonLine);
      const a = x && x.vclock ? x.vclock : x;
      const b = y && y.vclock ? y.vclock : y;
      console.log(JSON.stringify({ ok: true, relation: RELATION[compareVclock(a, b)] }));
      break;
    }
    default:
      throw new StoreError('USAGE', cmd ? `unknown command: ${cmd}` : USAGE);
  }
}

main().then(
  () => {},
  (err) => {
    const code = err && err.code ? err.code : 'INTERNAL';
    const msg = err && err.message ? err.message : String(err);
    process.stderr.write(JSON.stringify({ code, msg }) + '\n');
    process.exit(code === 'USAGE' ? 2 : 1);
  },
);
