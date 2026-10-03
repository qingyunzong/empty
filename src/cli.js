#!/usr/bin/env node
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeInstruction } from './quantize.js';
import { OvenStore } from './store.js';
import {
  OvenError,
  E_CONFIG,
  E_RATIONAL,
  E_AMBIGUOUS,
  E_STATE,
} from './errors.js';

const EXIT_CODES = {
  [E_CONFIG]: 2,
  [E_RATIONAL]: 3,
  [E_AMBIGUOUS]: 4,
  [E_STATE]: 5,
};

const USAGE = `oven - exact rational oven temperature control

Usage:
  oven eval --coeffs "c0,c1,..." --lo L --hi H -k K   one-shot instruction
  oven eval --lo L --hi H -k K [--state FILE]         use active revision
  oven init --coeffs "c0,c1,..." [--state FILE]       create revision store
  oven begin|commit|rollback|undo|redo [--state FILE]
  oven stage --coeffs "c0,c1,..." [--state FILE]
  oven show [--state FILE]

Coefficients and bounds are exact rationals: "3", "-2", "3/4". No floats.
k is the quantization exponent (instruction quantum is 10^-k), k >= 0.
State file defaults to $OVEN_STATE or ./oven-state.json.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-k') {
      args.k = argv[++i];
    } else if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function parseCoeffs(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new OvenError(E_CONFIG, 'E_CONFIG: --coeffs must be a comma-separated list');
  }
  return text.split(',').map((s) => s.trim());
}

function parseK(raw) {
  if (raw === undefined) {
    throw new OvenError(E_CONFIG, 'E_CONFIG: missing -k quantization exponent');
  }
  if (!/^[+-]?\d+$/.test(String(raw).trim())) {
    throw new OvenError(E_CONFIG, `E_CONFIG: k must be an integer, got "${raw}"`);
  }
  return Number.parseInt(raw, 10);
}

function statePath(args) {
  return typeof args.state === 'string' ? args.state : process.env.OVEN_STATE || './oven-state.json';
}

function loadStore(args) {
  const path = statePath(args);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new OvenError(E_STATE, `E_STATE: cannot read state file ${path}; run "oven init" first`);
  }
  return OvenStore.fromJSON(JSON.parse(raw));
}

function saveStore(args, store, extra = {}) {
  const data = { ...store.toJSON(), ...extra };
  writeFileSync(statePath(args), JSON.stringify(data, null, 2) + '\n');
}

function instructionToJSON(result) {
  return {
    ok: true,
    interval: { min: result.interval.min.toString(), max: result.interval.max.toString() },
    argMin: result.argMin.toString(),
    argMax: result.argMax.toString(),
    k: result.k,
    quantum: result.quantum.toString(),
    quantized: result.quantized.toString(),
    errorBound: result.errorBound.toString(),
  };
}

function dispatch(args) {
  const command = args._[0];
  switch (command) {
    case 'eval': {
      const k = parseK(args.k);
      if (args.lo === undefined || args.hi === undefined) {
        throw new OvenError(E_CONFIG, 'E_CONFIG: eval requires --lo and --hi');
      }
      let result;
      if (args.coeffs !== undefined) {
        result = computeInstruction(parseCoeffs(args.coeffs), args.lo, args.hi, k);
      } else {
        result = loadStore(args).instruction(args.lo, args.hi, k);
      }
      return instructionToJSON(result);
    }
    case 'init': {
      const store = new OvenStore(parseCoeffs(args.coeffs ?? '0'));
      saveStore(args, store);
      return { ok: true, active: store.activeCoefficients(), index: store.index };
    }
    case 'begin': {
      const store = loadStore(args);
      store.begin();
      saveStore(args, store);
      return { ok: true, transaction: 'open' };
    }
    case 'stage': {
      const store = loadStore(args);
      store.begin();
      store.stage(parseCoeffs(args.coeffs));
      // Persist the open transaction so a later commit (possibly in another
      // process) can validate and apply it atomically.
      saveStore(args, store, { pending: store._tx.staged });
      return { ok: true, staged: store._tx.staged };
    }
    case 'commit': {
      const path = statePath(args);
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const store = OvenStore.fromJSON(data);
      if (data.pending !== undefined) {
        store.begin();
        store.stage(data.pending);
      }
      const active = store.commit(); // throws on illegal transaction; file untouched
      saveStore(args, store);
      return { ok: true, active, index: store.index };
    }
    case 'rollback': {
      const store = loadStore(args);
      store.rollback();
      saveStore(args, store);
      return { ok: true, transaction: 'discarded' };
    }
    case 'undo': {
      const store = loadStore(args);
      const active = store.undo();
      saveStore(args, store);
      return { ok: true, active, index: store.index };
    }
    case 'redo': {
      const store = loadStore(args);
      const active = store.redo();
      saveStore(args, store);
      return { ok: true, active, index: store.index };
    }
    case 'show': {
      const store = loadStore(args);
      return {
        ok: true,
        active: store.activeCoefficients(),
        index: store.index,
        depth: store.depth,
        canUndo: store.canUndo(),
        canRedo: store.canRedo(),
      };
    }
    default:
      throw new OvenError(E_CONFIG, `E_CONFIG: unknown command "${command ?? ''}"\n${USAGE}`);
  }
}

// Runs one CLI invocation in-process; returns { code, stdout, stderr }.
export function runCli(argv) {
  const args = parseArgs(argv);
  const command = args._[0];
  try {
    if (!command || args.help === true) {
      return { code: command ? 0 : 1, stdout: USAGE + '\n', stderr: '' };
    }
    const out = dispatch(args);
    return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
  } catch (err) {
    const code = err instanceof OvenError ? err.code : 'E_INTERNAL';
    const stderr = JSON.stringify({ ok: false, error: code, message: err.message }) + '\n';
    return { code: EXIT_CODES[code] ?? 1, stdout: '', stderr };
  }
}

const invokedAsScript =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  const result = runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
