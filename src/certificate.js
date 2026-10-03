import fs from 'node:fs';
import { merkleRoot } from './hash.js';

export function buildCertificate(ledger) {
  return {
    version: 1,
    root: ledger.root,
    chainTip: ledger.chainTip,
    valid: ledger.validRecords().map((v) => ({ id: v.id, hash: v.hash })),
    invalid: ledger.invalidIds(),
    vouchers: ledger.chain.length,
  };
}

export function verifyCertificate(cert, ledger) {
  if (!cert || cert.version !== 1 || !Array.isArray(cert.valid) || !Array.isArray(cert.invalid)) {
    return { ok: false, reason: 'malformed certificate' };
  }
  if (merkleRoot(cert.valid.map((v) => v.hash)) !== cert.root) {
    return { ok: false, reason: 'certificate root does not match its own voucher list' };
  }
  if (ledger) {
    if (cert.root !== ledger.root) return { ok: false, reason: 'root mismatch with ledger' };
    if (cert.chainTip !== ledger.chainTip) return { ok: false, reason: 'chain tip mismatch with ledger' };
    const validIds = ledger.validRecords().map((v) => v.id);
    if (JSON.stringify(cert.valid.map((v) => v.id)) !== JSON.stringify(validIds)) {
      return { ok: false, reason: 'valid set mismatch with ledger' };
    }
    if (JSON.stringify(cert.invalid) !== JSON.stringify(ledger.invalidIds())) {
      return { ok: false, reason: 'invalid set mismatch with ledger' };
    }
  }
  return { ok: true };
}

export function certificateStatus(file, ledger) {
  const tmp = file + '.tmp';
  if (!fs.existsSync(file)) {
    return fs.existsSync(tmp) ? 'incomplete' : 'missing';
  }
  let cert;
  try {
    cert = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 'corrupt';
  }
  return verifyCertificate(cert, ledger).ok ? 'ok' : 'mismatch';
}

export function writeCertificate(file, cert, { crashAfter } = {}) {
  const tmp = file + '.tmp';
  const recovered = fs.existsSync(tmp);
  if (recovered) fs.rmSync(tmp);
  const data = JSON.stringify(cert, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (crashAfter === 'tmp') {
    const err = new Error('simulated crash after tmp write, before rename');
    err.code = 'CRASH_SIMULATED';
    throw err;
  }
  fs.renameSync(tmp, file);
  return { recovered };
}
