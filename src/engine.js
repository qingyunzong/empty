import { MinHeap } from './heap.js';
import {
  buildCertificate,
  compareEvents,
  compareExpiry,
  comparePreempt,
  effectivePriority,
  makeQueueOrder,
} from './core.js';

export const ERR = {
  POOL_SHORT: 'POOL_SHORT',
  AUTH_EXPIRED: 'AUTH_EXPIRED',
  PREEMPT_FORBID: 'PREEMPT_FORBID',
  CAPTURED: 'CAPTURED',
  CARD_LIMIT: 'CARD_LIMIT',
  UNKNOWN_CARD: 'UNKNOWN_CARD',
  UNKNOWN_ID: 'UNKNOWN_ID',
  DUP_ID: 'DUP_ID',
  NOT_ACTIVE: 'NOT_ACTIVE',
  BAD_INPUT: 'BAD_INPUT',
};

// Slot semantics (deterministic):
//  1. Input events of the slot run in compareEvents order
//     (capture/revoke before auth, then priority desc, seq, id).
//  2. Auths whose expirySlot == slot expire at END of slot, so a capture
//     at the expiry slot still succeeds (boundary rule).
//  3. Queued requests whose expirySlot <= slot drop out of the queue.
//  4. If any hold was released during the slot, the wakeup cascade admits
//     queued requests in fair order (aged priority desc, seq, id), each
//     wake emitting a proof.
//  5. A no-overauth certificate is emitted for the slot.
export class Engine {
  constructor(config, { strategy = 'heap' } = {}) {
    if (strategy !== 'heap' && strategy !== 'naive') {
      throw new Error(`unknown strategy: ${strategy}`);
    }
    this.strategy = strategy;
    this.config = {
      pool: config.pool,
      agingK: config.agingK ?? 3,
      preemptWindow: config.preemptWindow ?? 2,
      cards: new Map(Object.entries(config.cards ?? {})),
    };
    this.auths = new Map(); // id -> auth record (any status)
    this.queue = []; // waiting requests (status === 'queued')
    this.heap = new MinHeap(compareExpiry);
    this.poolUsed = 0;
    this.cardUsed = new Map(); // card -> held amount
    this.timeline = [];
    this.violations = [];
    this.wakes = [];
    this.certificates = [];
    this.releasedThisSlot = [];
  }

  usedCard(card) {
    return this.cardUsed.get(card) ?? 0;
  }

  violation(slot, id, code, detail = {}) {
    this.violations.push({ slot, id, code, ...detail });
  }

  run(events) {
    const normalized = events.map((ev, i) => ({ ...ev, seq: i }));
    for (const ev of normalized) {
      if (!Number.isInteger(ev.slot) || ev.slot < 0) {
        this.violation(0, ev.id ?? '?', ERR.BAD_INPUT, { reason: 'bad-slot' });
        ev.slot = 0;
        ev.disabled = true;
      }
    }
    const active = normalized.filter((ev) => !ev.disabled).sort(compareEvents);
    const maxEventSlot = active.reduce((m, ev) => Math.max(m, ev.slot), 0);
    const maxExpiry = active.reduce((m, ev) => (ev.type === 'auth' ? Math.max(m, ev.expiry ?? 0) : m), 0);
    const maxSlot = Math.max(maxEventSlot, maxExpiry);

    let cursor = 0;
    for (let slot = 0; slot <= maxSlot; slot++) {
      this.releasedThisSlot = [];
      while (cursor < active.length && active[cursor].slot === slot) {
        this.processEvent(active[cursor], slot);
        cursor++;
      }
      this.processExpiries(slot);
      if (this.releasedThisSlot.length > 0) this.wakeupCascade(slot);
      this.expireQueued(slot);
      this.certificates.push(buildCertificate(slot, this.auths, this.config.cards, this.config.pool));
    }

    const finalSlot = maxSlot;
    const order = makeQueueOrder(finalSlot, this.config.agingK);
    const queue = [...this.queue].sort(order).map((r) => ({
      id: r.id,
      card: r.card,
      amount: r.amount,
      priority: r.priority,
      effectivePriority: effectivePriority(r, finalSlot, this.config.agingK),
      submitSlot: r.submitSlot,
      expirySlot: r.expirySlot,
      waited: finalSlot - r.submitSlot,
    }));
    return {
      timeline: this.timeline,
      violations: this.violations,
      wakes: this.wakes,
      queue,
      certificates: this.certificates,
    };
  }

