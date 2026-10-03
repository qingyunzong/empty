#!/usr/bin/env node
import fs from 'node:fs';
import { PositionalIndex, Forest, StateStore, undo, UndoError, ERR } from '../src/lib.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(arg);
    }
  }
  return args;
}

function requireArg(args, key) {
  if (args[key] === undefined || args[key] === true) {
    throw new UndoError(ERR.BAD_REQUEST, `missing required argument --${key}`);
  }
  return args[key];
}

function readNodes(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = Array.isArray(data) ? data : data.nodes;
  if (!Array.isArray(nodes)) {
    throw new UndoError(ERR.BAD_REQUEST, 'data file must be a JSON array or { "nodes": [...] }');
  }
  return nodes;
}

function parseTerms(raw) {
  const terms = String(raw).trim().split(/\s+/);
  if (terms.length !== 2) {
    throw new UndoError(ERR.BAD_REQUEST, `--terms must contain exactly two terms, got: ${raw}`);
  }
  return terms;
}

function parseNumber(raw, name) {
  const value = Number(raw);
  if (raw === undefined || Number.isNaN(value)) {
    throw new UndoError(ERR.BAD_REQUEST, `--${name} must be a number, got: ${raw}`);
  }
  return value;
}

function cmdQuery(args) {
  const nodes = readNodes(requireArg(args, 'data'));
  const rootId = requireArg(args, 'root');
  const terms = parseTerms(requireArg(args, 'terms'));
  const slop = parseNumber(args.slop ?? '0', 'slop');
  const forest = new Forest(nodes);
  if (!forest.nodes.has(rootId)) {
    throw new UndoError(ERR.ROOT_NOT_FOUND, `root node not found: ${rootId}`, { rootId });
  }
  forest.assertAcyclicChain(rootId);
  const subtree = forest.collectSubtree(rootId);
  for (const id of subtree) forest.assertAcyclicChain(id);
  const index = PositionalIndex.fromNodes(subtree.map((id) => forest.nodes.get(id)));
  const hits = index.near(terms[0], terms[1], slop);
  return {
    rootId,
    terms,
    slop,
    hits: [...hits.keys()].sort().map((id) => ({ id, positions: hits.get(id) })),
  };
}

function cmdUndo(args) {
  const nodes = readNodes(requireArg(args, 'data'));
  const store = new StateStore(requireArg(args, 'state-dir'));
  return undo(store, nodes, {
    rootId: requireArg(args, 'root'),
    terms: parseTerms(requireArg(args, 'terms')),
    slop: parseNumber(args.slop ?? '0', 'slop'),
    budget: parseNumber(requireArg(args, 'budget'), 'budget'),
  });
}

function cmdStatus(args) {
  const store = new StateStore(requireArg(args, 'state-dir'));
  return store.load();
}

const USAGE = `usage:
  txundo query  --data <file> --root <id> --terms "a b" [--slop n]
  txundo undo   --data <file> --root <id> --terms "a b" [--slop n] --budget n --state-dir <dir>
  txundo status --state-dir <dir>`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  let result;
  switch (command) {
    case 'query':
      result = cmdQuery(args);
      break;
    case 'undo':
      result = cmdUndo(args);
      break;
    case 'status':
      result = cmdStatus(args);
      break;
    default:
      throw new UndoError(ERR.BAD_REQUEST, USAGE);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

try {
  main();
} catch (err) {
  const payload = err instanceof UndoError
    ? { code: err.code, message: err.message, details: err.details ?? null }
    : { code: 'INTERNAL', message: String(err && err.message ? err.message : err), details: null };
  process.stderr.write(`${JSON.stringify({ error: payload })}\n`);
  process.exitCode = 1;
}
