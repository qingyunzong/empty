'use strict';
// Verify engine: for every assay conclusion in the log, decide
//   VALID   - complete, unexpired, unrevoked evidence chain (certificate issued)
//   BROKEN  - chain broken (violation / qc_fail / revoked dependency); a minimal
//             broken core is reported for re-checking
//   STALE   - cold-chain time limit exceeded and not preserved by attestation
//   PENDING - audit budget exhausted before the closure was fully checked
// PENDING is explicitly not BROKEN.

const { closureBFS, pathDown } = require('./closure');

const COLD_CHAIN_LIMIT_MS = 72 * 3600 * 1000; // 72h cold-chain limit

function timeOf(entity) {
  return entity && entity.time ? Date.parse(entity.time) : NaN;
}

// Root sample(s) of a closure: entities with no parents.
function rootsOf(state, closure) {
  const roots = [];
  for (const id of closure) {
    const ps = state.parents.get(id) || [];
    if (ps.length === 0 && state.entities.get(id)) roots.push(id);
  }
  return roots;
}

function verifyAssay(state, assayId, opts) {
  const budget = opts.budget === undefined ? Infinity : opts.budget;
  const now = opts.now === undefined ? Date.now() : Date.parse(opts.now);
  const assay = state.entities.get(assayId);

  const { set: closure, exhausted } = closureBFS(state.parents, assayId, budget);
  if (exhausted) {
    return { assay: assayId, status: 'PENDING', reason: `audit budget ${budget} exhausted`, certificate: null, core: null };
  }

  // 1. Structural violations touching the closure.
  const inClosure = (t) => t !== null && closure.has(t);
  const hits = state.violations.filter((v) => inClosure(v.target));
  if (hits.length > 0) {
    return {
      assay: assayId, status: 'BROKEN',
      reason: hits.map((h) => `${h.code}: ${h.detail}`).join('; '),
      certificate: null,
      core: { kind: 'violation', events: hits.map((h) => h.event) },
    };
  }

  // 2. QC gate: any qc_failed node in the closure breaks the chain; report the
  //    minimal broken chain (shortest path from the failed node to the assay).
  for (const id of closure) {
    if (state.qcFailed.has(id)) {
      return {
        assay: assayId, status: 'BROKEN',
        reason: `qc_fail at ${id} propagates to conclusion`,
        certificate: null,
        core: { kind: 'qc_fail', chain: pathDown(state.children, id, assayId) || [id, assayId] },
      };
    }
  }

  // 3. Revocation contagion: any revoked node in the closure invalidates the
  //    conclusion. Attestation only preserves conclusions that do NOT depend
  //    on revoked nodes, so a revoked node inside the closure is fatal.
  for (const id of closure) {
    if (state.revoked.has(id)) {
      return {
        assay: assayId, status: 'BROKEN',
        reason: `revoked node ${id} (${state.revoked.get(id).reason}) in derivation chain`,
        certificate: null,
        core: { kind: 'revoke', chain: pathDown(state.children, id, assayId) || [id, assayId] },
      };
    }
  }

  // 4. Cold-chain staleness. Edge gaps are structural; root age is evaluated at
  //    `now`, unless a valid attestation was made while the chain was fresh.
  const attestation = state.attestations.get(assayId);
  for (const id of closure) {
    for (const p of state.parents.get(id) || []) {
      const gap = timeOf(state.entities.get(id)) - timeOf(state.entities.get(p));
      if (Number.isFinite(gap) && gap > COLD_CHAIN_LIMIT_MS) {
        return { assay: assayId, status: 'STALE', reason: `cold-chain limit exceeded on edge ${p} -> ${id}`, certificate: null, core: null };
      }
    }
  }
  const roots = rootsOf(state, closure);
  const rootAge = Math.max(...roots.map((r) => now - timeOf(state.entities.get(r))), 0);
  if (rootAge > COLD_CHAIN_LIMIT_MS) {
    const freshAtAttest = attestation &&
      roots.every((r) => Date.parse(attestation.time) - timeOf(state.entities.get(r)) <= COLD_CHAIN_LIMIT_MS);
    if (!freshAtAttest) {
      return { assay: assayId, status: 'STALE', reason: `cold-chain limit exceeded: root sample older than 72h at audit time`, certificate: null, core: null };
    }
  }

  // 5. VALID: issue a certificate over the closure.
  const certClosure = [...closure].sort();
  return {
    assay: assayId,
    status: 'VALID',
    reason: attestation ? 'chain complete; attested ' + attestation.signature : 'chain complete',
    certificate: {
      assay: assayId,
      conclusion: assay.conclusion,
      closure: certClosure,
      attested: Boolean(attestation),
      issuedAt: new Date(now).toISOString(),
    },
    core: null,
  };
}

function verify(state, opts = {}) {
  const assays = [...state.entities.values()].filter((e) => e.kind === 'assay').map((e) => e.id);
  const results = assays.map((id) => verifyAssay(state, id, opts));
  const summary = {
    VALID: results.filter((r) => r.status === 'VALID').length,
    BROKEN: results.filter((r) => r.status === 'BROKEN').length,
    STALE: results.filter((r) => r.status === 'STALE').length,
    PENDING: results.filter((r) => r.status === 'PENDING').length,
  };
  return { results, summary };
}

// ---- Brute-force reference implementation (for enumeration cross-checks) ----
// Deliberately naive: recomputes ancestors by recursive expansion per assay.
function referenceAncestors(state, id) {
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const p of state.parents.get(n) || []) visit(p);
  };
  visit(id);
  return seen;
}

function referenceStatus(state, assayId, now) {
  const anc = referenceAncestors(state, assayId);
  for (const v of state.violations) if (v.target !== null && anc.has(v.target)) return 'BROKEN';
  for (const id of anc) if (state.qcFailed.has(id)) return 'BROKEN';
  for (const id of anc) if (state.revoked.has(id)) return 'BROKEN';
  for (const id of anc) {
    for (const p of state.parents.get(id) || []) {
      const gap = timeOf(state.entities.get(id)) - timeOf(state.entities.get(p));
      if (Number.isFinite(gap) && gap > COLD_CHAIN_LIMIT_MS) return 'STALE';
    }
  }
  const roots = [...anc].filter((id) => (state.parents.get(id) || []).length === 0 && state.entities.get(id));
  const rootAge = Math.max(...roots.map((r) => now - timeOf(state.entities.get(r))), 0);
  if (rootAge > COLD_CHAIN_LIMIT_MS) {
    const att = state.attestations.get(assayId);
    const fresh = att && roots.every((r) => Date.parse(att.time) - timeOf(state.entities.get(r)) <= COLD_CHAIN_LIMIT_MS);
    if (!fresh) return 'STALE';
  }
  return 'VALID';
}

module.exports = { verify, verifyAssay, referenceStatus, referenceAncestors, COLD_CHAIN_LIMIT_MS };
