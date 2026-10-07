#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildGraph,
  proveReach,
  proveNonreach,
  verify,
  firstContamination,
  VERDICT,
} from './src/index.js';

const DEFAULT_DIR = '.audit';
const GRAPH_FILE = 'graph.json';

function fail(message, code = 1) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function readJsonArg(value, what) {
  if (value === undefined) fail(`missing --${what}`);
  if (existsSync(value)) {
    try {
      return JSON.parse(readFileSync(value, 'utf8'));
    } catch {
      fail(`cannot parse JSON file for --${what}: ${value}`);
    }
  }
  try {
    return JSON.parse(value);
  } catch {
    fail(`--${what} is neither an existing file nor valid JSON`);
  }
}

function loadGraph(dir) {
  const file = join(dir, GRAPH_FILE);
  if (!existsSync(file)) fail(`no built graph at ${file}; run "build" first`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  return buildGraph(raw.nodes, raw.edges);
}

function proveError(err) {
  // Never collapse PROVE_TIMEOUT into NO_PATH.
  if (err.code === 'NO_SUCH_NODE') fail(err.message, 4);
  if (err.code === 'NO_PATH') fail('NO_PATH', 2);
  if (err.code === 'PATH_EXISTS') fail('PATH_EXISTS', 2);
  if (err.code === 'PROVE_TIMEOUT') fail('PROVE_TIMEOUT', 3);
  throw err;
}

const [command, ...rest] = process.argv.slice(2);

const common = {
  dir: { type: 'string', default: DEFAULT_DIR },
  'max-steps': { type: 'string', default: String(10_000_000) },
};

let args;
try {
  switch (command) {
    case 'build':
      args = parseArgs({
        args: rest,
        options: { ...common, nodes: { type: 'string' }, edges: { type: 'string' } },
      });
      break;
    case 'prove_reach':
    case 'prove_nonreach':
      args = parseArgs({
        args: rest,
        options: { ...common, s: { type: 'string' }, t: { type: 'string' }, out: { type: 'string' } },
      });
      break;
    case 'verify':
      args = parseArgs({ args: rest, options: { ...common, proof: { type: 'string' } } });
      break;
    case 'contaminate':
      args = parseArgs({
        args: rest,
        options: { ...common, sources: { type: 'string' }, t: { type: 'string' } },
      });
      break;
    default:
      fail(
        'usage: cli.js <build|prove_reach|prove_nonreach|verify|contaminate> [options]'
      );
  }
} catch (err) {
  fail(err.message);
}

const maxSteps = Number(args.values['max-steps']);
if (!Number.isInteger(maxSteps) || maxSteps <= 0) fail('--max-steps must be a positive integer');

switch (command) {
  case 'build': {
    const nodes = readJsonArg(args.values.nodes, 'nodes');
    const edges = readJsonArg(args.values.edges, 'edges');
    let graph;
    try {
      graph = buildGraph(nodes, edges);
    } catch (err) {
      proveError(err);
    }
    mkdirSync(args.values.dir, { recursive: true });
    const file = join(args.values.dir, GRAPH_FILE);
    writeFileSync(
      file,
      JSON.stringify({ nodes: graph.nodes, edges: graph.edges, version: graph.version }, null, 2) + '\n'
    );
    process.stdout.write(
      JSON.stringify({ version: graph.version, nodes: graph.nodes.length, edges: graph.edges.length, file }) + '\n'
    );
    break;
  }
  case 'prove_reach':
  case 'prove_nonreach': {
    const { s, t, out } = args.values;
    if (s === undefined || t === undefined) fail('missing --s or --t');
    const graph = loadGraph(args.values.dir);
    let proof;
    try {
      proof = command === 'prove_reach' ? proveReach(graph, s, t, maxSteps) : proveNonreach(graph, s, t, maxSteps);
    } catch (err) {
      proveError(err);
    }
    const json = JSON.stringify(proof, null, 2) + '\n';
    if (out) {
      writeFileSync(out, json);
      process.stdout.write(JSON.stringify({ proofId: proof.proofId, out }) + '\n');
    } else {
      process.stdout.write(json);
    }
    break;
  }
  case 'verify': {
    const proof = readJsonArg(args.values.proof, 'proof');
    const graph = loadGraph(args.values.dir);
    const verdict = verify(graph, proof, maxSteps);
    process.stdout.write(verdict + '\n');
    process.exit(verdict === VERDICT.VALID ? 0 : 1);
  }
  case 'contaminate': {
    const { sources, t } = args.values;
    if (sources === undefined || t === undefined) fail('missing --sources or --t');
    const graph = loadGraph(args.values.dir);
    let result;
    try {
      result = firstContamination(graph, sources.split(',').map((x) => x.trim()).filter(Boolean), t, maxSteps);
    } catch (err) {
      proveError(err);
    }
    if (result === null) fail('NO_PATH', 2);
    process.stdout.write(JSON.stringify(result) + '\n');
    break;
  }
}
