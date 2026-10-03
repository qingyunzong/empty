#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Ledger, LedgerError, recordView } from './ledger.js';
import { buildCertificate, writeCertificate, certificateStatus } from './certificate.js';

const EXIT_ERROR = 3;

function parseArgs(argv) {
  const args = { stateDir: null, inputFile: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') {
      args.stateDir = argv[++i];
    } else if (!argv[i].startsWith('--') && args.inputFile === null) {
      args.inputFile = argv[i];
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function balancesObject(ledger) {
  const obj = {};
  for (const [account, amount] of [...ledger.balances.entries()].sort()) {
    obj[account] = amount;
  }
  return obj;
}

async function readInputLines(inputFile) {
  const stream = inputFile ? fs.createReadStream(inputFile, 'utf8') : process.stdin;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: 'BAD_ARGS', message: err.message }) + '\n');
    process.exit(EXIT_ERROR);
  }

  const logPath = args.stateDir ? path.join(args.stateDir, 'log.jsonl') : null;
  let ledger = new Ledger();
  let chainBroken = null;
  if (logPath && fs.existsSync(logPath)) {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    ledger = Ledger.load(lines);
    if (!ledger.chainStatus.ok) chainBroken = ledger.chainStatus.mismatches;
  }

  const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const fail = (step, code, message, details) => {
    const payload = { step, error: code, message };
    if (details !== undefined) payload.details = details;
    process.stderr.write(JSON.stringify(payload) + '\n');
    process.exit(EXIT_ERROR);
  };
  const persist = (line) => {
    if (logPath) fs.appendFileSync(logPath, JSON.stringify(line) + '\n');
  };

  const lines = await readInputLines(args.inputFile);
  let step = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    step += 1;
    let op;
    try {
      op = JSON.parse(line);
    } catch {
      fail(step, 'BAD_JSON', 'input line is not valid JSON');
    }
    try {
      const result = applyOp(op, { ledger, persist, getChainBroken: () => chainBroken, setChainBroken: (v) => { chainBroken = v; }, logPath, out, step });
      if (result === 'stop') break;
    } catch (err) {
      if (err instanceof LedgerError) fail(step, err.code, err.message, err.details);
      throw err;
    }
  }
}

function applyOp(op, ctx) {
  const { ledger, persist, out, step } = ctx;
  const mutating = op.op === 'voucher' || op.op === 'reverse' || op.op === 'snapshot';
  if (mutating && ctx.getChainBroken()) {
    throw new LedgerError('BROKEN_CHAIN', 'refusing to mutate: stored chain is broken; run {"op":"recover"} first', { mismatches: ctx.getChainBroken() });
  }
  switch (op.op) {
    case 'snapshot': {
      const snapshot = ledger.addSnapshot(op);
      persist({ op: 'snapshot', params: { id: snapshot.id, pair: snapshot.pair, rate: snapshot.rate } });
      out({ step, op: 'snapshot', id: snapshot.id, root: ledger.root });
      return;
    }
    case 'voucher': {
      const record = ledger.addVoucher({ id: op.id, entries: op.entries, deps: op.deps ?? [], pos: op.pos ?? null });
      persist({ op: 'voucher', params: { id: op.id, entries: record.entries, deps: record.deps, pos: op.pos ?? null }, record: recordView(record) });
      const proof = ledger.proof(record.id);
      out({ step, op: 'voucher', id: record.id, hash: record.hash, lamport: record.lamport, pos: record.pos, valid: !record.invalid, root: ledger.root, invalid: ledger.invalidIds(), proof: proof.proof });
      return;
    }
    case 'reverse': {
      const record = ledger.reverse({ id: op.id, target: op.target });
      persist({ op: 'reverse', params: { id: op.id, target: op.target }, record: recordView(record) });
      out({ step, op: 'reverse', id: record.id, target: op.target, root: ledger.root, invalid: ledger.invalidIds() });
      return;
    }
    case 'root': {
      out({ step, op: 'root', root: ledger.root, chainTip: ledger.chainTip, valid: ledger.validRecords().length, invalid: ledger.invalidIds(), balances: balancesObject(ledger) });
      return;
    }
    case 'proof': {
      const proof = ledger.proof(op.id);
      out({ step, op: 'proof', id: op.id, valid: proof.valid, root: proof.root, proof: proof.proof });
      return;
    }
    case 'verify': {
      const report = { step, op: 'verify', root: ledger.root, chainTip: ledger.chainTip, valid: ledger.validRecords().length, invalid: ledger.invalidIds(), balances: balancesObject(ledger) };
      let ok = true;
      if (ctx.getChainBroken()) {
        ok = false;
        report.chain = 'broken';
        report.brokenAt = ctx.getChainBroken();
      } else {
        report.chain = 'ok';
      }
      if (op.cert) {
        report.certificate = certificateStatus(op.cert, ledger);
        if (report.certificate !== 'ok' && report.certificate !== 'missing') ok = false;
      }
      report.ok = ok;
      out(report);
      if (!ok) {
        process.stderr.write(JSON.stringify({ step, error: 'VERIFY_FAILED', message: 'verification failed', report }) + '\n');
        process.exitCode = 3;
        return 'stop';
      }
      return;
    }
    case 'certificate': {
      if (typeof op.file !== 'string' || !op.file) {
        throw new LedgerError('BAD_INPUT', 'certificate op requires a file');
      }
      const cert = buildCertificate(ledger);
      const crashAfter = process.env.LEDGER_CRASH_AFTER;
      let result;
      try {
        result = writeCertificate(op.file, cert, { crashAfter });
      } catch (err) {
        if (err && err.code === 'CRASH_SIMULATED') {
          process.stderr.write(JSON.stringify({ step, error: 'CRASH_SIMULATED', message: err.message }) + '\n');
          process.exit(1);
        }
        throw err;
      }
      out({ step, op: 'certificate', file: op.file, root: cert.root, chainTip: cert.chainTip, recovered: result.recovered });
      return;
    }
    case 'recover': {
      if (!ctx.logPath) {
        throw new LedgerError('BAD_INPUT', 'recover requires --state');
      }
      const broken = ctx.getChainBroken();
      if (!broken) {
        out({ step, op: 'recover', recovered: false, root: ledger.root });
        return;
      }
      fs.writeFileSync(ctx.logPath, ledger.serialize());
      ctx.setChainBroken(null);
      out({ step, op: 'recover', recovered: true, fixed: broken.length, root: ledger.root });
      return;
    }
    default:
      throw new LedgerError('BAD_INPUT', `unknown op ${op.op}`);
  }
}

main().catch((err) => {
  process.stderr.write(JSON.stringify({ error: 'INTERNAL', message: String(err && err.stack || err) }) + '\n');
  process.exit(EXIT_ERROR);
});
