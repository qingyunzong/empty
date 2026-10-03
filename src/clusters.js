'use strict';

const crypto = require('crypto');

// Stable cluster id: content hash of the sorted member keys. Deterministic
// recompute yields the same id for the same membership, so restarts never
// duplicate clusters.
function clusterId(memberKeys) {
  const hash = crypto.createHash('sha256');
  hash.update([...memberKeys].sort().join('\n'));
  return 'clus_' + hash.digest('hex').slice(0, 16);
}

const STATUS_PRIORITY = { UNRESOLVED: 0, OPEN: 1, AMOUNT_MISMATCH: 2, SETTLED: 3 };

function worst(a, b) {
  return STATUS_PRIORITY[b] < STATUS_PRIORITY[a] ? b : a;
}

function suggestionCmp(a, b) {
  const ka = JSON.stringify([a.action, a.row || a.external || '', a.internal || '']);
  const kb = JSON.stringify([b.action, b.row || b.external || '', b.internal || '']);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function buildCluster(rows, match) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const memberKeys = rows.map((r) => r.key).sort();
  const members = rows
    .map((r) => {
      const st = match.state.get(r.key);
      const m = {
        key: r.key,
        kind: r.kind,
        id: r.id,
        amountCents: r.amountCents,
        tsMs: r.tsMs,
        state: st.status,
      };
      if (st.reason) m.reason = st.reason;
      return m;
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));

  let status = 'SETTLED';
  const reasons = new Set();
  const suggestions = [];
  for (const m of members) {
    if (m.state === 'UNRESOLVED') {
      status = worst(status, 'UNRESOLVED');
      reasons.add(m.reason);
      suggestions.push({ action: 'MANUAL_REVIEW', row: m.key, reason: m.reason });
    } else if (m.state === 'UNMATCHED_INTERNAL') {
      status = worst(status, 'OPEN');
      suggestions.push({
        action: 'REQUEST_RECEIPT_REUPLOAD',
        row: m.key,
        reason: 'internal ledger row has no matching bank receipt',
      });
    } else if (m.state === 'UNMATCHED_EXTERNAL') {
      status = worst(status, 'OPEN');
      suggestions.push({
        action: 'VERIFY_EXTERNAL_RECEIPT',
        row: m.key,
        reason: 'bank receipt has no matching internal ledger row',
      });
    }
  }
  for (const p of match.pairs) {
    if (p.amountDiffCents > 0) {
      status = worst(status, 'AMOUNT_MISMATCH');
      suggestions.push({
        action: 'CORRECT_AMOUNT',
        internal: p.internal,
        external: p.external,
        deltaCents: byKey.get(p.external).amountCents - byKey.get(p.internal).amountCents,
      });
    }
  }
  for (const g of match.groups) {
    if (g.amountDiffCents > 0) {
      status = worst(status, 'AMOUNT_MISMATCH');
      const internalSum = g.members.reduce((s, k) => s + byKey.get(k).amountCents, 0);
      suggestions.push({
        action: 'CORRECT_AMOUNT',
        external: g.external,
        members: g.members,
        deltaCents: byKey.get(g.external).amountCents - internalSum,
      });
    }
  }
  suggestions.sort(suggestionCmp);
  return {
    id: clusterId(memberKeys),
    status,
    memberKeys,
    members,
    reasons: [...reasons].sort(),
    matches: { pairs: match.pairs, groups: match.groups },
    suggestions,
  };
}

module.exports = { clusterId, buildCluster };
