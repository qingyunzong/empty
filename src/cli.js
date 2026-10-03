import fs from 'node:fs';
import crypto from 'node:crypto';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check } from './types.js';
import { compile } from './compiler.js';
import { Ledger } from './ledger.js';
import { Wal } from './wal.js';
import { VM } from './vm.js';
import { RevError, E } from './errors.js';

const USAGE = `rev - reversal script runner

usage:
  rev run <plan.rvx> <ledger.json> --wal <wal.log> [--out <ledger.out.json>]
  rev recover --wal <wal.log> [--out <ledger.out.json>]
`;

function parseFlags(args) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else pos.push(args[i]);
  }
  return { pos, flags };
}

function readText(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new RevError(E.IO, `cannot read '${path}': ${err.message}`);
  }
}

function cmdRun(args) {
  const { pos, flags } = parseFlags(args);
  const [planPath, ledgerPath] = pos;
  const walPath = flags.wal;
  if (!planPath || !ledgerPath || !walPath) {
    process.stderr.write(USAGE);
    return 2;
  }
  const outPath = flags.out ?? ledgerPath;

  const info = Wal.inspect(walPath);
  if (info.exists) {
    if (info.committed) {
      console.log(`run already committed in ${walPath}; nothing to do (idempotent)`);
      return 0;
    }
    throw new RevError(E.IO, `wal '${walPath}' contains an incomplete run; run 'rev recover --wal ${walPath}' first`);
  }

  const planSrc = readText(planPath);
  const ledger = Ledger.load(ledgerPath);
  const program = parse(lex(planSrc));
  check(program);
  const code = compile(program);

  const wal = new Wal(walPath);
  wal.append({
    type: 'header',
    planHash: crypto.createHash('sha256').update(planSrc).digest('hex').slice(0, 16),
    plan: planSrc,
    ledgerPath: outPath,
    ledger: ledger.data,
    createdAt: new Date().toISOString(),
  });

  const vm = new VM({ code, ledger, wal });
  vm.run();
  wal.append({ type: 'commit', final: true, effects: vm.effectCount });
  ledger.save(outPath);
  console.log(`run: ${vm.effectCount} effect(s) committed; ledger -> ${outPath}`);
  return 0;
}

function cmdRecover(args) {
  const { flags } = parseFlags(args);
  const walPath = flags.wal;
  if (!walPath) {
    process.stderr.write(USAGE);
    return 2;
  }
  const info = Wal.inspect(walPath);
  if (!info.exists) throw new RevError(E.IO, `wal '${walPath}' not found`);
  if (!info.header) throw new RevError(E.IO, `wal '${walPath}' is missing its header record`);

  // Deterministic resume: re-execute the plan from the header snapshot.
  // Effects already durable in the WAL are replayed from their log records
  // (idempotent by effect key); execution then continues past the crash
  // point, so the final state equals a crash-free run.
  const logged = new Map();
  for (const rec of info.records) {
    if (rec.type !== 'effect') continue;
    const key = rec.reversalId ?? rec.moveId;
    if (!logged.has(key)) logged.set(key, rec);
  }
  const ledger = new Ledger(structuredClone(info.header.ledger));
  const program = parse(lex(info.header.plan));
  check(program);
  const code = compile(program);
  const wal = new Wal(walPath);
  wal.seq = info.records.length;
  const vm = new VM({ code, ledger, wal, replay: logged });
  vm.run();
  wal.append({ type: 'commit', final: true, effects: vm.effectCount, recovered: true });
  const outPath = flags.out ?? info.header.ledgerPath;
  ledger.save(outPath);
  console.log(`recover: replayed ${vm.replayedCount} logged effect(s), committed ${vm.effectCount} new; ledger -> ${outPath}`);
  return 0;
}

function dispatch(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'run') return cmdRun(rest);
  if (cmd === 'recover') return cmdRecover(rest);
  process.stderr.write(USAGE);
  return 2;
}

export function main(argv) {
  try {
    return dispatch(argv);
  } catch (err) {
    if (err instanceof RevError) {
      console.error(err.format());
      return 1;
    }
    throw err;
  }
}
