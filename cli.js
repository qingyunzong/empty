#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parse } from './src/parser.js';
import {
  buildProgram,
  visibleTables,
  resolve,
  deepestScope,
} from './src/scope.js';
import { SnapshotStore } from './src/snapshot.js';

const USAGE = `usage:
  node cli.js parse <file.dsl> [--store store.json]
  node cli.js resolve <file.dsl | store.json@version> <name> [--in outer/inner]
  node cli.js correct <store.json> <version> <name> <expr>`;

function printTables(out, tables, version) {
  if (version !== undefined) out(`snapshot v${version}`);
  for (const t of tables) {
    out(`scope ${t.scopeName} (path: ${t.path.join(' / ')})`);
    for (const b of t.bindings) {
      const value = typeof b.value === 'string' ? JSON.stringify(b.value) : b.value;
      out(`  ${b.name} = ${value}  [${b.kind}, defined in ${b.definedIn}]`);
    }
  }
}

function loadStore(path) {
  if (!existsSync(path)) return new SnapshotStore();
  return SnapshotStore.fromJSON(JSON.parse(readFileSync(path, 'utf8')));
}

function saveStore(path, store) {
  writeFileSync(path, JSON.stringify(store.toJSON(), null, 2) + '\n');
}

function buildFromFile(file) {
  return buildProgram(parse(readFileSync(file, 'utf8')));
}

function cmdParse(out, args) {
  const file = args[0];
  if (!file) throw new Error('parse: missing <file.dsl>');
  const storeIdx = args.indexOf('--store');
  const storePath = storeIdx >= 0 ? args[storeIdx + 1] : null;
  const root = buildFromFile(file);
  let version;
  if (storePath) {
    const store = loadStore(storePath);
    version = store.commit(root);
    saveStore(storePath, store);
  }
  printTables(out, visibleTables(root), version);
}

function cmdResolve(out, args) {
  const target = args[0];
  const name = args[1];
  if (!target || !name) throw new Error('resolve: missing <target> or <name>');
  const inIdx = args.indexOf('--in');
  const inPath = inIdx >= 0 ? args[inIdx + 1] : null;

  let root;
  const at = target.lastIndexOf('@');
  if (at > 0 && /^\d+$/.test(target.slice(at + 1))) {
    const store = loadStore(target.slice(0, at));
    root = store.materialize(Number(target.slice(at + 1)));
  } else {
    root = buildFromFile(target);
  }

  let start = deepestScope(root);
  if (inPath) {
    start = root;
    for (const seg of inPath.split('/')) {
      const next = start.children.find((c) => c.name === seg);
      if (!next) throw new Error(`no experiment '${seg}' under '${start.name}'`);
      start = next;
    }
  }

  const result = resolve(root, start.id, name);
  const value = typeof result.value === 'string' ? JSON.stringify(result.value) : result.value;
  out(`${result.name} = ${value}  [${result.kind}, defined in ${result.definedIn}]`);
  out('scope chain (innermost first):');
  for (const scopeName of result.chain) {
    const marker = scopeName === result.definedIn ? '  <-- resolved here' : '';
    out(`  ${scopeName}${marker}`);
  }
}

function cmdCorrect(out, args) {
  const [storePath, versionStr, name, ...exprParts] = args;
  if (!storePath || !versionStr || !name || exprParts.length === 0) {
    throw new Error('correct: expected <store.json> <version> <name> <expr>');
  }
  const store = loadStore(storePath);
  const newVersion = store.correct(Number(versionStr), name, exprParts.join(' '));
  saveStore(storePath, store);
  printTables(out, visibleTables(store.materialize(newVersion)), newVersion);
}

// In-process entry point: returns { code, stdout, stderr }.
export function run(argv) {
  const lines = [];
  const out = (s) => lines.push(s);
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'parse': cmdParse(out, args); break;
      case 'resolve': cmdResolve(out, args); break;
      case 'correct': cmdCorrect(out, args); break;
      default:
        return { code: 1, stdout: lines.join('\n'), stderr: USAGE };
    }
    return { code: 0, stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: '' };
  } catch (err) {
    return { code: 1, stdout: lines.join('\n'), stderr: `error: ${err.message}` };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr + '\n');
  process.exitCode = result.code;
}
