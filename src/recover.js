import fs from 'node:fs';
import { Wal } from './wal.js';
import { loadLedger, applyEffect } from './ledger.js';
import { compilePlan } from './compile.js';
import { VM } from './vm.js';
import { ioError } from './errors.js';

export function recoverWal(walPath, opts = {}) {
  const { header, records } = Wal.read(walPath);
  const ledger = readLedgerFile(header.ledger);
  for (const rec of records) {
    if (rec.type === 'effect') applyEffect(ledger, rec.effect);
  }
  if (records.some((r) => r.type === 'done')) {
    return { ledger, header, resumed: false, counts: null };
  }
  let source;
  try {
    source = fs.readFileSync(header.plan, 'utf8');
  } catch (e) {
    throw ioError(`cannot read plan ${header.plan}: ${e.message}`);
  }
  const program = compilePlan(source);
  if (program.revId !== header.revId) {
    throw ioError(`plan revId mismatch: WAL expects ${header.revId}, plan compiles to ${program.revId}`);
  }
  const wal = Wal.append(walPath);
  try {
    const vm = new VM(program, ledger, wal, opts);
    const counts = vm.run();
    wal.append({ type: 'done', counts });
    return { ledger, header, resumed: true, counts };
  } finally {
    wal.close();
  }
}

function readLedgerFile(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw ioError(`cannot read ledger ${path}: ${e.message}`);
  }
  try {
    return loadLedger(JSON.parse(text));
  } catch (e) {
    if (e && e.code) throw e;
    throw ioError(`invalid ledger JSON in ${path}: ${e.message}`);
  }
}
