#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  createSnapshot,
  resolve,
  correct,
  visibleBindings,
  exprToString,
} from './src/index.js';

const USAGE = `usage:
  node cli.js parse <file.dsl> [--scope a.b.c]
  node cli.js resolve <file.dsl> <name> [--scope a.b.c]
  node cli.js correct <file.dsl> <name> <expr> [--scope a.b.c]`;

function parseFlags(args) {
  const positional = [];
  let scope = 'root';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--scope') {
      scope = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, scope };
}

function snapshotToJson(snapshot) {
  const scopes = [];
  for (const [path, scope] of snapshot.scopes) {
    scopes.push({
      path,
      bindings: [...scope.bindings.values()].map((b) => ({ name: b.name, expr: exprToString(b.expr) })),
      children: scope.children,
    });
  }
  return { version: snapshot.version, parentVersion: snapshot.parentVersion, scopes };
}

function visibleToJson(snapshot, scopePath) {
  const table = {};
  for (const [name, entry] of visibleBindings(snapshot, scopePath)) {
    table[name] = { value: entry.value, definedIn: entry.definedIn };
  }
  return table;
}

// Returns the process exit code; output goes to the injected writers.
export function run(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  try {
    const [cmd, ...rest] = argv;
    const { positional, scope } = parseFlags(rest);

    if (cmd === 'parse') {
      const [file] = positional;
      const snapshot = createSnapshot(readFileSync(file, 'utf8'));
      const out = snapshotToJson(snapshot);
      out.visible = visibleToJson(snapshot, scope);
      io.out(JSON.stringify(out, null, 2));
      return 0;
    }

    if (cmd === 'resolve') {
      const [file, name] = positional;
      const snapshot = createSnapshot(readFileSync(file, 'utf8'));
      io.out(JSON.stringify(resolve(snapshot, name, scope), null, 2));
      return 0;
    }

    if (cmd === 'correct') {
      const [file, name, expr] = positional;
      const parent = createSnapshot(readFileSync(file, 'utf8'));
      const child = correct(parent, name, expr, scope);
      io.out(JSON.stringify({
        parentVersion: child.parentVersion,
        version: child.version,
        corrected: resolve(child, name, scope),
        visible: visibleToJson(child, scope),
        parentVisible: visibleToJson(parent, scope),
      }, null, 2));
      return 0;
    }

    io.err(USAGE);
    return 2;
  } catch (err) {
    io.err(`error: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = run(process.argv.slice(2));
}