  processEvent(ev, slot) {
    if (ev.type === 'auth') this.processAuth(ev, slot);
    else if (ev.type === 'capture') this.processCapture(ev, slot);
    else if (ev.type === 'revoke') this.processRevoke(ev, slot);
    else this.violation(slot, ev.id ?? '?', ERR.BAD_INPUT, { reason: `bad-type:${ev.type}` });
  }

  processAuth(ev, slot) {
    const { id, card, amount, priority, expiry } = ev;
    if (this.auths.has(id)) {
      this.violation(slot, id, ERR.DUP_ID);
      this.timeline.push({ slot, type: 'auth', id, result: 'rejected', reason: ERR.DUP_ID });
      return;
    }
    const limit = this.config.cards.get(card);
    if (limit === undefined) {
      this.violation(slot, id, ERR.UNKNOWN_CARD, { card });
      this.timeline.push({ slot, type: 'auth', id, result: 'rejected', reason: ERR.UNKNOWN_CARD });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || !Number.isInteger(priority) || !Number.isInteger(expiry) || expiry < slot) {
      this.violation(slot, id, ERR.BAD_INPUT, { reason: 'bad-auth-fields' });
      this.timeline.push({ slot, type: 'auth', id, result: 'rejected', reason: ERR.BAD_INPUT });
      return;
    }
    const req = {
      id, card, amount, priority,
      submitSlot: slot, expirySlot: expiry, seq: ev.seq, status: 'queued',
    };
    this.auths.set(id, req);
    // Per-card limit is a HARD constraint: reject, never queue.
    if (this.usedCard(card) + amount > limit) {
      this.violation(slot, id, ERR.CARD_LIMIT, { card, used: this.usedCard(card), limit, amount });
      this.timeline.push({ slot, type: 'auth', id, result: 'rejected', reason: ERR.CARD_LIMIT });
      return;
    }
    // Global pool is a SOFT constraint: admit, preempt, or queue.
    if (this.poolUsed + amount <= this.config.pool) {
      this.admit(req, slot, {});
      return;
    }
    this.tryPreemptOrQueue(req, slot);
  }

  tryPreemptOrQueue(req, slot) {
    const need = req.amount - (this.config.pool - this.poolUsed);
    const actives = [...this.auths.values()].filter((a) => a.status === 'active');
    // Preemption targets must be strictly lower priority (same-priority
    // earlier-expiring auths are protected) and expiring within the
    // preemption window. Captured auths are not active, hence untouchable.
    const eligible = actives
      .filter((a) => a.priority < req.priority && a.expirySlot - slot <= this.config.preemptWindow)
      .sort(comparePreempt);

    let freed = 0;
    const picked = [];
    for (const a of eligible) {
      if (freed >= need) break;
      picked.push(a);
      freed += a.amount;
    }

    if (freed >= need) {
      for (const a of picked) this.release(a, 'preempted', slot, { preemptedBy: req.id });
      this.admit(req, slot, { preempted: picked.map((a) => a.id) });
      return;
    }

    // Rollback: nothing was released, the request simply queues.
    this.queue.push(req);
    this.violation(slot, req.id, ERR.POOL_SHORT, {
      need,
      available: this.config.pool - this.poolUsed,
    });
    this.timeline.push({ slot, type: 'auth', id: req.id, result: 'queued', reason: ERR.POOL_SHORT });

    const blocked = actives
      .filter((a) => !eligible.includes(a))
      .map((a) => ({
        id: a.id,
        amount: a.amount,
        reason: a.priority >= req.priority ? 'same-or-higher-priority' : 'not-expiring-soon',
      }))
      .sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    const blockedSum = blocked.reduce((s, b) => s + b.amount, 0);
    if (blocked.length > 0 && freed + blockedSum >= need) {
      this.violation(slot, req.id, ERR.PREEMPT_FORBID, { targets: blocked });
    }
  }

