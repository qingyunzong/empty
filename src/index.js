import { prepareLedger } from './ledger.js';
import { internallyBalanced } from './automaton.js';
import { multisetDiff, searchScripts, lowerBound, solveFast } from './diff.js';
import { buildCertificate, verifyCertificate } from './certificate.js';
import { ERR } from './errors.js';

export const MAX_REPORTED_SCRIPTS = 20;

export { prepareLedger, parseJsonl } from './ledger.js';
export { LedgerAutomaton, ProductAutomaton, canonicalForm, internallyBalanced } from './automaton.js';
export { multisetDiff, applyScript, isGoal, lowerBound, searchScripts } from './diff.js';
export { buildCertificate, verifyCertificate } from './certificate.js';
export { ReconError, ERR } from './errors.js';

// Main entry: diff two ledgers (arrays of raw event objects).
// Returns { balanced, scripts, scriptCount, minCost, certificate, error }.
// A SEARCH_BOUND error is never reported as "no difference": balanced stays
// false and the certificate carries the proven lower bound.
export function diffLedgers(leftRaw, rightRaw, opts = {}) {
  const k = opts.k ?? 5;
  const budget = opts.budget ?? 100_000;
  const L = prepareLedger(leftRaw, 'left');
  const R = prepareLedger(rightRaw, 'right');

  const diff = multisetDiff(L, R);
  const balanced = diff.lOnly.length === 0 && diff.rOnly.length === 0
    && internallyBalanced(L) && internallyBalanced(R);
  if (balanced) {
    return { balanced: true, scripts: [], scriptCount: 0, minCost: 0, certificate: null, error: null };
  }

  const reason = diff.lOnly.length > 0 || diff.rOnly.length > 0 ? 'UNMATCHED_EVENTS' : 'INTERNAL_IMBALANCE';
  const combinatorialLB = lowerBound(L, R);

  // Combinatorial fast path: exact minimal cost and co-optimal scripts
  // whenever the canonical base script reaches a jointly balanced state.
  const fast = solveFast(L, R);
  if (fast && fast.found && fast.minCost <= k) {
    const certificate = buildCertificate(L, R, {
      reason, continuation: fast.scripts[0] ?? null, provenLowerBound: null, k,
    });
    verifyCertificate(L, R, certificate);
    return {
      balanced: false,
      scripts: fast.scripts.slice(0, MAX_REPORTED_SCRIPTS),
      scriptCount: fast.totalCount,
      minCost: fast.minCost,
      certificate,
      error: null,
    };
  }

  if (combinatorialLB > k) {
    const certificate = buildCertificate(L, R, {
      reason: ERR.SEARCH_BOUND, continuation: null, provenLowerBound: combinatorialLB, k,
    });
    verifyCertificate(L, R, certificate);
    return {
      balanced: false,
      scripts: [],
      scriptCount: 0,
      minCost: null,
      certificate,
      error: { code: ERR.SEARCH_BOUND, message: `proven lower bound ${combinatorialLB} exceeds search bound k=${k}` },
    };
  }

  const res = searchScripts(L, R, { k, budget });
  if (res.found) {
    const certificate = buildCertificate(L, R, {
      reason, continuation: res.scripts[0], provenLowerBound: null, k,
    });
    verifyCertificate(L, R, certificate);
    return {
      balanced: false,
      scripts: res.scripts.slice(0, MAX_REPORTED_SCRIPTS),
      scriptCount: res.totalCount,
      minCost: res.minCost,
      certificate,
      error: null,
    };
  }

  const residualLB = fast && !fast.found ? fast.minCostLowerBound : combinatorialLB;
  const provenLowerBound = res.exhaustedToK ? Math.max(residualLB, k + 1) : residualLB;
  const certificate = buildCertificate(L, R, {
    reason: ERR.SEARCH_BOUND, continuation: null, provenLowerBound, k,
  });
  verifyCertificate(L, R, certificate);
  return {
    balanced: false,
    scripts: [],
    scriptCount: 0,
    minCost: null,
    certificate,
    error: {
      code: ERR.SEARCH_BOUND,
      message: `no repair script with cost <= ${k} found (proven lower bound: ${provenLowerBound})`,
    },
  };
}
