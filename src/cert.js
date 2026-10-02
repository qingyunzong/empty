import { hash } from './canon.js';
import { penalty } from './plan.js';

export function buildCertificate(state, m) {
  const cert = {
    version: 1,
    baseHash: hash(state.base),
    clock: state.clock,
    logLen: state.changes.length,
    logHash: hash(state.changes),
    planHash: hash(m.plan),
    cost: penalty(m.plan),
    conflicts: m.conflicts,
    pending: m.pending,
  };
  return { cert, certHash: hash(cert) };
}
