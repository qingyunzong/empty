// CLI machinery for repro-dag, importable for in-process testing.
// bin/repro-dag.js is a thin wrapper around cliMain.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  createStore, serialize, deserialize,
  add, run, invalidate, audit, gc, tombstone, registerRunner,
  DagError,
} from './dag.js';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { command, state: 'repro-dag-state.json', file: null };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--state') opts.state = rest[++i];
    else if (rest[i] === '--file') opts.file = rest[++i];
    else throw new DagError('MISSING_INPUT', `unknown argument: ${rest[i]}`);
  }
  return opts;
}

// io: { readStdin(): string, writeOut(s), writeErr(s) }
export function cliMain(argv, io) {
  try {
    const opts = parseArgs(argv);
    if (!opts.command) {
      throw new DagError('MISSING_INPUT',
        'usage: repro-dag <add|run|invalidate|audit|gc|tombstone|register-runner> [--state P] [--file F]');
    }
    const readInput = () => {
      const text = opts.file ? readFileSync(opts.file, 'utf8') : io.readStdin();
      return text.trim() ? JSON.parse(text) : {};
    };
    const store = existsSync(opts.state)
      ? deserialize(readFileSync(opts.state, 'utf8'))
      : createStore();

    let out;
    let mutates = true;
    switch (opts.command) {
      case 'add': out = add(store, readInput()); break;
      case 'run': out = run(store, readInput().targets ?? []); break;
      case 'invalidate': out = invalidate(store, readInput()); break;
      case 'audit': out = audit(store); mutates = false; break;
      case 'gc': out = gc(store, readInput().confirmations ?? {}); break;
      case 'tombstone': out = tombstone(store, readInput().id); break;
      case 'register-runner': out = registerRunner(store, readInput().id); break;
      default:
        throw new DagError('MISSING_INPUT', `unknown command: ${opts.command}`);
    }
    if (mutates) writeFileSync(opts.state, serialize(store));
    io.writeOut(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (err) {
    const code = err instanceof DagError ? err.code : 'INTERNAL';
    io.writeErr(`${JSON.stringify({ error: { code, message: err.message } })}\n`);
    return 1;
  }
}
