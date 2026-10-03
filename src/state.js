import { createHash } from 'node:crypto';

const TYPE_RANK = { release: 0, freeze: 1 }; // equal ts+priority: freeze wins

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function compareDecision(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  const pa = a.priority ?? 0;
  const pb = b.priority ?? 0;
  if (pa !== pb) return pa - pb;
  const ra = TYPE_RANK[a.type] ?? 0;
  const rb = TYPE_RANK[b.type] ?? 0;
  if (ra !== rb) return ra - rb;
  return a.seq - b.seq;
}

export class GateState {
  constructor(config) {
    this.config = config;
    this.journal = [];
    this.compensations = [];
    this.breaches = [];
    this.prevEffective = {};
    this.openMaterialBreach = new Set();
    this.derived = { effective: {}, locks: {}, available: { ...config.materials }, resched: {} };
  }

  static replay(config, events, upto = events.length) {
    const state = new GateState(config);
    for (let i = 0; i < upto; i++) state.apply(events[i]);
    return state;
  }

  orderById(id) {
    return this.config.orders.find((o) => o.id === id);
  }

  permissionFor(order) {
    const perms = this.config.policy.permissions ?? {};
    return (
      perms.workOrders?.[order.id] ??
      perms.workCenters?.[order.workCenter] ??
      perms.productLines?.[order.productLine] ??
      this.config.policy.defaultPermission ??
      'allow'
    );
  }

  actorRank(actor) {
    return this.config.policy.actors?.[actor] ?? 0;
  }

  supervisorRank() {
    return this.config.policy.supervisorRank ?? 2;
  }

  apply(ev) {
    if (!this.orderById(ev.orderId)) {
      this.breaches.push({ type: 'unknown-order', seq: ev.seq, orderId: ev.orderId });
    }
    if (ev.type === 'revoke') {
      if (this.actorRank(ev.actor) < this.supervisorRank()) {
        this.breaches.push({ type: 'unauthorized-revoke', seq: ev.seq, orderId: ev.orderId, actor: ev.actor });
      }
      const eff = this.derived.effective[ev.orderId];
      if (!eff || eff.type !== 'freeze') {
        this.breaches.push({ type: 'revoke-without-freeze', seq: ev.seq, orderId: ev.orderId });
      }
    }
    this.journal.push(ev);
    this.recompute();
  }

  recompute() {
    const perOrder = new Map();
    for (const ev of this.journal) {
      const arr = perOrder.get(ev.orderId) ?? [];
      arr.push(ev);
      perOrder.set(ev.orderId, arr);
    }
    const effective = {};
    const resched = {};
    for (const [orderId, evs] of perOrder) {
      const active = [];
      for (const ev of evs) {
        if (ev.type === 'release' || ev.type === 'freeze') {
          active.push(ev);
        } else if (ev.type === 'revoke') {
          if (this.actorRank(ev.actor) >= this.supervisorRank()) {
            for (let i = active.length - 1; i >= 0; i--) {
              if (active[i].type === 'freeze') {
                active.splice(i, 1);
                break;
              }
            }
          }
        } else if (ev.type === 'reschedule') {
          resched[orderId] = ev.toShift;
        }
      }
      if (active.length > 0) {
        let best = active[0];
        for (const ev of active) if (compareDecision(ev, best) > 0) best = ev;
        effective[orderId] = best;
      }
    }
    // compensation events: a release that consumed locks is overridden (append-only, history untouched)
    const lastSeq = this.journal.length > 0 ? this.journal[this.journal.length - 1].seq : 0;
    for (const [orderId, eff] of Object.entries(effective)) {
      const prev = this.prevEffective[orderId];
      if (prev && prev.type === 'release' && eff.type !== 'release') {
        const order = this.orderById(orderId);
        this.compensations.push({
          type: 'compensate',
          orderId,
          locks: order?.materials ?? {},
          reason: `release overridden by ${eff.type} (seq ${eff.seq})`,
          atSeq: lastSeq,
        });
      }
    }
    this.prevEffective = effective;
    // material locks, allocated in deterministic order
    const available = { ...this.config.materials };
    const locks = {};
    const releasedIds = Object.keys(effective)
      .filter((id) => effective[id].type === 'release')
      .sort();
    for (const id of releasedIds) {
      const order = this.orderById(id);
      if (!order) continue;
      const need = order.materials ?? {};
      const ok = Object.entries(need).every(([m, q]) => (available[m] ?? 0) >= q);
      if (ok) {
        for (const [m, q] of Object.entries(need)) available[m] -= q;
        locks[id] = { ...need };
        if (this.openMaterialBreach.delete(id)) {
          this.breaches.push({ type: 'material-restored', orderId: id, atSeq: lastSeq });
        }
      } else if (!this.openMaterialBreach.has(id)) {
        this.openMaterialBreach.add(id);
        this.breaches.push({ type: 'material-insufficient', orderId: id, atSeq: lastSeq });
      }
    }
    this.derived = { effective, locks, available, resched };
  }

  isReleasable(orderId) {
    const order = this.orderById(orderId);
    if (!order) return false;
    if (this.permissionFor(order) !== 'allow') return false;
    const eff = this.derived.effective[orderId];
    return Boolean(eff) && eff.type === 'release' && Boolean(this.derived.locks[orderId]);
  }

  snapshotData() {
    return {
      derived: this.derived,
      compensations: this.compensations,
      breaches: this.breaches,
      openMaterialBreach: [...this.openMaterialBreach].sort(),
    };
  }

  hash() {
    return createHash('sha256').update(stableStringify(this.snapshotData())).digest('hex');
  }
}
