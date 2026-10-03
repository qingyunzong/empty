import { createHash } from 'node:crypto';
import { canonical } from './canon.js';
import { SettleError, E } from './errors.js';

const GENESIS = createHash('sha256').update('settle-cert-v1').digest('hex');

function hashRow(prevHash, row) {
  return createHash('sha256').update(prevHash + '\n' + canonical(row)).digest('hex');
}

// Certificate: canonical row order, sha256 chain over rows, input digests.
export function buildCertificate(rows, inputDigests) {
  const chain = [];
  let prev = GENESIS;
  for (const row of rows) {
    prev = hashRow(prev, row);
    chain.push(prev);
  }
  return {
    version: 1,
    genesis: GENESIS,
    inputs: inputDigests, // { accounts, trades, events } sha256 of raw files
    row_count: rows.length,
    rows,
    chain,
    root: chain.length ? chain[chain.length - 1] : GENESIS,
  };
}

// Verify: recompute the chain from rows, check canonical order and root.
export function verifyCertificate(cert) {
  if (cert === null || typeof cert !== 'object') {
    throw new SettleError(E.CERT_TAMPER, 'certificate is not an object');
  }
  for (const f of ['version', 'genesis', 'inputs', 'row_count', 'rows', 'chain', 'root']) {
    if (!(f in cert)) throw new SettleError(E.CERT_TAMPER, `missing field ${f}`);
  }
  if (cert.version !== 1) throw new SettleError(E.CERT_TAMPER, `unsupported version ${cert.version}`);
  if (cert.rows.length !== cert.row_count) {
    throw new SettleError(E.CERT_TAMPER, `row_count ${cert.row_count} != rows length ${cert.rows.length}`);
  }
  if (cert.chain.length !== cert.rows.length) {
    throw new SettleError(E.CERT_TAMPER, 'chain length does not match rows');
    }
  const keyOf = (r) => [r.currency, r.counterparty, r.trade_date];
  for (let i = 1; i < cert.rows.length; i++) {
    const a = keyOf(cert.rows[i - 1]);
    const b = keyOf(cert.rows[i]);
    if (canonical(a) > canonical(b)) {
      throw new SettleError(E.CERT_TAMPER, `rows out of canonical order at index ${i}`);
    }
  }
  let prev = cert.genesis;
  for (let i = 0; i < cert.rows.length; i++) {
    prev = hashRow(prev, cert.rows[i]);
    if (prev !== cert.chain[i]) {
      throw new SettleError(E.CERT_TAMPER, `chain mismatch at row ${i}`);
    }
  }
  if (prev !== cert.root) throw new SettleError(E.CERT_TAMPER, 'root hash mismatch');
  return true;
}
