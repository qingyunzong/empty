import { ExitError } from './errors.js';
import { forbiddenKey } from './recipes.js';
import { indexApprovals, decide } from './interpreter.js';
import { sortAttempts } from './brute.js';

export function validateAttempts(attempts, recipes) {
  const seen = new Set();
  for (const t of attempts) {
    if (!t || typeof t.id !== 'string') throw new ExitError(2, 'attempt missing id');
    if (seen.has(t.id)) throw new ExitError(2, `duplicate attempt id ${t.id}`);
    seen.add(t.id);
    if (typeof t.ts !== 'number') throw new ExitError(2, `attempt ${t.id} missing ts`);
    if (!recipes.plant.kettleIds.has(t.kettle)) {
      throw new ExitError(2, `attempt ${t.id}: unknown kettle ${t.kettle}`);
    }
    if (!recipes.versions.has(t.version)) {
      throw new ExitError(2, `attempt ${t.id}: unknown version ${t.version}`);
    }
  }
}

// Runs every attempt in (ts, id) order through the interpreter.
export function runAll(recipes, approvals, attempts) {
  const idx = indexApprovals(approvals);
  const kettleStates = new Map();
  const results = [];
  for (const t of sortAttempts(attempts)) {
    const r = decide(recipes, approvals, idx, kettleStates, t);
    const rec = {
      attempt: t.id,
      kettle: t.kettle,
      version: t.version,
      ts: t.ts,
      decision: r.decision,
      reason: r.reason,
      approval: r.approval ?? null,
    };
    if (r.conflictWith) rec.conflictWith = r.conflictWith;
    results.push(rec);
    if (r.decision === 'allow') {
      const st = kettleStates.get(t.kettle) ?? { fed: [], maxSeq: -Infinity };
      st.fed.push(t.version);
      st.maxSeq = Math.max(st.maxSeq, recipes.versions.get(t.version).seq);
      kettleStates.set(t.kettle, st);
    }
  }
  return { results, kettleStates };
}

// Revoking an approval that already backed feeds produces deviation records;
// the historical feeds are kept, never erased.
export function computeDeviations(approvals, results) {
  const deviations = [];
  for (const a of approvals) {
    if (a.kind !== 'revoke') continue;
    const feeds = results
      .filter((r) => r.decision === 'allow' && r.approval === a.revokes && r.ts <= a.ts)
      .map((r) => r.attempt);
    if (feeds.length > 0) {
      deviations.push({ approval: a.revokes, revoke: a.id, reason: a.reason ?? null, feeds });
    }
  }
  return deviations;
}

// Per-kettle replay proof: every feed lists its witness approval and the prior
// versions it was checked against for forbidden combinations.
export function buildProofs(recipes, results) {
  const byKettle = new Map();
  for (const r of results) {
    if (!byKettle.has(r.kettle)) byKettle.set(r.kettle, []);
    byKettle.get(r.kettle).push(r);
  }
  const proofs = new Map();
  for (const [kettle, rs] of [...byKettle.entries()].sort()) {
    const fed = [];
    const feeds = [];
    const denied = [];
    for (const r of rs) {
      if (r.decision === 'allow') {
        feeds.push({
          attempt: r.attempt,
          version: r.version,
          ts: r.ts,
          approval: r.approval,
          priorVersions: [...fed],
          forbiddenPairs: fed
            .filter((u) => recipes.forbidden.has(forbiddenKey(u, r.version)))
            .map((u) => [u, r.version]),
        });
        fed.push(r.version);
      } else {
        denied.push({ attempt: r.attempt, version: r.version, ts: r.ts, reason: r.reason });
      }
    }
    proofs.set(kettle, { kettle, feeds, denied });
  }
  return proofs;
}
