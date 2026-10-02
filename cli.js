#!/usr/bin/env node
import fs from 'node:fs';
import { Ledger } from './src/ledger.js';
import { LedgerError } from './src/util.js';
import { writeCertificate, verifyCertificateFile } from './src/cert.js';

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function applyOp(ledger, op, step) {
  switch (op.op) {
    case 'config': {
      if (ledger.vouchers.size || ledger.snapshots.size) {
        throw new LedgerError('INVALID_OP', 'config must precede all other ops');
      }
      if (typeof op.base === 'string' && op.base) ledger.base = op.base;
      return { step, op: 'config', root: ledger.root(), invalidated: [], proof: null };
    }
    case 'snapshot': {
      const res = ledger.addSnapshot(op.id, op.rates);
      return {
        step, op: 'snapshot', id: op.id, applied: res.applied,
        root: ledger.root(), invalidated: res.invalidated, proof: null,
      };
    }
    case 'voucher': {
      const res = ledger.addVoucher(op);
      return {
        step, op: 'voucher', id: op.id, pending: res.pending,
        root: ledger.root(), invalidated: res.invalidated,
        proof: res.pending ? null : ledger.proof(op.id),
      };
    }
    case 'reverse': {
      const res = ledger.reverse(op);
      return {
        step, op: 'reverse', id: op.id, target: op.target, pending: res.pending,
        root: ledger.root(), invalidated: res.invalidated,
        proof: res.pending ? null : ledger.proof(op.id),
      };
    }
    case 'certify': {
      const cert = writeCertificate(ledger, op.path);
      return {
        step, op: 'certify', path: op.path, root: ledger.root(),
        checksum: cert.checksum, invalidated: [...ledger.invalidated].sort(), proof: null,
      };
    }
    case 'verify': {
      const result = verifyCertificateFile(op.path);
      if (result.root !== ledger.root()) {
        throw new LedgerError('CERT_MISMATCH',
          `certificate root ${result.root} != ledger root ${ledger.root()}`);
      }
      return { step, op: 'verify', ok: true, root: result.root, invalidated: result.invalidated, proof: null };
    }
    case 'finalize': {
      const res = ledger.finalize();
      return {
        step, op: 'finalize', ok: true, root: res.root,
        invalidated: [...ledger.invalidated].sort(), proof: null,
      };
    }
    default:
      throw new LedgerError('INVALID_OP', `unknown op: ${op.op}`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--verify') {
    if (!args[1]) throw new LedgerError('INVALID_OP', 'usage: node cli.js --verify <cert.json>');
    emit(verifyCertificateFile(args[1]));
    return;
  }
  const input = args[0] ? fs.readFileSync(args[0], 'utf8') : await readStdin();
  const ledger = new Ledger();
  let step = 0;
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    step += 1;
    let op;
    try {
      op = JSON.parse(trimmed);
    } catch {
      throw new LedgerError('INVALID_JSON', `line ${step}: not valid JSON`);
    }
    emit(applyOp(ledger, op, step));
  }
  ledger.finalize();
}

main().then(() => {}, (err) => {
  const code = err instanceof LedgerError ? err.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ error: code, message: err.message }) + '\n');
  process.exit(3);
});
