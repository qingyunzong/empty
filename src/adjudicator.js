'use strict';

const { OPCODES } = require('./compiler');

class ReplayError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReplayError';
  }
}

function compareEvents(a, b) {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  if (a.clock !== b.clock) return a.clock - b.clock;
  return a.seq - b.seq;
}

function buildGraph(events, edges) {
  const idx = new Map(events.map((ev, i) => [ev.id, i]));
  const adj = events.map(() => []);
  const indeg = events.map(() => 0);
  for (const e of edges) {
    const from = idx.get(e.from);
    const to = idx.get(e.to);
    if (from == null || to == null) continue;
    adj[from].push(to);
    indeg[to] += 1;
  }
  return { adj, indeg };
}

function computeReachability(adj) {
  const reach = adj.map(() => new Set());
  for (let i = 0; i < adj.length; i++) {
    const stack = [...adj[i]];
    while (stack.length) {
      const j = stack.pop();
      if (!reach[i].has(j)) {
        reach[i].add(j);
        for (const k of adj[j]) stack.push(k);
      }
    }
  }
  return reach;
}

function deterministicOrder(events, adj, indeg) {
  const deg = [...indeg];
  const ready = [];
  for (let i = 0; i < events.length; i++) if (deg[i] === 0) ready.push(i);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => compareEvents(events[a], events[b]));
    const next = ready.shift();
    order.push(next);
    for (const m of adj[next]) {
      deg[m] -= 1;
      if (deg[m] === 0) ready.push(m);
    }
  }
  if (order.length !== events.length) {
    const stuck = events
      .filter((_, i) => deg[i] > 0)
      .map((ev) => ev.id)
      .join(', ');
    throw new ReplayError(`causal cycle detected among events: ${stuck}`);
  }
  return order;
}

function enumerateTopoOrders(events, adj, indeg, limit = 100000) {
  const deg = [...indeg];
  const inOrder = new Array(events.length).fill(false);
  const results = [];
  const current = [];
  const ready = () => {
    const list = [];
    for (let i = 0; i < events.length; i++) {
      if (!inOrder[i] && deg[i] === 0) list.push(i);
    }
    return list.sort((a, b) => compareEvents(events[a], events[b]));
  };
  const walk = () => {
    if (results.length >= limit) return;
    if (current.length === events.length) {
      results.push(current.map((i) => events[i].id));
      return;
    }
    for (const i of ready()) {
      inOrder[i] = true;
      current.push(i);
      for (const m of adj[i]) deg[m] -= 1;
      walk();
      for (const m of adj[i]) deg[m] += 1;
      current.pop();
      inOrder[i] = false;
    }
  };
  walk();
  return results;
}

function detectConflicts(events, edges, reach) {
  const concurrent = (a, b) => !reach[a].has(b) && !reach[b].has(a);
  const commitsByKey = new Map();
  events.forEach((ev, i) => {
    if (ev.op !== OPCODES.COMMIT) return;
    if (!commitsByKey.has(ev.key)) commitsByKey.set(ev.key, []);
    commitsByKey.get(ev.key).push(i);
  });

  const conflicted = new Set();
  const conflicts = [];
  for (const [key, list] of commitsByKey) {
    const bad = new Set();
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        if (concurrent(i, j) && events[i].value !== events[j].value) {
          bad.add(i);
          bad.add(j);
        }
      }
    }
    if (bad.size === 0) continue;
    for (const i of bad) conflicted.add(i);
    const keyEventIds = new Set(
      events.filter((ev) => ev.key === key).map((ev) => ev.id),
    );
    conflicts.push({
      key,
      reason:
        'concurrent commits with different values on the same observation key; ' +
        'no causal order exists, so no value is chosen arbitrarily',
      events: [...bad]
        .map((i) => ({
          id: events[i].id,
          node: events[i].node,
          clock: events[i].clock,
          value: events[i].value,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      causalEdges: edges.filter((e) => keyEventIds.has(e.from) && keyEventIds.has(e.to)),
    });
  }
  return { conflicted, conflicts };
}

function replay(program) {
  const { code, edges } = program;
  const events = code.filter((ins) => ins.op !== OPCODES.CONFLICT_CHECK);
  const { adj, indeg } = buildGraph(events, edges);
  const reach = computeReachability(adj);
  const { conflicted, conflicts } = detectConflicts(events, edges, reach);
  const order = deterministicOrder(events, adj, indeg);

  const stacks = new Map();
  const visible = new Map();
  const history = [];
  for (const i of order) {
    const ev = events[i];
    if (conflicted.has(i)) {
      history.push({ id: ev.id, action: 'skipped-conflict', key: ev.key });
      continue;
    }
    switch (ev.op) {
      case OPCODES.COMMIT: {
        if (!stacks.has(ev.key)) stacks.set(ev.key, []);
        stacks.get(ev.key).push(ev.value);
        visible.set(ev.key, true);
        history.push({ id: ev.id, action: 'commit', key: ev.key, value: ev.value });
        break;
      }
      case OPCODES.MASK: {
        visible.set(ev.key, false);
        history.push({ id: ev.id, action: 'mask', key: ev.key });
        break;
      }
      case OPCODES.ROLLBACK: {
        const st = stacks.get(ev.key) || [];
        if (st.length > 0) {
          const restored = st.length > 1 ? st[st.length - 2] : null;
          st.pop();
          history.push({ id: ev.id, action: 'rollback', key: ev.key, restored });
        } else {
          history.push({ id: ev.id, action: 'rollback-noop', key: ev.key });
        }
        break;
      }
      default:
        throw new ReplayError(`unknown opcode ${ev.op}`);
    }
  }

  const state = {};
  for (const [key, st] of stacks) {
    if (st.length > 0 && visible.get(key) !== false) state[key] = st[st.length - 1];
  }

  return {
    order: order.map((i) => events[i].id),
    state,
    conflicts,
    history,
    edges,
    graph: { adj, indeg, events },
  };
}

function explain(program, result) {
  const lines = [];
  lines.push('causal edges (happens-before):');
  if (program.edges.length === 0) lines.push('  (none: all events are concurrent)');
  for (const e of program.edges) lines.push(`  ${e.from} -> ${e.to}  [${e.reason}]`);
  lines.push('adjudicated order:');
  result.order.forEach((id, i) => {
    const preds = program.edges.filter((e) => e.to === id).map((e) => e.from);
    const why =
      preds.length === 0
        ? 'no predecessors; placed by deterministic tie-break (key, node, clock)'
        : `after ${preds.join(', ')} by causal edges`;
    lines.push(`  ${i + 1}. ${id}  (${why})`);
  });
  if (result.conflicts.length) {
    lines.push('conflicts:');
    for (const c of result.conflicts) {
      lines.push(`  key "${c.key}": ${c.events.map((e) => `${e.id}=${JSON.stringify(e.value)}`).join(' vs ')}`);
      lines.push(`    reason: ${c.reason}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  replay,
  explain,
  enumerateTopoOrders,
  deterministicOrder,
  buildGraph,
  computeReachability,
  compareEvents,
  ReplayError,
};
