const EXACT_MAX_CANDIDATES = 10;
const EXACT_MAX_LENDERS = 5;

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpStrArray(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpStr(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

export function canonicalEntries(entries) {
  return entries
    .map((e) => [e.lender, e.order, e.amount])
    .sort((x, y) => cmpStrArray([x[0], x[1]], [y[0], y[1]]) || x[2] - y[2]);
}

export function comparePlans(a, b) {
  if (a.units !== b.units) return b.units - a.units;
  const idCmp = cmpStrArray(a.ids, b.ids);
  if (idCmp !== 0) return idCmp;
  const ea = canonicalEntries(a.entries);
  const eb = canonicalEntries(b.entries);
  const n = Math.min(ea.length, eb.length);
  for (let i = 0; i < n; i += 1) {
    const c = cmpStrArray([ea[i][0], ea[i][1]], [eb[i][0], eb[i][1]]);
    if (c !== 0) return c;
    if (ea[i][2] !== eb[i][2]) return ea[i][2] - eb[i][2];
  }
  return ea.length - eb.length;
}

export function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  for (let i = 0; i < arr.length; i += 1) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

export class Scheduler {
  constructor({ tree, orders, starveThreshold = 3 }) {
    this.nodes = tree.nodes;
    this.rootId = tree.rootId;
    this.paths = tree.paths;
    this.ancestors = tree.ancestors;
    this.starveThreshold = starveThreshold;
    this.orders = orders.map((o) => ({ ...o, active: 0 }));
    this.orderById = new Map(this.orders.map((o) => [o.id, o]));
    this.borrows = [];
    this.borrowEvents = [];
    this.preemptions = [];
    this.reclaims = [];
    this.time = 0;
  }

  effLimit(id) {
    const node = this.nodes.get(id);
    return node.baseLimit - node.lentOut + node.borrowedIn;
  }

  remaining(order) {
    return order.units - order.active;
  }

  reservedMap(time) {
    const reserved = new Map();
    for (const order of this.orders) {
      if (order.tenant === this.rootId) continue;
      const remaining = this.remaining(order);
      if (remaining <= 0) continue;
      if (order.submit > time) continue;
      if (time - order.submit < this.starveThreshold) continue;
      reserved.set(order.tenant, (reserved.get(order.tenant) || 0) + remaining);
    }
    for (const [tenant, demand] of reserved) {
      const node = this.nodes.get(tenant);
      const raw = Math.max(0, node.guarantee - node.lentOut - node.used);
      reserved.set(tenant, Math.min(raw, demand));
    }
    return reserved;
  }

  lendable(id, reserved, lentDelta, usedDelta) {
    const node = this.nodes.get(id);
    return (
      node.guarantee
      - node.lentOut - (lentDelta.get(id) || 0)
      - node.used - (usedDelta.get(id) || 0)
      - (reserved.get(id) || 0)
    );
  }

  simulate(orderIds, lenderPerm, reserved) {
    const usedDelta = new Map();
    const lentDelta = new Map();
    const borrowedDelta = new Map();
    const entries = [];
    const scheduled = [];
    let units = 0;
    const eff = (id) => {
      const node = this.nodes.get(id);
      return node.baseLimit - node.lentOut - (lentDelta.get(id) || 0)
        + node.borrowedIn + (borrowedDelta.get(id) || 0);
    };
    const usedOf = (id) => this.nodes.get(id).used + (usedDelta.get(id) || 0);

    for (const oid of orderIds) {
      const order = this.orderById.get(oid);
      const needUnits = this.remaining(order);
      const path = this.paths.get(order.tenant);
      const ownSlack = eff(order.tenant) - usedOf(order.tenant);
      let pathSlack = Infinity;
      for (const nodeId of path) {
        if (nodeId === order.tenant) continue;
        pathSlack = Math.min(pathSlack, eff(nodeId) - usedOf(nodeId));
      }
      let need = 0;
      if (needUnits > Math.min(ownSlack, pathSlack)) {
        if (pathSlack < needUnits || order.tenant === this.rootId) return null;
        need = needUnits - ownSlack;
      }
      if (need > 0) {
        for (const lenderId of lenderPerm) {
          if (need <= 0) break;
          if (lenderId === order.tenant) continue;
          if (this.ancestors.get(order.tenant).has(lenderId)) continue;
          const avail = this.lendable(lenderId, reserved, lentDelta, usedDelta);
          if (avail <= 0) continue;
          const take = Math.min(need, avail);
          entries.push({ lender: lenderId, order: oid, amount: take });
          lentDelta.set(lenderId, (lentDelta.get(lenderId) || 0) + take);
          borrowedDelta.set(order.tenant, (borrowedDelta.get(order.tenant) || 0) + take);
          need -= take;
        }
        if (need > 0) return null;
      }
      scheduled.push(oid);
      units += needUnits;
      for (const nodeId of path) {
        usedDelta.set(nodeId, (usedDelta.get(nodeId) || 0) + needUnits);
      }
    }
    return { scheduled, entries, units };
  }

  exactSearch(candidateIds, lenders, reserved) {
    const perms = permutations(lenders);
    let best = null;
    const n = candidateIds.length;
    const total = 1 << n;
    for (let mask = 1; mask < total; mask += 1) {
      const subset = [];
      for (let i = 0; i < n; i += 1) {
        if (mask & (1 << i)) subset.push(candidateIds[i]);
      }
      for (const perm of perms) {
        const res = this.simulate(subset, perm, reserved);
        if (!res) continue;
        const plan = {
          units: res.units,
          ids: res.scheduled.slice().sort(),
          entries: res.entries,
          scheduled: res.scheduled,
        };
        if (!best || comparePlans(plan, best) < 0) best = plan;
      }
    }
    return best;
  }

  applyPlan(plan, time) {
    const events = [];
    const byOrder = new Map();
    for (const entry of plan.entries) {
      if (!byOrder.has(entry.order)) byOrder.set(entry.order, []);
      byOrder.get(entry.order).push(entry);
    }
    for (const oid of plan.scheduled) {
      const order = this.orderById.get(oid);
      const amount = this.remaining(order);
      for (const entry of byOrder.get(oid) || []) {
        this.borrows.push({
          lender: entry.lender,
          borrower: order.tenant,
          order: oid,
          amount: entry.amount,
          time,
        });
        this.nodes.get(entry.lender).lentOut += entry.amount;
        this.nodes.get(order.tenant).borrowedIn += entry.amount;
        const event = { time, lender: entry.lender, borrower: order.tenant, order: oid, amount: entry.amount };
        this.borrowEvents.push(event);
        events.push(event);
      }
      order.active = order.units;
      for (const nodeId of this.paths.get(order.tenant)) {
        this.nodes.get(nodeId).used += amount;
      }
    }
    return { scheduled: plan.scheduled.slice(), borrowEvents: events };
  }

  greedyPass(candidateIds, lenders, reserved, time) {
    const sorted = candidateIds.slice().sort((a, b) => {
      const oa = this.orderById.get(a);
      const ob = this.orderById.get(b);
      return oa.submit - ob.submit || cmpStr(a, b);
    });
    const scheduled = [];
    const events = [];
    for (const oid of sorted) {
      const res = this.simulate([oid], lenders, reserved);
      if (!res) continue;
      const applied = this.applyPlan(res, time);
      scheduled.push(...applied.scheduled);
      events.push(...applied.borrowEvents);
    }
    return { scheduled, borrowEvents: events };
  }

  schedulePass(time, onlyTenant = null) {
    this.time = time;
    const empty = { scheduled: [], borrowEvents: [] };
    const candidates = this.orders
      .filter((o) => o.submit <= time && this.remaining(o) > 0)
      .filter((o) => !onlyTenant || o.tenant === onlyTenant)
      .map((o) => o.id)
      .sort();
    if (candidates.length === 0) return empty;

    const reserved = this.reservedMap(time);
    const lenders = [];
    for (const [id, node] of this.nodes) {
      if (id === this.rootId) continue;
      if (node.guarantee - node.lentOut - node.used - (reserved.get(id) || 0) > 0) {
        lenders.push(id);
      }
    }
    lenders.sort();

    if (candidates.length <= EXACT_MAX_CANDIDATES && lenders.length <= EXACT_MAX_LENDERS) {
      const plan = this.exactSearch(candidates, lenders, reserved);
      if (!plan) return empty;
      return this.applyPlan(plan, time);
    }
    return this.greedyPass(candidates, lenders, reserved, time);
  }

  reclaim(tenantId, time) {
    this.time = time;
    const node = this.nodes.get(tenantId);
    const outstanding = this.borrows.filter((b) => b.lender === tenantId && b.amount > 0);
    const lent = outstanding.reduce((sum, b) => sum + b.amount, 0);
    const demand = this.orders
      .filter((o) => o.tenant === tenantId && o.submit <= time && this.remaining(o) > 0)
      .reduce((sum, o) => sum + this.remaining(o), 0);
    let avail = Infinity;
    for (const nodeId of this.paths.get(tenantId)) {
      avail = Math.min(avail, this.effLimit(nodeId) - this.nodes.get(nodeId).used);
    }
    const need = Math.min(lent, Math.max(0, demand - Math.max(0, avail)));
    const record = { tenant: tenantId, time, demand, need, released: 0 };
    this.reclaims.push(record);
    if (need <= 0) {
      return { record, preemptions: [] };
    }

    const victims = outstanding.slice().sort((a, b) => {
      if (a.time !== b.time) return b.time - a.time;
      const pa = this.orderById.get(a.order).priority;
      const pb = this.orderById.get(b.order).priority;
      if (pa !== pb) return pa - pb;
      return cmpStr(a.order, b.order);
    });

    const preemptions = [];
    let released = 0;
    for (const borrow of victims) {
      if (released >= need) break;
      const take = Math.min(borrow.amount, need - released);
      borrow.amount -= take;
      const order = this.orderById.get(borrow.order);
      order.active -= take;
      this.nodes.get(borrow.borrower).borrowedIn -= take;
      node.lentOut -= take;
      for (const nodeId of this.paths.get(borrow.borrower)) {
        this.nodes.get(nodeId).used -= take;
      }
      preemptions.push({
        time,
        lender: borrow.lender,
        borrower: borrow.borrower,
        order: borrow.order,
        amount: take,
      });
      released += take;
    }
    record.released = released;
    this.preemptions.push(...preemptions);
    this.schedulePass(time, tenantId);
    return { record, preemptions };
  }
}
