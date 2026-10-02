import fs from 'node:fs';
import { Ledger } from './ledger.js';
import { LedgerError, canonical, sha256 } from './util.js';

export function buildCertificate(ledger) {
  const body = { version: 1, ...ledger.serialize() };
  return { ...body, checksum: sha256('cert', canonical(body)) };
}

export function writeCertificate(ledger, path) {
  const cert = buildCertificate(ledger);
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cert, null, 2));
  fs.renameSync(tmp, path); // atomic publish: a crash leaves, at worst, a stale .tmp
  return cert;
}

export function verifyCertificateFile(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    throw new LedgerError('CERT_NOT_FOUND', `certificate not found: ${path}`);
  }
  let cert;
  try {
    cert = JSON.parse(raw);
  } catch {
    throw new LedgerError('CERT_INCOMPLETE', `certificate is truncated or not valid JSON: ${path}`);
  }
  if (!cert || cert.version !== 1 || typeof cert.checksum !== 'string') {
    throw new LedgerError('CERT_INCOMPLETE', 'certificate missing version or checksum footer');
  }
  const { checksum, ...body } = cert;
  if (sha256('cert', canonical(body)) !== checksum) {
    throw new LedgerError('CERT_CORRUPT', 'certificate checksum mismatch');
  }
  const ledger = Ledger.fromState(body); // deterministic recomputation from genesis
  if (ledger.root() !== body.root) {
    throw new LedgerError('CERT_MISMATCH', 'recomputed root does not match certificate root');
  }
  return {
    ok: true,
    root: body.root,
    vouchers: body.vouchers.length,
    invalidated: body.invalidated,
    reversed: body.reversed,
  };
}
