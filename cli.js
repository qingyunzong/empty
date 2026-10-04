#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './src/store.js';
import { findRoute } from './src/router.js';
import { RouteError } from './src/errors.js';

const EXIT_CODES = {
  E_CONFLICT: 2,
  E_CYCLE: 3,
  E_CAPACITY: 4,
  E_CORRUPT: 5,
  E_NO_PATH: 6,
  E_NOT_FOUND: 7,
  E_INVALID: 8,
};

const STORE_OPT = { store: { type: 'string', default: '.route-store' } };

function graphSummary(graph) {
  const edges = [];
  for (const [from, outs] of graph.edges) {
    for (const to of outs) edges.push([from, to]);
  }
  edges.sort();
  return {
    nodes: [...graph.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges,
    deviceLoad: Object.fromEntries(graph.deviceLoad),
  };
}

// Runs one CLI invocation in-process; returns { code, stdout, stderr }.
export function runCli(argv) {
  let stdout = '';
  const out = (obj) => {
    stdout += JSON.stringify(obj) + '\n';
  };
  try {
    dispatch(argv, out);
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const code = err.code ?? 'E_INTERNAL';
    const body = { error: code, message: err.message, ...(err.details ?? {}) };
    return {
      code: EXIT_CODES[code] ?? 1,
      stdout,
      stderr: JSON.stringify(body) + '\n',
    };
  }
}

function dispatch(argv, out) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init': {
      const { values } = parseArgs({ args: rest, options: { ...STORE_OPT } });
      const store = Store.init(values.store);
      out({ version: store.head() });
      break;
    }
    case 'commit': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...STORE_OPT,
          base: { type: 'string' },
          read: { type: 'string', default: '' },
          change: { type: 'string' },
          'change-file': { type: 'string' },
        },
      });
      const change = values['change-file']
        ? JSON.parse(readFileSync(values['change-file'], 'utf8'))
        : JSON.parse(values.change ?? '{}');
      const readSet = values.read ? values.read.split(',').filter(Boolean) : [];
      const store = new Store(values.store);
      const { version } = store.commit({
        base: values.base ?? store.head(),
        readSet,
        change,
      });
      out({ version });
      break;
    }
    case 'route': {
      const { values } = parseArgs({
        args: rest,
        options: {
          ...STORE_OPT,
          from: { type: 'string' },
          to: { type: 'string' },
          capacity: { type: 'string' },
          version: { type: 'string' },
        },
      });
      if (!values.from || !values.to) {
        throw new RouteError('E_INVALID', 'route requires --from and --to');
      }
      const store = new Store(values.store);
      const { graph } = store.loadVersion(values.version ?? store.head());
      const capacity = values.capacity ? JSON.parse(values.capacity) : {};
      out(findRoute(graph, values.from, values.to, capacity));
      break;
    }
    case 'show': {
      const { values } = parseArgs({
        args: rest,
        options: { ...STORE_OPT, version: { type: 'string' } },
      });
      const store = new Store(values.store);
      const version = values.version ?? store.head();
      const res = store.decodeVersion(version);
      out({
        version,
        meta: res.meta,
        chunksRead: res.chunksRead,
        chunkCount: res.chunkCount,
        error: res.error,
        ...graphSummary(res.graph),
      });
      break;
    }
    case 'log': {
      const { values } = parseArgs({ args: rest, options: { ...STORE_OPT } });
      out({ versions: new Store(values.store).log() });
      break;
    }
    default:
      throw new RouteError(
        'E_INVALID',
        `unknown command: ${cmd ?? '(none)'}; expected init|commit|route|show|log`,
      );
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
