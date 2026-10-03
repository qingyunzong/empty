// Preauthorization pool engine.
//
// Model
// -----
// * A preauth request freezes `amount` on a card until it is captured or it
//   expires at its expiry slot (an auth with expires = s is valid for slots
//   < s and is expired at the start of slot s).
// * Per-card limits are HARD constraints: a request that would exceed the
//   remaining card limit is rejected immediately (CARD_LIMIT), never queued.
// * The global pool is a SOFT constraint: when the pool is short, a request
//   may preempt lower-priority, soon-to-expire active auths; if that cannot
//   cover the shortfall the request is queued (POOL_SHORT).
// * Preemption is atomic: the victim set is planned first and only applied
//   when it covers the shortfall, otherwise nothing is touched (rollback).
//   Captured auths and same/higher-priority auths can never be preempted
//   (PREEMPT_FORBID is reported when they block a placement).
// * Aging: a queued request gains +1 effective priority per `agingK` slots
//   waited, capped at +2. Starvation bound: after 2*agingK slots a queued
//   request can only be outranked by requests whose base priority is more
//   than 2 levels higher.
//
// Determinism
// -----------
// Slots are processed ascending. Inside a slot: expiries first (heap order),
// then a queue drain, then events ordered by (priority desc, submit seq,
// id), with a queue drain after every fund-releasing event (capture/revoke).

import { MinHeap } from './heap.js';

export const ERR = Object.freeze({
  POOL_SHORT: 'POOL_SHORT',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  PREEMPT_FORBID: 'PREEMPT_FORBID',
  CAPTURED: 'CAPTURED',
  CARD_LIMIT: 'CARD_LIMIT',
  UNKNOWN_AUTH: 'UNKNOWN_AUTH',
});

export const MAX_AGING = 2;
const NO_PRIORITY = 1e9; // events without a priority sort first within a slot

const idCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const expiryCmp = (x, y) =>
  x.expires - y.expires || x.seq - y.seq || idCmp(x.id, y.id);

export function effectivePriority(req, slot, agingK) {
  const waited = Math.max(0, slot - req.slot);
  return req.priority + Math.min(MAX_AGING, Math.floor(waited / agingK));
}

