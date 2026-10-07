'use strict';

const { CODES, ReconError } = require('./errors');
const { utcToLocal, localToUtc, parseUtcInstant } = require('./tztable');
const { findRate, intersectingRates } = require('./rates');

function toCents(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new ReconError(CODES.POLICY, `invalid amount: ${String(amount)}`);
  }
  return Math.round(amount * 100);
}

function rateHitView(hit) {
  if (!hit) return null;
  return {
    intervalId: hit.id,
    rateVersion: hit.version,
    pair: hit.pair,
    rate: hit.rate,
    startUtc: hit.startUtc,
    endUtc: hit.endUtc,
  };
}

// Resolve a transaction's UTC instant + local attestation under a pinned table
// version. Transactions may carry `utc` (ISO / epoch seconds / leap-style
// string) or `local` (merchant-local civil time, disambiguated by policy).
function resolveTime(txn, table, policy) {
  if (txn.utc !== undefined) {
    const r = utcToLocal(txn.utc, table);
    return {
      utc: txn.utc,
      utcEpoch: r.utcEpoch,
      attestation: {
        tzVersion: table.version,
        input: 'utc',
        policy,
        local: r.local,
        localDay: r.localDay,
        via: r.via,
        resolution: r.via === 'explicit' ? 'explicit-leap-mapping' : 'unique',
      },
    };
  }
  if (txn.local !== undefined) {
    const r = localToUtc(txn.local, table, policy);
    const localView = utcToLocal(r.utc, table);
    return {
      utc: r.utc,
      utcEpoch: r.utcEpoch,
      attestation: {
        tzVersion: table.version,
        input: 'local',
        policy,
        local: localView.local,
        localDay: localView.localDay,
        via: localView.via,
        resolution: r.resolution,
        candidates: r.candidates,
      },
    };
  }
  throw new ReconError(CODES.POLICY, `transaction ${txn.id} has neither "utc" nor "local"`, { txnId: txn.id });
}

function buildPosting(txn, table, policy, rates) {
  if (typeof txn.id !== 'string' || txn.id.length === 0) {
    throw new ReconError(CODES.POLICY, 'transaction requires a string "id"');
  }
  if (typeof txn.pair !== 'string' || txn.pair.length === 0) {
    throw new ReconError(CODES.POLICY, `transaction ${txn.id} requires a "pair" (e.g. "USD/CNY")`);
  }
  const amountCents = toCents(txn.amount);
  const resolved = resolveTime(txn, table, policy);
  const hit = findRate(rates, txn.pair, resolved.utcEpoch);
  return {
    txnId: txn.id,
    pair: txn.pair,
    currency: txn.currency || txn.pair.split('/')[1] || null,
    amountCents,
    utc: resolved.utc,
    utcEpoch: resolved.utcEpoch,
    attestation: resolved.attestation,
    rateHit: rateHitView(hit),
    expected: hit
      ? { amountCents: Math.round(amountCents * hit.rate), localDay: resolved.attestation.localDay }
      : null,
  };
}

// Post transactions into a new ledger. The tzVersion is pinned at posting time
// and copied into every attestation; later table hot-updates never rewrite it.
function postLedger({ txns, registry, tzVersion, policy, rates }) {
  const version = tzVersion || registry.currentVersion;
  const table = registry.get(version);
  const postings = txns.map((txn) => buildPosting(txn, table, policy, rates));
  return {
    tzVersionPinned: version,
    policy,
    postings,
    appliedCorrections: [],
    corrections: [],
  };
}

function recomputePosting(posting, registry, rates) {
  const table = registry.get(posting.attestation.tzVersion); // pinned, never "current"
  const policy = posting.attestation.policy;
  const rebuilt = buildPosting(
    { id: posting.txnId, pair: posting.pair, currency: posting.currency, amount: posting.amountCents / 100, utc: posting.utc },
    table,
    policy,
    rates
  );
  rebuilt.attestation = { ...posting.attestation }; // keep original attestation record
  return rebuilt;
}

