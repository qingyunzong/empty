'use strict';

const { validate } = require('./validate');
const { solve } = require('./solver');
const { toCents, fromCents, TIERS } = require('./money');

const MONEY_KEYS = new Set(['needed', 'available', 'required', 'capacity']);

function convertConflicts(conflicts) {
  return conflicts.map((c) => {
    const out = {};
    for (const [k, v] of Object.entries(c)) {
      out[k] = MONEY_KEYS.has(k) && typeof v === 'number' ? fromCents(v) : v;
    }
    return out;
  });
}

function processInput(input) {
  validate(input);

  const packages = input.packages.map((p) => ({
    id: p.id,
    limits: Object.fromEntries(Object.entries(p.limits).map(([k, v]) => [k, toCents(v)])),
  }));

  const cancellations = input.cancellations ?? [];
  const byId = new Map(input.reimbursements.map((r) => [r.id, r]));
  const cancelledTargets = new Set(cancellations.map((c) => c.target));

  // Apply cancellations: the unpaid part of a reservation is released back to
  // the budget; the paid part becomes red-flush pending. When the cancellation
  // names a package, the paid part keeps occupying that package's capacity.
  const releases = [];
  const redFlushPending = [];
  const preUsed = {}; // packageId -> category -> cents
  for (const c of cancellations) {
    const doc = byId.get(c.target);
    const amountCents = toCents(doc.amount);
    const paidCents = toCents(doc.paid ?? 0);
    releases.push({
      cancellation: c.id,
      target: c.target,
      released: fromCents(amountCents - paidCents),
    });
    if (paidCents > 0) {
      redFlushPending.push({ cancellation: c.id, target: c.target, amount: fromCents(paidCents) });
      if (c.package !== undefined) {
        const holds = (preUsed[c.package] ??= Object.create(null));
        holds[doc.category] = (holds[doc.category] ?? 0) + paidCents;
      }
    }
  }

  const activeDocs = input.reimbursements
    .filter((r) => !cancelledTargets.has(r.id))
    .map((r) => ({
      id: r.id,
      category: r.category,
      cents: toCents(r.amount),
      tiers: r.tiers ?? TIERS,
      group: r.group,
    }));

  const result = solve({
    packages,
    docs: activeDocs,
    budget: input.backtrackBudget,
    preUsed,
  });

  const reservedByPkgCat = new Map(); // `${pkgId}${cat}` -> cents
  for (const a of result.assignments) {
    const doc = activeDocs.find((d) => d.id === a.id);
    const key = `${a.packageId}${doc.category}`;
    reservedByPkgCat.set(key, (reservedByPkgCat.get(key) ?? 0) + a.reservedCents);
  }

  const packageUsage = packages.map((p) => {
    const categories = {};
    for (const [cat, limitCents] of Object.entries(p.limits)) {
      const reserved = reservedByPkgCat.get(`${p.id}${cat}`) ?? 0;
      const held = preUsed[p.id]?.[cat] ?? 0;
      categories[cat] = {
        reserved: fromCents(reserved),
        redFlushPending: fromCents(held),
        limit: fromCents(limitCents),
      };
    }
    return { id: p.id, categories };
  });

  return {
    status: result.status,
    assignments: result.assignments.map((a) => ({
      id: a.id,
      package: a.packageId,
      tier: a.tier,
      reserved: fromCents(a.reservedCents),
    })),
    packageUsage,
    releases,
    redFlushPending,
    // Conflicts from branches rejected during a successful search are noise;
    // the conflict set only matters when no (proven-optimal) solution exists.
    conflicts: result.status === 'OK' ? [] : convertConflicts(result.conflicts),
    stats: { backtracks: result.backtracks, backtrackBudget: result.backtrackBudget },
  };
}

module.exports = { processInput };
