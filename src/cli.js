import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { LineageGraph, GraphError } from './graph.js';
import { parse } from './parser.js';
import { compile } from './compiler.js';
import { run } from './vm.js';
import { issueCertificate, verifyCertificate } from './cert.js';

export const EXIT_OK = 0;
export const EXIT_VERIFY_FAILED = 1;
export const EXIT_FORMAT_ERROR = 2;

class CliError extends Error {
  constructor(message, code = EXIT_FORMAT_ERROR) {
    super(message);
    this.code = code;
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new CliError(`${file}: error: ${e.message}`);
  }
}

function loadGraph(path) {
  if (!existsSync(path)) return new LineageGraph();
  let state;
  try {
    state = JSON.parse(readText(path));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`${path}: error: invalid graph state: ${e.message}`);
  }
  try {
    return LineageGraph.load(state);
  } catch (e) {
    throw new CliError(`${path}: error: invalid graph state: ${e.message}`);
  }
}

function cmdApply(args, io) {
  const file = args[0];
  if (!file) throw new CliError('usage: lineage apply <graph.jsonl> [--state state.json]');
  const statePath = flagValue(args, '--state') ?? 'state.json';
  const graph = loadGraph(statePath);

  let pending = null;
  let pendingLine = 0;
  const lines = readText(file).split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = lines[i].trim();
    if (text === '' || text.startsWith('#')) continue;
    let cmd;
    try {
      cmd = JSON.parse(text);
    } catch (e) {
      throw new CliError(`${file}:${lineNo}: error: invalid JSON: ${e.message}`);
    }
    const op = cmd?.op;
    try {
      if (op === 'begin') {
        if (pending) throw new GraphError('nested begin is not allowed');
        pending = [];
        pendingLine = lineNo;
      } else if (op === 'commit') {
        if (!pending) throw new GraphError('commit without begin');
        graph.applyTransaction(pending);
        pending = null;
      } else if (op === 'undo') {
        if (pending) throw new GraphError('undo inside a transaction is not allowed');
        graph.undo();
      } else if (op === 'redo') {
        if (pending) throw new GraphError('redo inside a transaction is not allowed');
        graph.redo();
      } else if (op === 'add' || op === 'link' || op === 'unlink') {
        if (pending) pending.push(cmd);
        else graph.applyTransaction([cmd]);
      } else {
        throw new GraphError(`unknown op ${JSON.stringify(op)}`);
      }
    } catch (e) {
      // State file is only written after the whole file succeeds: a failed
      // apply never produces partial writes.
      throw new CliError(`${file}:${lineNo}: error: ${e.message}`);
    }
  }
  if (pending) {
    throw new CliError(`${file}:${pendingLine}: error: transaction started but never committed`);
  }

  writeFileSync(statePath, JSON.stringify(graph.toJSON(), null, 2) + '\n');
  io.err(`applied: graph version ${graph.version} -> ${statePath}`);
  return EXIT_OK;
}

function cmdQuery(args, io) {
  const file = args[0];
  const graphPath = flagValue(args, '--graph');
  if (!file || !graphPath) {
    throw new CliError('usage: lineage query <q.dsl> --graph state.json [--cert cert.json]');
  }
  const certPath = flagValue(args, '--cert') ?? 'cert.json';
  const source = readText(file);

  let program;
  try {
    program = compile(parse(source));
  } catch (e) {
    throw new CliError(`${file}:${e.line ?? 0}: error: ${e.message}`);
  }

  const graph = loadGraph(graphPath);
  let results;
  try {
    results = run(program, graph);
  } catch (e) {
    throw new CliError(`${file}: error: ${e.message}`, EXIT_VERIFY_FAILED);
  }

  const cert = issueCertificate({ querySource: source, graph, results });
  writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
  io.out(JSON.stringify({
    graphVersion: graph.version,
    results: results.map((r) => ({ type: r.kind, nodes: r.ids })),
  }, null, 2));
  io.err(`certificate written to ${certPath}`);
  return EXIT_OK;
}

function cmdVerify(args, io) {
  const file = args[0];
  if (!file) throw new CliError('usage: lineage verify <cert.json>');
  let cert;
  try {
    cert = JSON.parse(readText(file));
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`${file}: error: ${e.message}`);
  }
  const { ok, errors } = verifyCertificate(cert);
  if (!ok) {
    for (const err of errors) io.err(`${file}: verification failed: ${err}`);
    return EXIT_VERIFY_FAILED;
  }
  io.out('OK');
  return EXIT_OK;
}

// main is pure with respect to IO so tests can capture streams in-process.
export function main(argv, io = {
  out: (msg) => process.stdout.write(msg + '\n'),
  err: (msg) => process.stderr.write(msg + '\n'),
}) {
  const [cmd, ...args] = argv;
  try {
    if (cmd === 'apply') return cmdApply(args, io);
    if (cmd === 'query') return cmdQuery(args, io);
    if (cmd === 'verify') return cmdVerify(args, io);
    io.err('usage: lineage <apply|query|verify> ...');
    return EXIT_FORMAT_ERROR;
  } catch (e) {
    if (e instanceof CliError) {
      io.err(e.message);
      return e.code;
    }
    throw e;
  }
}