// Apply a correction: { id, txnId, newUtc?, newLocal?, newAmount? }.
// Only rate intervals intersecting the correction window are recomputed.
function applyCorrection(ledger, correction, { registry, rates, policy, allowRepin = false }) {
  if (typeof correction.id !== 'string' || correction.id.length === 0) {
    throw new ReconError(CODES.POLICY, 'correction requires a string "id"');
  }
  if (ledger.appliedCorrections.includes(correction.id)) {
    throw new ReconError(CODES.REPLAY, `correction "${correction.id}" was already applied`, {
      correctionId: correction.id,
    });
  }
  const idx = ledger.postings.findIndex((p) => p.txnId === correction.txnId);
  if (idx === -1) {
    throw new ReconError(CODES.POLICY, `correction targets unknown txnId "${correction.txnId}"`, {
      correctionId: correction.id,
    });
  }
  const original = ledger.postings[idx];
  const pinnedVersion = original.attestation.tzVersion;
  if (correction.tzVersion !== undefined && correction.tzVersion !== pinnedVersion && !allowRepin) {
    throw new ReconError(
      CODES.REPLAY,
      `correction requests tzVersion "${correction.tzVersion}" but posting is pinned to "${pinnedVersion}"; recompute must use the pinned version (pass allowRepin to migrate explicitly)`,
      { correctionId: correction.id, pinnedVersion, requestedVersion: correction.tzVersion }
    );
  }
  const table = registry.get(pinnedVersion);
  const effectivePolicy = policy || ledger.policy || original.attestation.policy;

  const corrected = { ...original };
  if (correction.newAmount !== undefined) {
    corrected.amountCents = toCents(correction.newAmount);
  }
  if (correction.newUtc !== undefined) {
    const r = utcToLocal(correction.newUtc, table);
    corrected.utc = correction.newUtc;
    corrected.utcEpoch = r.utcEpoch;
    corrected.attestation = {
      ...original.attestation,
      local: r.local,
      localDay: r.localDay,
      via: r.via,
      resolution: r.via === 'explicit' ? 'explicit-leap-mapping' : 'unique',
      correctedBy: correction.id,
    };
  } else if (correction.newLocal !== undefined) {
    const r = localToUtc(correction.newLocal, table, effectivePolicy);
    const localView = utcToLocal(r.utc, table);
    corrected.utc = r.utc;
    corrected.utcEpoch = r.utcEpoch;
    corrected.attestation = {
      ...original.attestation,
      input: 'local',
      policy: effectivePolicy,
      local: localView.local,
      localDay: localView.localDay,
      via: localView.via,
      resolution: r.resolution,
      candidates: r.candidates,
      correctedBy: correction.id,
    };
  }

  // Recompute window: span between old and new instants of the corrected txn.
  const epochs = [original.utcEpoch, corrected.utcEpoch].filter((e) => e !== null && e !== undefined);
  const windowStart = Math.min(...epochs);
  const windowEnd = Math.max(...epochs) + 1; // half-open

  const affectedIntervals = intersectingRates(rates, original.pair, windowStart, windowEnd);
  const affectedIds = new Set(affectedIntervals.map((r) => r.id));

  const postings = ledger.postings.map((p) => (p.txnId === corrected.txnId ? corrected : p));
  const impactedTxnIds = [];
  const finalPostings = postings.map((p) => {
    const hitInterval = p.rateHit && p.rateHit.intervalId;
    const isImpacted =
      p.txnId === corrected.txnId ||
      (p.pair === original.pair && hitInterval !== null && affectedIds.has(hitInterval));
    if (!isImpacted) return p;
    impactedTxnIds.push(p.txnId);
    return recomputePosting(p, registry, rates);
  });

  const impact = {
    correctionId: correction.id,
    window: { startUtc: windowStart, endUtc: windowEnd },
    rateIntervals: affectedIntervals.map((r) => r.id),
    postings: impactedTxnIds,
  };

  return {
    ...ledger,
    postings: finalPostings,
    appliedCorrections: [...ledger.appliedCorrections, correction.id],
    corrections: [...ledger.corrections, impact],
    lastImpact: impact,
  };
}

module.exports = { postLedger, applyCorrection, toCents };