// Independent check of a no-overcommit certificate: recomputes frozen sums
// from the listed active auths and verifies every hard/soft limit.
export function verifyCertificate(cert) {
  const errors = [];
  let poolSum = 0;
  const perCard = new Map();
  for (const a of cert.active) {
    poolSum += a.amount;
    perCard.set(a.card, (perCard.get(a.card) ?? 0) + a.amount);
    if (a.expires <= cert.slot) {
      errors.push(`active auth ${a.id} already expired at slot ${cert.slot}`);
    }
  }
  if (poolSum !== cert.pool.frozen) {
    errors.push(`pool frozen ${cert.pool.frozen} != active sum ${poolSum}`);
  }
  if (Number.isFinite(cert.pool.limit) && poolSum > cert.pool.limit) {
    errors.push(`pool overcommit: ${poolSum} > ${cert.pool.limit}`);
  }
  for (const [card, frozen] of perCard) {
    const entry = cert.cards[card];
    if (!entry || entry.frozen !== frozen) {
      errors.push(`card ${card} frozen mismatch`);
    }
    if (entry && Number.isFinite(entry.limit) && frozen > entry.limit) {
      errors.push(`card ${card} overcommit: ${frozen} > ${entry.limit}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createEngine(config = {}) {
  const poolLimit = config.pool ?? Infinity;
  const cardLimits = { ...(config.cards ?? {}) };
  const agingK = config.agingK ?? 2;
  const preemptWindow = config.preemptWindow ?? 2;

  const auths = new Map(); // id -> auth record
  const heap = new MinHeap(expiryCmp); // lazy: non-active entries skipped
  const cardFrozen = new Map();
  const queue = [];
  const timeline = [];
  const violations = [];
  const certificates = [];
  let poolFrozen = 0;
  let lastSlot = 0;

  const frozenOf = (card) => cardFrozen.get(card) ?? 0;
  const activeAuths = () =>
    [...auths.values()].filter((a) => a.status === 'active');

  function freeze(auth) {
    auth.status = 'active';
    poolFrozen += auth.amount;
    cardFrozen.set(auth.card, frozenOf(auth.card) + auth.amount);
    heap.push(auth);
  }

  function release(auth) {
    poolFrozen -= auth.amount;
    cardFrozen.set(auth.card, frozenOf(auth.card) - auth.amount);
  }

  // Attempt to place a request now. Returns {placed, hard?}. When `quiet`
  // is set no violations/timeline entries are emitted (queue drain retries).
  function tryPlace(req, slot, { quiet = false } = {}) {
    const limit = cardLimits[req.card];
    if (limit !== undefined && frozenOf(req.card) + req.amount > limit) {
      if (!quiet) {
        violations.push({ slot, id: req.id, code: ERR.CARD_LIMIT, card: req.card });
        timeline.push({ slot, type: 'reject', id: req.id, code: ERR.CARD_LIMIT });
      }
      return { placed: false, hard: true };
    }
    const prio = effectivePriority(req, slot, agingK);
    if (poolLimit - poolFrozen >= req.amount) {
      freeze(req);
      timeline.push({
        slot, type: 'auth', id: req.id, card: req.card,
        amount: req.amount, priority: prio, expires: req.expires,
      });
      return { placed: true };
    }
    const shortfall = req.amount - (poolLimit - poolFrozen);
    // Plan the preemption: lowest priority first, then soonest expiry.
    const candidates = activeAuths()
      .filter((a) => a.priority < prio && a.expires - slot <= preemptWindow)
      .sort((x, y) =>
        x.priority - y.priority || x.expires - y.expires ||
        x.seq - y.seq || idCmp(x.id, y.id));
    const plan = [];
    let covered = 0;
    for (const victim of candidates) {
      plan.push(victim);
      covered += victim.amount;
      if (covered >= shortfall) break;
    }
    if (covered >= shortfall && plan.length > 0) {
      for (const victim of plan) {
        victim.status = 'preempted';
        release(victim);
        timeline.push({ slot, type: 'preempt', id: victim.id, by: req.id });
      }
      freeze(req);
      timeline.push({
        slot, type: 'auth', id: req.id, card: req.card,
        amount: req.amount, priority: prio, expires: req.expires,
      });
      return { placed: true };
    }
    // Rollback: the plan was never applied, state is untouched.
    if (!quiet) {
      violations.push({ slot, id: req.id, code: ERR.POOL_SHORT, shortfall });
      const blockers = activeAuths().filter(
        (a) => a.priority >= prio || a.expires - slot > preemptWindow);
      if (blockers.reduce((s, a) => s + a.amount, 0) >= shortfall) {
        violations.push({
          slot, id: req.id, code: ERR.PREEMPT_FORBID,
          blockers: blockers.map((a) => a.id).sort(),
        });
      }
      req.status = 'queued';
      queue.push(req);
      timeline.push({ slot, type: 'queue', id: req.id, shortfall });
    }
    return { placed: false };
  }

  // Fair queue drain: highest effective priority first, then submit seq, id.
  // Emits a wake entry carrying the wake proof when anything is placed.
  function drainQueue(slot, trigger) {
    const woke = [];
    // Queued requests whose expiry has passed are dropped, never placed.
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].expires <= slot) {
        const [stale] = queue.splice(i, 1);
        stale.status = 'expired';
        timeline.push({ slot, type: 'expire', id: stale.id, queued: true });
      }
    }
    for (;;) {
      queue.sort((x, y) =>
        effectivePriority(y, slot, agingK) - effectivePriority(x, slot, agingK) ||
        x.seq - y.seq || idCmp(x.id, y.id));
      let placedAny = false;
      for (let i = 0; i < queue.length; i++) {
        if (tryPlace(queue[i], slot, { quiet: true }).placed) {
          woke.push(queue[i].id);
          queue.splice(i, 1);
          placedAny = true;
          break; // re-sort after every placement
        }
      }
      if (!placedAny) break;
    }
    if (woke.length > 0) {
      timeline.push({
        slot, type: 'wake', trigger, woke,
        proof: {
          woke,
          poolFrozen,
          poolLimit,
          cardFrozen: Object.fromEntries(cardFrozen),
        },
      });
    }
  }

  function expireSlot(slot) {
    while (heap.size > 0 && heap.peek().expires <= slot) {
      const auth = heap.pop();
      if (auth.status !== 'active') continue; // lazy deletion
      auth.status = 'expired';
      release(auth);
      timeline.push({ slot, type: 'expire', id: auth.id });
    }
  }

  function handleAuth(ev, slot) {
    const req = {
      id: ev.id, card: ev.card, amount: ev.amount,
      priority: ev.priority ?? 0, seq: ev.seq, slot,
      expires: ev.expires, status: 'new',
    };
    if (auths.has(req.id)) {
      violations.push({ slot, id: req.id, code: 'DUPLICATE' });
      return;
    }
    auths.set(req.id, req);
    if (!(req.amount > 0) || !(req.expires > slot)) {
      req.status = 'rejected';
      violations.push({ slot, id: req.id, code: ERR.AUTH_EXPIRED });
      timeline.push({ slot, type: 'reject', id: req.id, code: ERR.AUTH_EXPIRED });
      return;
    }
    tryPlace(req, slot);
  }

  function handleCapture(ev, slot) {
    const auth = auths.get(ev.id);
    if (!auth) {
      violations.push({ slot, id: ev.id, code: ERR.UNKNOWN_AUTH });
      return;
    }
    if (auth.status === 'captured') {
      violations.push({ slot, id: ev.id, code: ERR.CAPTURED });
      return;
    }
    if (auth.status !== 'active') {
      violations.push({ slot, id: ev.id, code: ERR.AUTH_EXPIRED, status: auth.status });
      return;
    }
    const amount = Math.min(ev.amount ?? auth.amount, auth.amount);
    auth.status = 'captured';
    auth.capturedAmount = amount;
    release(auth); // frozen funds leave the pool; captured part settles
    timeline.push({ slot, type: 'capture', id: auth.id, amount, released: auth.amount - amount });
    drainQueue(slot, { type: 'capture', id: auth.id });
  }

  function handleRevoke(ev, slot) {
    const auth = auths.get(ev.id);
    if (!auth) {
      violations.push({ slot, id: ev.id, code: ERR.UNKNOWN_AUTH });
      return;
    }
    if (auth.status === 'captured') {
      violations.push({ slot, id: ev.id, code: ERR.CAPTURED });
      return;
    }
    if (auth.status !== 'active') {
      violations.push({ slot, id: ev.id, code: ERR.AUTH_EXPIRED, status: auth.status });
      return;
    }
    auth.status = 'revoked';
    release(auth);
    timeline.push({ slot, type: 'revoke', id: auth.id });
    drainQueue(slot, { type: 'revoke', id: auth.id }); // cascading wake + proof
  }

  function makeCertificate(slot) {
    const active = activeAuths()
      .map((a) => ({
        id: a.id, card: a.card, amount: a.amount,
        priority: a.priority, expires: a.expires,
      }))
      .sort((x, y) => idCmp(x.id, y.id));
    const cards = {};
    for (const card of Object.keys(cardLimits)) {
      cards[card] = { frozen: frozenOf(card), limit: cardLimits[card] };
    }
    for (const [card, frozen] of cardFrozen) {
      if (!cards[card]) cards[card] = { frozen, limit: null };
    }
    const cert = { slot, pool: { frozen: poolFrozen, limit: poolLimit }, cards, active };
    cert.ok = verifyCertificate(cert).ok;
    return cert;
  }

  function run(events) {
    const evs = events.map((e, i) => ({ ...e, seq: i }));
    const bySlot = new Map();
    for (const ev of evs) {
      if (!bySlot.has(ev.slot)) bySlot.set(ev.slot, []);
      bySlot.get(ev.slot).push(ev);
    }
    for (const slot of [...bySlot.keys()].sort((a, b) => a - b)) {
      lastSlot = slot;
      expireSlot(slot);
      drainQueue(slot, { type: 'expire', slot });
      const ordered = bySlot.get(slot).sort((x, y) =>
        (y.priority ?? NO_PRIORITY) - (x.priority ?? NO_PRIORITY) ||
        x.seq - y.seq || idCmp(x.id ?? '', y.id ?? ''));
      for (const ev of ordered) {
        if (ev.type === 'auth') handleAuth(ev, slot);
        else if (ev.type === 'capture') handleCapture(ev, slot);
        else if (ev.type === 'revoke') handleRevoke(ev, slot);
        else violations.push({ slot, id: ev.id, code: 'UNKNOWN_EVENT' });
      }
      certificates.push(makeCertificate(slot));
    }
    return {
      timeline,
      violations,
      certificates,
      queue: queue.map((q) => ({
        id: q.id, card: q.card, amount: q.amount,
        basePriority: q.priority,
        effectivePriority: effectivePriority(q, lastSlot, agingK),
        waited: lastSlot - q.slot,
      })),
    };
  }

  return { run, config: { poolLimit, cardLimits, agingK, preemptWindow } };
}
