import { createHash } from 'node:crypto';
import { compileContract, runOrders } from './runtime.js';
import { divRound } from './vm.js';
import { err } from './errors.js';

export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'bigint') return JSON.stringify(String(v));
  return JSON.stringify(v);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function buildCert(contract, ordersRaw, results) {
  return {
    version: 1,
    contractHash: sha256(contract.source),
    ordersHash: sha256(canonical(ordersRaw)),
    orders: results,
  };
}

// Replays a certificate: checks hashes, re-verifies every recorded rounding
// step arithmetically, checks allocation conservation, then re-executes the
// contract and compares the full traces.
export function verifyCertificate(contractSource, ordersRaw, cert) {
  if (!cert || cert.version !== 1) throw err('E_CERT', 'unsupported certificate version');
  if (cert.contractHash !== sha256(contractSource)) {
    throw err('E_CERT', 'contract hash mismatch: certificate was not issued for this contract');
  }
  if (cert.ordersHash !== sha256(canonical(ordersRaw))) {
    throw err('E_CERT', 'orders hash mismatch: certificate was not issued for these orders');
  }

  for (const o of cert.orders) {
    if (o.error) continue;
    for (const s of o.trace ?? []) {
      if (s.op === 'ROUND') {
        const { q, r } = divRound(BigInt(s.in), BigInt(s.scale), s.mode);
        if (String(q) !== s.out || String(r) !== s.rem) {
          throw err('E_ROUND', `certificate replay failed at order ${o.id} step ${s.step}: rounding does not reproduce`);
        }
      }
    }
    for (const a of o.allocations ?? []) {
      let sum = BigInt(a.residual.amount);
      for (const v of Object.values(a.components)) sum += BigInt(v);
      if (sum !== BigInt(a.total)) {
        throw err('E_CONSERVE', `certificate conservation violated at order ${o.id}: components + residual ${sum} != total ${a.total}`);
      }
    }
  }

  const contract = compileContract(contractSource);
  const expected = runOrders(contract, ordersRaw).results;
  if (!Array.isArray(cert.orders) || expected.length !== cert.orders.length) {
    throw err('E_CERT', 'certificate order count mismatch');
  }
  for (let idx = 0; idx < expected.length; idx += 1) {
    const e = expected[idx];
    const c = cert.orders[idx];
    if (e.id !== c.id) throw err('E_CERT', `certificate order ${idx} id mismatch`);
    if (e.error || c.error) {
      if (canonical(e.error) !== canonical(c.error)) throw err('E_CERT', `certificate error mismatch at order ${c.id}`);
      continue;
    }
    if (canonical(e.trace) !== canonical(c.trace)) {
      const len = Math.max(e.trace.length, c.trace.length);
      for (let k = 0; k < len; k += 1) {
        if (canonical(e.trace[k]) !== canonical(c.trace[k])) {
          const op = c.trace[k]?.op ?? e.trace[k]?.op;
          if (op === 'ROUND') throw err('E_ROUND', `certificate trace mismatch at order ${c.id} step ${k}`);
          if (op === 'ALLOC' || op === 'CONSERVE') throw err('E_CONSERVE', `certificate trace mismatch at order ${c.id} step ${k}`);
          throw err('E_CERT', `certificate trace mismatch at order ${c.id} step ${k}`);
        }
      }
      throw err('E_CERT', `certificate trace length mismatch at order ${c.id}`);
    }
    if (canonical(e.allocations) !== canonical(c.allocations)) {
      throw err('E_CONSERVE', `certificate allocations mismatch at order ${c.id}`);
    }
    if (e.feeCents !== c.feeCents || canonical(e.tiers) !== canonical(c.tiers)) {
      throw err('E_CERT', `certificate result mismatch at order ${c.id}`);
    }
  }
  return true;
}
