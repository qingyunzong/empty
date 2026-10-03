import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted recursively, arrays keep order.
// Gives a stable byte representation so digests are deterministic.
export function canonical(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function digestOf(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// Aging: a request waiting in the queue gains +1 priority every `agingK`
// slots of waiting, capped at +2 levels total.
export const MAX_AGING_BOOST = 2;

export function effectivePriority(req, slot, agingK) {
  const waited = Math.max(0, slot - req.submitSlot);
  const boost = Math.min(MAX_AGING_BOOST, Math.floor(waited / agingK));
  return req.priority + boost;
}

// Total order for the expiry heap: earliest expiry first; ties broken by
// lower priority, then submission sequence, then id.
export function compareExpiry(a, b) {
  return (
    a.expirySlot - b.expirySlot ||
    a.priority - b.priority ||
    a.seq - b.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// Total order for preemption candidates: lowest priority first, then
// soonest expiry, then submission sequence, then id.
export function comparePreempt(a, b) {
  return (
    a.priority - b.priority ||
    a.expirySlot - b.expirySlot ||
    a.seq - b.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// Total order for the waiting queue at a given slot: highest effective
// (aged) priority first, then submission sequence, then id.
export function makeQueueOrder(slot, agingK) {
  return (a, b) =>
    effectivePriority(b, slot, agingK) - effectivePriority(a, slot, agingK) ||
    a.seq - b.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// Deterministic order of input events inside one slot: captures/revokes
// before new auths, then higher priority, then submission sequence, then id.
const TYPE_RANK = { capture: 0, revoke: 0, auth: 1 };

export function compareEvents(a, b) {
  return (
    a.slot - b.slot ||
    TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
    (b.priority ?? -1) - (a.priority ?? -1) ||
    a.seq - b.seq ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

// Build the per-slot no-overauth certificate. The certificate is
// self-contained: a verifier only needs `active` plus the limits to
// recompute every sum and the digest.
export function buildCertificate(slot, auths, cardLimits, poolCap) {
  const active = [...auths.values()]
    .filter((a) => a.status === 'active')
    .map((a) => ({ id: a.id, card: a.card, amount: a.amount, priority: a.priority, expiry: a.expirySlot }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const cards = {};
  for (const [card, limit] of [...cardLimits.entries()].sort()) {
    const used = active.filter((a) => a.card === card).reduce((s, a) => s + a.amount, 0);
    cards[card] = { used, limit, ok: used <= limit };
  }
  const poolUsed = active.reduce((s, a) => s + a.amount, 0);
  const pool = { used: poolUsed, cap: poolCap, ok: poolUsed <= poolCap };

  const body = { slot, pool, cards, active };
  return { ...body, digest: digestOf(body) };
}

// Verify a certificate: (1) integrity — the digest must match the cert's own
// body, detecting any tampering; (2) soundness — sums recomputed from the
// `active` list must equal the claimed usage and respect every limit.
export function verifyCertificate(cert) {
  const body = { slot: cert.slot, pool: cert.pool, cards: cert.cards, active: cert.active };
  if (digestOf(body) !== cert.digest) return false;
  const poolUsed = cert.active.reduce((s, a) => s + a.amount, 0);
  if (poolUsed !== cert.pool.used || poolUsed > cert.pool.cap) return false;
  for (const [card, c] of Object.entries(cert.cards)) {
    const used = cert.active.filter((a) => a.card === card).reduce((s, a) => s + a.amount, 0);
    if (used !== c.used || used > c.limit) return false;
  }
  return cert.active.every((a) => cert.cards[a.card] !== undefined);
}
