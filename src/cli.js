#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LineageGraph } from './graph.js';
import { parseSource } from './parser.js';
import { compile } from './compiler.js';
import { execute } from './vm.js';
import { verifyCertificate } from './cert.js';
import { EDGE_TYPES, LOT_PATTERN, validateAttrs } from './schema.js';

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_FORMAT = 2;

class CliExit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function defaultIo() {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function die(io, message, code) {
  io.stderr(message.replace(/\n?$/, '\n'));
  throw new CliExit(code);
}

function usage(io) {
  die(
    io,
    [
      'usage:',
      '  lineage apply <graph.jsonl> [--out state.json]',
      '  lineage query <q.dsl> --graph <state.json>',
      '  lineage verify <cert.json> [--graph <state.json>]',
    ].join('\n'),
    EXIT_FORMAT,
  );
}

function readText(io, file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    die(io, `error: cannot read '${file}'`, EXIT_FORMAT);
  }
}

function readJson(io, file) {
  const text = readText(io, file);
  try {
    return JSON.parse(text);
  } catch (err) {
    die(io, `${file}: invalid JSON: ${err.message}`, EXIT_FORMAT);
  }
}

function splitArgs(io, argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '--graph') {
      if (i + 1 >= argv.length) die(io, `error: ${arg} requires a value`, EXIT_FORMAT);
      options[arg.slice(2)] = argv[++i];
    } else if (arg.startsWith('--')) {
      die(io, `error: unknown option '${arg}'`, EXIT_FORMAT);
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function validateCommandShape(io, file, lineNo, obj) {
  const bad = (msg) => die(io, `${file}:${lineNo}: ${msg}`, EXIT_FORMAT);
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) bad('command must be a JSON object');
  if (typeof obj.op !== 'string') bad("command requires an 'op' string");
  switch (obj.op) {
    case 'add': {
      if (typeof obj.id !== 'string' || !LOT_PATTERN.test(obj.id)) {
        bad("'add' requires a valid lot 'id' (e.g. LOT-2025-0001)");
      }
      const err = validateAttrs(obj.attrs);
      if (err) bad(err);
      break;
    }
    case 'link':
    case 'unlink': {
      for (const key of ['from', 'to']) {
        if (typeof obj[key] !== 'string' || !LOT_PATTERN.test(obj[key])) {
          bad(`'${obj.op}' requires valid lot ids in 'from' and 'to'`);
        }
      }
      if (obj.edge !== undefined && !EDGE_TYPES.includes(obj.edge)) {
        bad(`unknown edge type '${obj.edge}'`);
      }
      break;
    }
    case 'begin':
    case 'commit':
    case 'undo':
    case 'redo':
      break;
    default:
      bad(`unknown op '${obj.op}'`);
  }
}

function cmdApply(io, file, out) {
  const text = readText(io, file);
  const graph = new LineageGraph();
  let inTxn = false;
  let buffer = [];
  let beginLine = 0;

  const lines = text.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx].trim();
    if (!raw) continue;
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (err) {
      die(io, `${file}:${lineNo}: invalid JSON: ${err.message}`, EXIT_FORMAT);
    }
    validateCommandShape(io, file, lineNo, obj);
    if (obj.op === 'begin') {
      if (inTxn) die(io, `${file}:${lineNo}: nested 'begin'`, EXIT_FORMAT);
      inTxn = true;
      buffer = [];
      beginLine = lineNo;
      continue;
    }
    if (obj.op === 'commit') {
      if (!inTxn) die(io, `${file}:${lineNo}: 'commit' without 'begin'`, EXIT_FORMAT);
      try {
        graph.applyTransaction(buffer);
      } catch (err) {
        die(io, `${file}:${lineNo}: transaction failed: ${err.message}`, EXIT_FAIL);
      }
      inTxn = false;
      continue;
    }
    if (obj.op === 'undo' || obj.op === 'redo') {
      if (inTxn) die(io, `${file}:${lineNo}: '${obj.op}' is not allowed inside a transaction`, EXIT_FORMAT);
      try {
        if (obj.op === 'undo') graph.undo();
        else graph.redo();
      } catch (err) {
        die(io, `${file}:${lineNo}: ${err.message}`, EXIT_FAIL);
      }
      continue;
    }
    if (inTxn) {
      buffer.push(obj);
      continue;
    }
    try {
      graph.applyTransaction([obj]);
    } catch (err) {
      die(io, `${file}:${lineNo}: ${err.message}`, EXIT_FAIL);
    }
  }
  if (inTxn) die(io, `${file}:${beginLine}: unterminated transaction (missing 'commit')`, EXIT_FORMAT);

  const output = JSON.stringify(graph.toJSON(), null, 2) + '\n';
  if (out) writeFileSync(out, output);
  else io.stdout(output);
}

function cmdQuery(io, file, graphFile) {
  if (!graphFile) die(io, 'error: query requires --graph <state.json>', EXIT_FORMAT);
  const source = readText(io, file);
  let compiled;
  try {
    compiled = compile(parseSource(source));
  } catch (err) {
    const where = err.line !== undefined ? `${file}:${err.line}` : file;
    die(io, `${where}: ${err.message}`, EXIT_FORMAT);
  }
  const state = readJson(io, graphFile);
  let graph;
  try {
    graph = LineageGraph.fromJSON(state);
  } catch (err) {
    die(io, `${graphFile}: ${err.message}`, EXIT_FORMAT);
  }
  let output;
  try {
    output = execute(compiled, graph, source);
  } catch (err) {
    die(io, `${file}: ${err.message}`, EXIT_FAIL);
  }
  io.stdout(JSON.stringify(output, null, 2) + '\n');
}

function cmdVerify(io, file, graphFile) {
  const certObj = readJson(io, file);
  let state;
  if (graphFile) state = readJson(io, graphFile);
  const certs =
    certObj !== null && typeof certObj === 'object' && Array.isArray(certObj.certificates)
      ? certObj.certificates
      : [certObj];
  let allOk = true;
  certs.forEach((cert, index) => {
    const { ok, errors } = verifyCertificate(cert, state);
    if (ok) {
      io.stdout(`certificate ${index}: OK\n`);
    } else {
      allOk = false;
      for (const err of errors) {
        io.stderr(`${file}: certificate ${index}: ${err}\n`);
      }
    }
  });
  if (!allOk) throw new CliExit(EXIT_FAIL);
}

export function main(argv, io = defaultIo()) {
  try {
    const [cmd, ...rest] = argv;
    const { positional, options } = splitArgs(io, rest);
    switch (cmd) {
      case 'apply':
        if (positional.length !== 1) usage(io);
        cmdApply(io, positional[0], options.out);
        break;
      case 'query':
        if (positional.length !== 1) usage(io);
        cmdQuery(io, positional[0], options.graph);
        break;
      case 'verify':
        if (positional.length !== 1) usage(io);
        cmdVerify(io, positional[0], options.graph);
        break;
      default:
        usage(io);
    }
    return EXIT_OK;
  } catch (err) {
    if (err instanceof CliExit) return err.code;
    throw err;
  }
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
