import { ROLLED_BACK, canonicalDigest, closureOf, sha256 } from './state.js';

// Deterministic version-hash transition for a rolled-back node.
export function transitionHash(id, oldHash) {
  return sha256(`rollback\0${id}\0${oldHash}`);
}

// Builds the old/new hash certificate for a plan against the pre-execution
// state. Entries follow the execution order (active descendants first).
export function buildCertificate(state, plan) {
  const entries = plan.affected.map((id, index) => {
    const node = state.nodes.get(id);
    return {
      order: index,
      id,
      path: node.path,
      oldHash: node.hash,
      newHash: transitionHash(id, node.hash),
    };
  });
  return {
    version: 1,
    target: plan.target,
    budget: plan.budget,
    cost: plan.cost,
    plan: [...plan.nodes],
    planPaths: [...plan.paths],
    stateBefore: canonicalDigest(state),
    entries,
    stateAfter: null,
  };
}

// Applies the certificate to the state: every affected node becomes
// rolled-back and receives its new version hash.
export function applyCertificate(state, cert) {
  for (const entry of cert.entries) {
    const node = state.nodes.get(entry.id);
    node.status = ROLLED_BACK;
    node.hash = entry.newHash;
  }
  cert.stateAfter = canonicalDigest(state);
  return cert;
}

// Verifies a certificate against the current (post-commit) state.
export function verifyCertificate(state, cert) {
  const errors = [];
  if (!cert || typeof cert !== 'object' || cert.version !== 1) {
    errors.push('unsupported or missing certificate version');
    return { ok: false, errors };
  }
  if (!Array.isArray(cert.plan) || !Array.isArray(cert.entries)) {
    errors.push('certificate must contain "plan" and "entries" arrays');
    return { ok: false, errors };
  }

  for (const entry of cert.entries) {
    if (transitionHash(entry.id, entry.oldHash) !== entry.newHash) {
      errors.push(`entry "${entry.id}": newHash does not match the rollback transition of oldHash`);
    }
  }

  for (let i = 0; i < cert.entries.length; i += 1) {
    for (let j = i + 1; j < cert.entries.length; j += 1) {
      const pi = cert.entries[i].path;
      const pj = cert.entries[j].path;
      if (pj.startsWith(`${pi}/`)) {
        errors.push(`entry order invalid: ancestor "${pi}" appears before its descendant "${pj}"`);
      }
    }
  }

  const allowed = closureOf(state, cert.plan);
  for (const entry of cert.entries) {
    if (!allowed.has(entry.id)) {
      errors.push(`entry "${entry.id}" lies outside the rollback closure of the plan`);
    }
  }

  for (const entry of cert.entries) {
    const node = state.nodes.get(entry.id);
    if (!node) {
      errors.push(`entry "${entry.id}": node not present in state`);
      continue;
    }
    if (node.status !== ROLLED_BACK) errors.push(`node "${entry.id}" is not rolled back in the state`);
    if (node.hash !== entry.newHash) errors.push(`node "${entry.id}": state hash does not match certificate newHash`);
  }

  if (cert.stateAfter !== canonicalDigest(state)) {
    errors.push('state digest mismatch: current state does not match certificate stateAfter');
  }

  return { ok: errors.length === 0, errors };
}
