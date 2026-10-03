// Independent reference implementation of the preauth engine spec, written
// with plain arrays and linear scans (no heap, no shared code with
// src/engine.js). Used by the discrete-event enumeration tests to
// cross-check the optimized engine on small inputs (n <= 9).

const MAX_AGING = 2;

function effPrio(req, slot, k) {
  const waited = Math.max(0, slot - req.slot);
  return req.priority + Math.min(MAX_AGING, Math.floor(waited / k));
}

const idCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function runReference(config, events) {
  const poolLimit = config.pool ?? Infinity;
  const cardLimits = { ...(config.cards ?? {}) };
  const agingK = config.agingK ?? 2;
  const preemptWindow = config.preemptWindow ?? 2;

  const evs = events.map((e, i) => ({ ...e, seq: i }));
  const auths = new Map();
  const seenCards = new Set(); // every card ever frozen (engine keeps zero entries)
  const queue = [];
  const timeline = [];
  const violations = [];
  const certificates = [];

  const active = () => [...auths.values()].filter((a) => a.status === 'active');
  const poolFrozen = () => active().reduce((s, a) => s + a.amount, 0);
  const cardFrozen = (card) =>
    active().filter((a) => a.card === card).reduce((s, a) => s + a.amount, 0);

  function place(req, slot, quiet) {
    const limit = cardLimits[req.card];
    if (limit !== undefined && cardFrozen(req.card) + req.amount > limit) {
      if (!quiet) {
        violations.push({ slot, id: req.id, code: 'CARD_LIMIT', card: req.card });
        timeline.push({ slot, type: 'reject', id: req.id, code: 'CARD_LIMIT' });
      }
      return false;
    }
    const prio = effPrio(req, slot, agingK);
    if (poolLimit - poolFrozen() >= req.amount) {
      req.status = 'active';
      seenCards.add(req.card);
      timeline.push({
        slot, type: 'auth', id: req.id, card: req.card, amount: req.amount,
        priority: prio, expires: req.expires,
      });
      return true;
    }
    const shortfall = req.amount - (poolLimit - poolFrozen());
    const victims = active()
      .filter((a) => a.priority < prio && a.expires - slot <= preemptWindow)
      .sort((x, y) =>
        x.priority - y.priority || x.expires - y.expires ||
        x.seq - y.seq || idCmp(x.id, y.id));
    const plan = [];
    let covered = 0;
    for (const v of victims) {
      plan.push(v);
      covered += v.amount;
      if (covered >= shortfall) break;
    }
    if (plan.length > 0 && covered >= shortfall) {
      for (const v of plan) {
        v.status = 'preempted';
        timeline.push({ slot, type: 'preempt', id: v.id, by: req.id });
      }
      req.status = 'active';
      seenCards.add(req.card);
      timeline.push({
        slot, type: 'auth', id: req.id, card: req.card, amount: req.amount,
        priority: prio, expires: req.expires,
      });
      return true;
    }
    if (!quiet) {
      violations.push({ slot, id: req.id, code: 'POOL_SHORT', shortfall });
      const blockers = active().filter(
        (a) => a.priority >= prio || a.expires - slot > preemptWindow);
      if (blockers.reduce((s, a) => s + a.amount, 0) >= shortfall) {
        violations.push({
          slot, id: req.id, code: 'PREEMPT_FORBID',
          blockers: blockers.map((a) => a.id).sort(),
        });
      }
      req.status = 'queued';
      queue.push(req);
      timeline.push({ slot, type: 'queue', id: req.id, shortfall });
    }
    return false;
  }

  function drain(slot, trigger) {
    const woke = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].expires <= slot) {
        const [stale] = queue.splice(i, 1);
        stale.status = 'expired';
        timeline.push({ slot, type: 'expire', id: stale.id, queued: true });
      }
    }
    for (;;) {
      queue.sort((x, y) =>
        effPrio(y, slot, agingK) - effPrio(x, slot, agingK) ||
        x.seq - y.seq || idCmp(x.id, y.id));
      let any = false;
      for (let i = 0; i < queue.length; i++) {
        if (place(queue[i], slot, true)) {
          woke.push(queue[i].id);
          queue.splice(i, 1);
          any = true;
          break;
        }
      }
      if (!any) break;
    }
    if (woke.length > 0) {
      const cards = {};
      for (const card of seenCards) cards[card] = cardFrozen(card);
      timeline.push({
        slot, type: 'wake', trigger, woke,
        proof: { woke, poolFrozen: poolFrozen(), poolLimit, cardFrozen: cards },
      });
    }
  }

  function certificate(slot) {
    const act = active()
      .map((a) => ({
        id: a.id, card: a.card, amount: a.amount,
        priority: a.priority, expires: a.expires,
      }))
      .sort((x, y) => idCmp(x.id, y.id));
    const cards = {};
    for (const card of Object.keys(cardLimits)) {
      cards[card] = { frozen: cardFrozen(card), limit: cardLimits[card] };
    }
    for (const card of seenCards) {
      if (!cards[card]) cards[card] = { frozen: cardFrozen(card), limit: null };
    }
    const cert = { slot, pool: { frozen: poolFrozen(), limit: poolLimit }, cards, active: act };
    cert.ok = true; // recomputed by the test via verifyCertificate
    return cert;
  }

  const slots = [...new Set(evs.map((e) => e.slot))].sort((a, b) => a - b);
  let lastSlot = 0;
  for (const slot of slots) {
    lastSlot = slot;
    // expiries in (expires, seq, id) order
    const expiring = active()
      .filter((a) => a.expires <= slot)
      .sort((x, y) => x.expires - y.expires || x.seq - y.seq || idCmp(x.id, y.id));
    for (const a of expiring) {
      a.status = 'expired';
      timeline.push({ slot, type: 'expire', id: a.id });
    }
    drain(slot, { type: 'expire', slot });
    const ordered = evs
      .filter((e) => e.slot === slot)
      .sort((x, y) =>
        (y.priority ?? 1e9) - (x.priority ?? 1e9) ||
        x.seq - y.seq || idCmp(x.id ?? '', y.id ?? ''));
    for (const ev of ordered) {
      if (ev.type === 'auth') {
        const req = {
          id: ev.id, card: ev.card, amount: ev.amount,
          priority: ev.priority ?? 0, seq: ev.seq, slot,
          expires: ev.expires, status: 'new',
        };
        if (auths.has(req.id)) {
          violations.push({ slot, id: req.id, code: 'DUPLICATE' });
          continue;
        }
        auths.set(req.id, req);
        if (!(req.amount > 0) || !(req.expires > slot)) {
          req.status = 'rejected';
          violations.push({ slot, id: req.id, code: 'AUTH_EXPIRED' });
          timeline.push({ slot, type: 'reject', id: req.id, code: 'AUTH_EXPIRED' });
          continue;
        }
        place(req, slot, false);
      } else if (ev.type === 'capture' || ev.type === 'revoke') {
        const a = auths.get(ev.id);
        if (!a) {
          violations.push({ slot, id: ev.id, code: 'UNKNOWN_AUTH' });
          continue;
        }
        if (a.status === 'captured') {
          violations.push({ slot, id: ev.id, code: 'CAPTURED' });
          continue;
        }
        if (a.status !== 'active') {
          violations.push({ slot, id: ev.id, code: 'AUTH_EXPIRED', status: a.status });
          continue;
        }
        if (ev.type === 'capture') {
          const amount = Math.min(ev.amount ?? a.amount, a.amount);
          a.status = 'captured';
          a.capturedAmount = amount;
          timeline.push({ slot, type: 'capture', id: a.id, amount, released: a.amount - amount });
          drain(slot, { type: 'capture', id: a.id });
        } else {
          a.status = 'revoked';
          timeline.push({ slot, type: 'revoke', id: a.id });
          drain(slot, { type: 'revoke', id: a.id });
        }
      } else {
        violations.push({ slot, id: ev.id, code: 'UNKNOWN_EVENT' });
      }
    }
    certificates.push(certificate(slot));
  }

  return {
    timeline,
    violations,
    certificates,
    queue: queue.map((q) => ({
      id: q.id, card: q.card, amount: q.amount, basePriority: q.priority,
      effectivePriority: effPrio(q, lastSlot, agingK), waited: lastSlot - q.slot,
    })),
  };
}