  processCapture(ev, slot) {
    const a = this.auths.get(ev.id);
    if (!a) {
      this.violation(slot, ev.id, ERR.UNKNOWN_ID);
      return;
    }
    if (a.status === 'captured') {
      this.violation(slot, ev.id, ERR.CAPTURED);
      this.timeline.push({ slot, type: 'capture', id: ev.id, result: 'rejected', reason: ERR.CAPTURED });
      return;
    }
    if (a.status === 'expired') {
      this.violation(slot, ev.id, ERR.AUTH_EXPIRED);
      this.timeline.push({ slot, type: 'capture', id: ev.id, result: 'rejected', reason: ERR.AUTH_EXPIRED });
      return;
    }
    if (a.status !== 'active') {
      this.violation(slot, ev.id, ERR.NOT_ACTIVE, { status: a.status });
      this.timeline.push({ slot, type: 'capture', id: ev.id, result: 'rejected', reason: ERR.NOT_ACTIVE });
      return;
    }
    const amount = ev.amount ?? a.amount;
    if (!Number.isFinite(amount) || amount <= 0 || amount > a.amount) {
      this.violation(slot, ev.id, ERR.BAD_INPUT, { reason: 'bad-capture-amount' });
      return;
    }
    a.captureAmount = amount;
    this.release(a, 'captured', slot, { captureAmount: amount });
  }

  processRevoke(ev, slot) {
    const a = this.auths.get(ev.id);
    if (!a) {
      this.violation(slot, ev.id, ERR.UNKNOWN_ID);
      return;
    }
    if (a.status === 'captured') {
      this.violation(slot, ev.id, ERR.CAPTURED);
      this.timeline.push({ slot, type: 'revoke', id: ev.id, result: 'rejected', reason: ERR.CAPTURED });
      return;
    }
    if (a.status === 'expired') {
      this.violation(slot, ev.id, ERR.AUTH_EXPIRED);
      this.timeline.push({ slot, type: 'revoke', id: ev.id, result: 'rejected', reason: ERR.AUTH_EXPIRED });
      return;
    }
    if (a.status !== 'active') {
      this.violation(slot, ev.id, ERR.NOT_ACTIVE, { status: a.status });
      this.timeline.push({ slot, type: 'revoke', id: ev.id, result: 'rejected', reason: ERR.NOT_ACTIVE });
      return;
    }
    this.release(a, 'revoked', slot, {});
  }

  admit(req, slot, extra) {
    req.status = 'active';
    const qi = this.queue.indexOf(req);
    if (qi >= 0) this.queue.splice(qi, 1);
    this.poolUsed += req.amount;
    this.cardUsed.set(req.card, this.usedCard(req.card) + req.amount);
    this.heap.push(req);
    this.timeline.push({ slot, type: 'auth', id: req.id, result: 'admitted', ...extra });
  }

  release(auth, status, slot, extra) {
    auth.status = status;
    this.poolUsed -= auth.amount;
    this.cardUsed.set(auth.card, this.usedCard(auth.card) - auth.amount);
    this.releasedThisSlot.push(auth);
    this.timeline.push({ slot, type: status, id: auth.id, ...extra });
  }

  processExpiries(slot) {
    if (this.strategy === 'heap') {
      this.heap.discardWhile((a) => a.status !== 'active');
      while (this.heap.size > 0 && this.heap.peek().expirySlot <= slot) {
        const a = this.heap.pop();
        if (a.status !== 'active') continue;
        this.release(a, 'expired', slot, {});
      }
    } else {
      const due = [...this.auths.values()]
        .filter((a) => a.status === 'active' && a.expirySlot <= slot)
        .sort(compareExpiry);
      for (const a of due) this.release(a, 'expired', slot, {});
    }
  }

  expireQueued(slot) {
    for (const r of [...this.queue]) {
      if (r.expirySlot <= slot) {
        r.status = 'expired';
        this.queue.splice(this.queue.indexOf(r), 1);
        this.timeline.push({ slot, type: 'queue-expired', id: r.id });
      }
    }
  }

  // Cascading wakeup: freed capacity admits queued requests in fair order
  // (aged priority desc, seq, id). Every wake carries a verifiable proof
  // naming the releases that freed the capacity.
  wakeupCascade(slot) {
    const freedBy = this.releasedThisSlot.map((a) => a.id);
    const order = makeQueueOrder(slot, this.config.agingK);
    let progress = true;
    while (progress) {
      progress = false;
      for (const r of [...this.queue].sort(order)) {
        const limit = this.config.cards.get(r.card);
        if (this.usedCard(r.card) + r.amount > limit) continue;
        if (this.poolUsed + r.amount > this.config.pool) continue;
        const poolBefore = this.poolUsed;
        this.admit(r, slot, { woke: true });
        this.wakes.push({
          slot,
          woke: r.id,
          proof: {
            freedBy,
            effectivePriority: effectivePriority(r, slot, this.config.agingK),
            poolBefore,
            poolAfter: this.poolUsed,
            card: r.card,
            cardUsedAfter: this.usedCard(r.card),
          },
        });
        progress = true;
      }
    }
  }
}
