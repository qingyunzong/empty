import { ValidationError, buildTree } from './model.js';

const MAX_TICKS = 100000;

const slack = (n) => n.guarantee - n.lentOut + n.borrowedIn - n.usage;
const minPathSlack = (n) => Math.min(...n.path.map(slack));

function lca(a, b) {
  const ids = new Set(a.path.map((n) => n.id));
  for (const n of b.path) if (ids.has(n.id)) return n;
  return null;
}

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Runs the whole simulation and returns the report object.
// Throws ValidationError (with .code) on invalid input.
export function simulate(input) {
  if (!input || typeof input !== 'object') {
    throw new ValidationError('INVALID_INPUT', 'input must be a JSON object');
  }
  const cfg = input.config ?? {};
  const starveAfter = cfg.starveAfter ?? Infinity;
  const horizon = cfg.horizon ?? input.horizon ?? null;
  const trace = cfg.trace ?? false;
  const { nodes, root } = buildTree(input.tenants);

  const orders = new Map();
  const waiting = new Map([...nodes.keys()].map((id) => [id, []]));
  const running = new Set();
  const records = [];
  const preemptions = [];
  const schedule = [];
  let recSeq = 0;

  function addOrder(spec, arriveDefault) {
    if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new ValidationError('INVALID_ORDER', `order needs a non-empty string id: ${JSON.stringify(spec)}`);
    }
    if (orders.has(spec.id)) {
      throw new ValidationError('DUPLICATE_ORDER', `duplicate order id "${spec.id}"`);
    }
    if (!nodes.has(spec.tenant)) {
      throw new ValidationError('UNKNOWN_TENANT', `order "${spec.id}": unknown tenant "${spec.tenant}"`);
    }
    if (!Number.isInteger(spec.duration) || spec.duration <= 0) {
      throw new ValidationError('INVALID_ORDER', `order "${spec.id}": duration must be a positive integer`);
    }
    const o = {
      id: spec.id,
      tenant: spec.tenant,
      duration: spec.duration,
      priority: spec.priority ?? 0,
      arrive: spec.arrive ?? arriveDefault,
      status: 'pending',
      progress: 0,
      startTick: null,
      finishTick: null,
      funding: null,
      recordId: null,
      preempts: 0,
    };
    orders.set(o.id, o);
    return o;
  }

  for (const s of input.orders ?? []) addOrder(s, 0);
  const commands = [...(input.commands ?? [])].sort((a, b) => a.tick - b.tick);
  for (const c of commands) {
    if (!Number.isInteger(c.tick) || c.tick < 0) {
      throw new ValidationError('INVALID_COMMAND', `command tick must be a non-negative integer: ${JSON.stringify(c)}`);
    }
  }

  const addUsage = (node, delta) => {
    for (const n of node.path) n.usage += delta;
  };

  function applyLoanPaths(lender, borrower, delta) {
    const meet = lca(lender, borrower);
    for (const n of lender.path) {
      if (n === meet) break;
      n.lentOut += delta;
    }
    for (const n of borrower.path) {
      if (n === meet) break;
      n.borrowedIn += delta;
    }
    lender.ownLent += delta;
  }

  const starved = (o, tick) => tick - o.arrive >= starveAfter;

  function orderBetter(a, b, tick) {
    const sa = starved(a, tick);
    const sb = starved(b, tick);
    if (sa !== sb) return sa;
    if (a.priority !== b.priority) return a.priority > b.priority;
    return a.id < b.id;
  }

  function pickOrder(tenantId, tick) {
    const q = waiting.get(tenantId);
    let best = 0;
    for (let i = 1; i < q.length; i += 1) {
      if (orderBetter(q[i], q[best], tick)) best = i;
    }
    return q.splice(best, 1)[0];
  }

  function startOwn(o, tick, ev) {
    const node = nodes.get(o.tenant);
    o.status = 'running';
    o.progress = 0;
    o.startTick = tick;
    o.funding = o.tenant;
    o.recordId = null;
    addUsage(node, 1);
    running.add(o);
    ev.started.push(o.id);
  }

  function startBorrowed(o, lender, tick, ev) {
    const borrower = nodes.get(o.tenant);
    const rec = {
      id: `b${++recSeq}`,
      tick,
      lender: lender.id,
      borrower: borrower.id,
      orderId: o.id,
      priority: o.priority,
      status: 'active',
    };
    records.push(rec);
    applyLoanPaths(lender, borrower, 1);
    o.status = 'running';
    o.progress = 0;
    o.startTick = tick;
    o.funding = lender.id;
    o.recordId = rec.id;
    addUsage(borrower, 1);
    running.add(o);
    ev.started.push(o.id);
  }

  // Frees the slot held by a running order and rolls back its recorded
  // usage level by level along the tenant tree (borrower path to root,
  // plus lender/borrower loan paths up to their LCA).
  function releaseSlot(o) {
    const borrower = nodes.get(o.tenant);
    addUsage(borrower, -1);
    if (o.recordId) {
      const rec = records.find((r) => r.id === o.recordId);
      applyLoanPaths(nodes.get(rec.lender), borrower, -1);
    }
    o.recordId = null;
    running.delete(o);
  }

  // Preempts up to `amount` active loans issued by `tenantId`.
  // Victim order: latest borrow first, then lowest priority, then order id.
  // Returns the exact number of released slots.
  function reclaim(tick, tenantId, amount, reason, ev) {
    const k = amount ?? Infinity;
    const candidates = records
      .filter((r) => r.status === 'active' && r.lender === tenantId)
      .sort((a, b) => b.tick - a.tick || a.priority - b.priority || byId(a.orderId, b.orderId));
    let released = 0;
    for (const rec of candidates) {
      if (released >= k) break;
      rec.status = 'preempted';
      const o = orders.get(rec.orderId);
      releaseSlot(o);
      o.status = 'waiting';
      o.progress = 0;
      o.preempts += 1;
      waiting.get(o.tenant).push(o);
      released += 1;
      ev.preempted.push(o.id);
      preemptions.push({
        tick,
        orderId: o.id,
        lender: rec.lender,
        borrower: rec.borrower,
        reason,
        released: 1,
      });
    }
    return released;
  }

  function checkInvariants(tick) {
    for (const n of nodes.values()) {
      if (n.usage < 0 || n.lentOut < 0 || n.borrowedIn < 0 || n.ownLent < 0) {
        throw new Error(`internal: negative accounting at "${n.id}" on tick ${tick}`);
      }
      if (slack(n) < 0) {
        throw new Error(`internal: node "${n.id}" over quota on tick ${tick}`);
      }
    }
  }

  const snapshot = () =>
    Object.fromEntries(
      [...nodes.values()].map((n) => [
        n.id,
        { usage: n.usage, lentOut: n.lentOut, borrowedIn: n.borrowedIn, slack: slack(n) },
      ]),
    );

  let tick = 0;
  for (; tick < MAX_TICKS; tick += 1) {
    const pendingCommands = commands.some((c) => c.tick >= tick);
    const anyWaiting = [...waiting.values()].some((q) => q.length > 0);
    const arrivalsPending = [...orders.values()].some((o) => o.status === 'pending' && o.arrive >= tick);
    if (!pendingCommands && !anyWaiting && running.size === 0 && !arrivalsPending) break;
    if (horizon !== null && tick >= horizon) break;

    const ev = { tick, started: [], completed: [], preempted: [] };
    const noLend = new Set();

    for (const o of orders.values()) {
      if (o.status === 'pending' && o.arrive <= tick) {
        o.status = 'waiting';
        waiting.get(o.tenant).push(o);
      }
    }

    for (const c of commands.filter((cmd) => cmd.tick === tick)) {
      if (c.type === 'submit') {
        const o = addOrder(c.order, tick);
        o.arrive = tick;
        o.status = 'waiting';
        waiting.get(o.tenant).push(o);
      } else if (c.type === 'reclaim') {
        if (!nodes.has(c.tenant)) {
          throw new ValidationError('UNKNOWN_TENANT', `reclaim: unknown tenant "${c.tenant}"`);
        }
        if (c.amount !== undefined && (!Number.isInteger(c.amount) || c.amount <= 0)) {
          throw new ValidationError('INVALID_COMMAND', `reclaim amount must be a positive integer, got ${c.amount}`);
        }
        reclaim(tick, c.tenant, c.amount, 'reclaim', ev);
        noLend.add(c.tenant);
      } else {
        throw new ValidationError('UNKNOWN_COMMAND', `unknown command type "${c.type}"`);
      }
    }

    // Starvation floor: orders of this tenant waiting past the threshold take
    // priority over lending - the tenant automatically reclaims its own loans.
    for (const id of [...waiting.keys()].sort(byId)) {
      const node = nodes.get(id);
      let need = waiting.get(id).filter((o) => starved(o, tick)).length;
      while (need > 0 && node.ownLent > 0 && slack(node) < 1) {
        reclaim(tick, id, 1, 'starvation', ev);
        noLend.add(id);
        need -= 1;
      }
    }

    // Phase A: own guaranteed quota first (starved tenants before others).
    const tenantOrder = [...nodes.keys()].sort((a, b) => {
      const sa = waiting.get(a).some((o) => starved(o, tick)) ? 0 : 1;
      const sb = waiting.get(b).some((o) => starved(o, tick)) ? 0 : 1;
      return sa - sb || byId(a, b);
    });
    for (const id of tenantOrder) {
      const node = nodes.get(id);
      while (waiting.get(id).length > 0 && minPathSlack(node) >= 1) {
        startOwn(pickOrder(id, tick), tick, ev);
      }
    }

    // Phase B: borrow idle quota. Max utilization; ties broken by tenant-id
    // lexicographic order (earlier borrower served first, earliest lender first).
    const lenderOrder = [...nodes.values()].sort((a, b) => byId(a.id, b.id));
    for (const id of [...waiting.keys()].sort(byId)) {
      while (waiting.get(id).length > 0) {
        const lender = lenderOrder.find((l) => l.id !== id && !noLend.has(l.id) && minPathSlack(l) >= 1);
        if (!lender) break;
        startBorrowed(pickOrder(id, tick), lender, tick, ev);
      }
    }

    for (const o of [...running]) {
      o.progress += 1;
      if (o.progress >= o.duration) {
        o.status = 'completed';
        o.finishTick = tick;
        if (o.recordId) {
          records.find((r) => r.id === o.recordId).status = 'completed';
        }
        releaseSlot(o);
        ev.completed.push(o.id);
      }
    }

    checkInvariants(tick);
    if (trace) ev.nodes = snapshot();
    schedule.push(ev);
  }

  const nodeReports = [...nodes.values()].sort((a, b) => byId(a.id, b.id)).map((n) => ({
    id: n.id,
    parent: n.parent,
    guarantee: n.guarantee,
    usage: n.usage,
    lentOut: n.lentOut,
    borrowedIn: n.borrowedIn,
    ownLent: n.ownLent,
    slack: slack(n),
  }));

  return {
    ok: true,
    root: root.id,
    nodes: nodeReports,
    borrowChain: records,
    preemptions,
    schedule,
    orders: [...orders.values()].sort((a, b) => byId(a.id, b.id)).map((o) => ({
      id: o.id,
      tenant: o.tenant,
      status: o.status,
      priority: o.priority,
      arrive: o.arrive,
      duration: o.duration,
      progress: o.progress,
      startTick: o.startTick,
      finishTick: o.finishTick,
      funding: o.funding,
      preempts: o.preempts,
    })),
    summary: {
      ticks: tick,
      totalOrders: orders.size,
      completed: [...orders.values()].filter((o) => o.status === 'completed').length,
      borrowedSlots: records.length,
      preemptedSlots: preemptions.length,
    },
  };
}
