#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compilePlan,
  loadLedger,
  serializeLedger,
  balancesObject,
  VM,
  Wal,
  recoverWal,
  RevError,
  CrashFault,
} from '../src/index.js';

const RUNTIME_CODES = new Set(['E_STATE', 'E_LOCK', 'E_DUP', 'E_IO']);

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new RevError('E_IO', `flag --${key} requires a value`);
      }
      flags[key] = value;
      i += 1;
    } else {
      positionals.push(argv[i]);
    }
  }
  return { positionals, flags };
}

function readFileOrIo(filePath, what) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new RevError('E_IO', `cannot read ${what} ${filePath}: ${e.message}`);
  }
}

function writeLedger(outPath, ledger) {
  try {
    fs.writeFileSync(outPath, `${JSON.stringify(serializeLedger(ledger), null, 2)}\n`);
  } catch (e) {
    throw new RevError('E_IO', `cannot write output ledger ${outPath}: ${e.message}`);
  }
}

function defaultOut(ledgerPath) {
  return ledgerPath.replace(/\.json$/i, '') + '.out.json';
}

function crashAfterSeqFrom(env) {
  return env.REV_CRASH_AFTER_SEQ != null ? Number(env.REV_CRASH_AFTER_SEQ) : null;
}

function cmdRun(positionals, flags, env) {
  const [planPath, ledgerPath] = positionals;
  if (!planPath || !ledgerPath) {
    throw new RevError('E_IO', 'usage: rev run <plan.rvx> <ledger.json> --wal <wal.log> [--out <out.json>]');
  }
  if (!flags.wal) throw new RevError('E_IO', 'missing required --wal <path>');
  const walPath = flags.wal;
  if (fs.existsSync(walPath)) {
    throw new RevError('E_IO', `WAL ${walPath} already exists; use 'rev recover --wal ${walPath}' to resume`);
  }
  const source = readFileOrIo(planPath, 'plan');
  const ledgerText = readFileOrIo(ledgerPath, 'ledger');
  let ledgerJson;
  try {
    ledgerJson = JSON.parse(ledgerText);
  } catch (e) {
    throw new RevError('E_IO', `invalid ledger JSON in ${ledgerPath}: ${e.message}`);
  }
  const program = compilePlan(source);
  const ledger = loadLedger(ledgerJson);
  const out = flags.out ?? defaultOut(ledgerPath);
  const wal = Wal.create(walPath, {
    type: 'header',
    revId: program.revId,
    plan: path.resolve(planPath),
    ledger: path.resolve(ledgerPath),
    out: path.resolve(out),
  });
  let counts;
  try {
    const vm = new VM(program, ledger, wal, { crashAfterSeq: crashAfterSeqFrom(env) });
    counts = vm.run();
    wal.append({ type: 'done', counts });
  } finally {
    wal.close();
  }
  writeLedger(out, ledger);
  return {
    status: 'ok',
    revId: program.revId,
    counts,
    balances: balancesObject(ledger),
    out: path.resolve(out),
  };
}

function cmdRecover(positionals, flags, env) {
  if (!flags.wal) throw new RevError('E_IO', 'usage: rev recover --wal <wal.log> [--out <out.json>]');
  const { ledger, header, resumed, counts } = recoverWal(flags.wal, {
    crashAfterSeq: crashAfterSeqFrom(env),
  });
  const out = flags.out ?? header.out;
  if (!out) throw new RevError('E_IO', 'no output path: pass --out or record one in the WAL header');
  writeLedger(out, ledger);
  return {
    status: 'ok',
    revId: header.revId,
    resumed,
    counts,
    balances: balancesObject(ledger),
    out: path.resolve(out),
  };
}

// Returns { code, stdout, stderr } so tests can drive the CLI in-process.
export function runCli(argv, env = {}) {
  try {
    const [cmd, ...rest] = argv;
    const { positionals, flags } = parseFlags(rest);
    let report;
    if (cmd === 'run') report = cmdRun(positionals, flags, env);
    else if (cmd === 'recover') report = cmdRecover(positionals, flags, env);
    else throw new RevError('E_IO', 'usage: rev <run|recover> ... (see README.md)');
    return { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' };
  } catch (err) {
    if (err instanceof CrashFault) {
      return {
        code: 3,
        stdout: '',
        stderr: `${JSON.stringify({ error: { code: err.code, message: err.message, txnId: null, pc: null } })}\n`,
      };
    }
    if (err instanceof RevError) {
      return {
        code: RUNTIME_CODES.has(err.code) ? 1 : 2,
        stdout: '',
        stderr: `${JSON.stringify({ error: err.toJSON() })}\n`,
      };
    }
    return {
      code: 2,
      stdout: '',
      stderr: `${JSON.stringify({ error: { code: 'E_INTERNAL', message: String(err && err.stack ? err.stack : err) } })}\n`,
    };
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2), process.env);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
