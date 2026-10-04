import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GateError } from './errors.js';
import { Engine } from './engine.js';

const USAGE = `gate - quality gating for observations before network admission

usage:
  gate init <rules.json> [--force]   validate rules and initialize .gate/
  gate obs <observations.jsonl>      ingest observations (one JSON object per line)
  gate correct <key> <patch-json>    apply correction patch, re-decide, print certificate
  gate decide <key>                  decide admission for an observation, print certificate
  gate replay <from> <to>            full recompute of decisions for time range (ms epoch or ISO 8601)

environment:
  GATE_DIR   state directory (default: ./.gate)

exit codes:
  0  success / decision pass
  1  error (E_RULE, E_WINDOW, E_EXEMPT, E_OBS, usage)
  2  decision fail (violation)
  3  decision undecided (automatic admission blocked, not a violation)
`;

const defaultIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
};

function parseTime(arg, name) {
  if (/^-?\d+$/.test(arg)) return Number(arg);
  const parsed = Date.parse(arg);
  if (Number.isNaN(parsed)) throw new GateError('E_WINDOW', `${name}: unparseable time: ${arg}`);
  return parsed;
}

function printCertAndExit(cert, io) {
  io.out(`${JSON.stringify(cert, null, 2)}\n`);
  if (cert.decision === 'undecided') {
    io.err(`E_UNDECIDED_BLOCK: decision for ${cert.key} is undecided; automatic admission blocked (not counted as violation)\n`);
    return 3;
  }
  if (cert.decision === 'fail') return 2;
  return 0;
}

export function run(argv, io) {
  const [cmd, ...args] = argv;
  const dir = io.env.GATE_DIR ?? join(process.cwd(), '.gate');

  switch (cmd) {
    case 'init': {
      const [rulesPath, ...flags] = args;
      if (!rulesPath) throw new GateError('E_USAGE', 'init requires <rules.json>');
      const rules = JSON.parse(readFileSync(rulesPath, 'utf8'));
      Engine.init(dir, rules, { force: flags.includes('--force') });
      io.out(`${JSON.stringify({ initialized: dir, rules: (rules.rules ?? []).length })}\n`);
      return 0;
    }
    case 'obs': {
      const [file] = args;
      if (!file) throw new GateError('E_USAGE', 'obs requires <observations.jsonl>');
      const engine = new Engine(dir);
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      const obsList = lines.map((line, i) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new GateError('E_OBS', `${file}:${i + 1}: invalid JSON`);
        }
      });
      const n = engine.ingest(obsList);
      io.out(`${JSON.stringify({ ingested: n })}\n`);
      return 0;
    }
    case 'correct': {
      const [key, patchArg] = args;
      if (!key || !patchArg) throw new GateError('E_USAGE', 'correct requires <key> <patch-json>');
      const patch = JSON.parse(patchArg.startsWith('@') ? readFileSync(patchArg.slice(1), 'utf8') : patchArg);
      const engine = new Engine(dir);
      return printCertAndExit(engine.correct(key, patch), io);
    }
    case 'decide': {
      const [key] = args;
      if (!key) throw new GateError('E_USAGE', 'decide requires <key>');
      const engine = new Engine(dir);
      return printCertAndExit(engine.decide(key), io);
    }
    case 'replay': {
      const [fromArg, toArg] = args;
      if (!fromArg || !toArg) throw new GateError('E_USAGE', 'replay requires <from> <to>');
      const engine = new Engine(dir);
      const certs = engine.replay(parseTime(fromArg, 'from'), parseTime(toArg, 'to'));
      for (const cert of certs) io.out(`${JSON.stringify(cert)}\n`);
      io.err(`replayed ${certs.length} decision(s) in [${fromArg}, ${toArg}]\n`);
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      io.out(USAGE);
      return cmd === undefined ? 1 : 0;
    default:
      throw new GateError('E_USAGE', `unknown command: ${cmd}\n${USAGE}`);
  }
}

// main never throws for expected errors; it maps them to exit codes.
export function main(argv, io = defaultIo) {
  try {
    return run(argv, io);
  } catch (err) {
    if (err instanceof GateError) {
      io.err(`${err.code}: ${err.message}\n`);
    } else {
      io.err(`E_INTERNAL: ${err.stack ?? err.message}\n`);
    }
    return 1;
  }
}
