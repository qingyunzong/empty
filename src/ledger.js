// Convergent ledger: per (bin|item) key, each node owns at most one delta
// entry tagged with its version-vector sequence. Merges take the max-seq
// entry per node, so the result is order-independent. If the merged total
// for a key would go negative, negative contributors are moved to `pending`
// (deterministically, largest node id first) instead of failing; pending
// entries are retried whenever stock allows.

export function createLedger() {
  return {
    version: 1,
    vv: {},
    base: {},
    deltas: {},
    pending: [],
    appliedSessions: {},
    history: [],
  };
}

export function stockOf(ledger, key) {
  let total = ledger.base[key] || 0;
  const perNode = ledger.deltas[key];
  if (perNode) {
    for (const node of Object.keys(perNode)) total += perNode[node].delta;
  }
  return total;
}

export function allStock(ledger) {
  const keys = new Set([
    ...Object.keys(ledger.base),
    ...Object.keys(ledger.deltas),
    ...ledger.pending.map((p) => p.key),
  ]);
  const out = {};
  for (const key of keys) out[key] = stockOf(ledger, key);
  return out;
}

export function contributionOf(ledger, key, node) {
  const entry = ledger.deltas[key]?.[node];
  if (entry) return { seq: entry.seq, delta: entry.delta };
  const pending = ledger.pending.find((p) => p.key === key && p.node === node);
  return pending ? { seq: pending.seq, delta: pending.delta } : null;
}

function entriesFor(ledger, key) {
  const byNode = new Map();
  const perNode = ledger.deltas[key] || {};
  for (const [node, entry] of Object.entries(perNode)) {
    byNode.set(node, { node, seq: entry.seq, delta: entry.delta });
  }
  for (const p of ledger.pending) {
    if (p.key !== key) continue;
    const current = byNode.get(p.node);
    if (!current || p.seq > current.seq) {
      byNode.set(p.node, { node: p.node, seq: p.seq, delta: p.delta });
    }
  }
  return byNode;
}

// Pure function of the entry set for `key`: split entries into applied
// (deltas) and pending such that the running total never goes negative.
export function rebalance(ledger, key) {
  const byNode = entriesFor(ledger, key);
  const base = ledger.base[key] || 0;
  let total = base;
  for (const entry of byNode.values()) total += entry.delta;

  const applied = new Map(byNode);
  const evicted = [];
  while (total < 0) {
    const negatives = [...applied.values()]
      .filter((e) => e.delta < 0)
      .sort((a, b) => b.node.localeCompare(a.node) || b.seq - a.seq);
    if (negatives.length === 0) break;
    const victim = negatives[0];
    applied.delete(victim.node);
    evicted.push(victim);
    total -= victim.delta;
  }

  evicted.sort((a, b) => a.node.localeCompare(b.node) || a.seq - b.seq);
  const stillPending = [];
  for (const entry of evicted) {
    if (total + entry.delta >= 0) {
      applied.set(entry.node, entry);
      total += entry.delta;
    } else {
      stillPending.push(entry);
    }
  }

  if (applied.size === 0) {
    delete ledger.deltas[key];
  } else {
    const perNode = {};
    for (const [node, entry] of [...applied.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      perNode[node] = { seq: entry.seq, delta: entry.delta };
    }
    ledger.deltas[key] = perNode;
  }
  ledger.pending = ledger.pending
    .filter((p) => p.key !== key)
    .concat(
      stillPending.map((e) => ({
        key,
        node: e.node,
        seq: e.seq,
        delta: e.delta,
        reason: 'negative-inventory',
      })),
    );
  ledger.pending.sort(
    (a, b) => a.key.localeCompare(b.key) || a.node.localeCompare(b.node) || a.seq - b.seq,
  );
}

export function commitSession(ledger, nodeId, sessionId, changes) {
  const applied = ledger.appliedSessions[nodeId] || [];
  if (applied.includes(sessionId)) return false;
  const touched = new Set();
  for (const { key, delta } of changes) {
    if (delta === 0) continue;
    const seq = (ledger.vv[nodeId] || 0) + 1;
    ledger.vv[nodeId] = seq;
    const current = contributionOf(ledger, key, nodeId);
    const perNode = ledger.deltas[key] || {};
    perNode[nodeId] = { seq, delta: (current ? current.delta : 0) + delta };
    ledger.deltas[key] = perNode;
    ledger.history.push({ node: nodeId, seq, sessionId, key, delta });
    touched.add(key);
  }
  applied.push(sessionId);
  ledger.appliedSessions[nodeId] = applied;
  for (const key of touched) rebalance(ledger, key);
  return true;
}

function pickEntry(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.seq !== b.seq) return a.seq > b.seq ? a : b;
  return a.delta >= b.delta ? a : b;
}

export function mergeLedgers(a, b) {
  const out = createLedger();

  for (const node of new Set([...Object.keys(a.vv), ...Object.keys(b.vv)])) {
    out.vv[node] = Math.max(a.vv[node] || 0, b.vv[node] || 0);
  }
  for (const key of new Set([...Object.keys(a.base), ...Object.keys(b.base)])) {
    out.base[key] = Math.max(a.base[key] || 0, b.base[key] || 0);
  }
  for (const key of new Set([...Object.keys(a.deltas), ...Object.keys(b.deltas)])) {
    const nodes = new Set([
      ...Object.keys(a.deltas[key] || {}),
      ...Object.keys(b.deltas[key] || {}),
    ]);
    const perNode = {};
    for (const node of nodes) {
      const picked = pickEntry(a.deltas[key]?.[node], b.deltas[key]?.[node]);
      perNode[node] = { seq: picked.seq, delta: picked.delta };
    }
    out.deltas[key] = perNode;
  }

  const pendingSeen = new Map();
  for (const p of [...a.pending, ...b.pending]) {
    const id = `${p.key} ${p.node} ${p.seq}`;
    if (!pendingSeen.has(id)) pendingSeen.set(id, { ...p });
  }
  out.pending = [...pendingSeen.values()];

  for (const node of new Set([
    ...Object.keys(a.appliedSessions),
    ...Object.keys(b.appliedSessions),
  ])) {
    out.appliedSessions[node] = [
      ...new Set([...(a.appliedSessions[node] || []), ...(b.appliedSessions[node] || [])]),
    ].sort();
  }

  const historySeen = new Map();
  for (const h of [...a.history, ...b.history]) {
    const id = `${h.node} ${h.seq} ${h.key}`;
    if (!historySeen.has(id)) historySeen.set(id, { ...h });
  }
  out.history = [...historySeen.values()].sort(
    (x, y) => x.node.localeCompare(y.node) || x.seq - y.seq || x.key.localeCompare(y.key),
  );

  const touched = new Set([...Object.keys(out.deltas), ...out.pending.map((p) => p.key)]);
  for (const key of touched) rebalance(out, key);
  return out;
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function verifyLedger(ledger) {
  const problems = [];
  const stock = allStock(ledger);
  for (const [key, qty] of Object.entries(stock)) {
    if (qty < 0) problems.push(`negative stock for ${key}: ${qty}`);
  }
  const maxSeq = {};
  for (const h of ledger.history) {
    maxSeq[h.node] = Math.max(maxSeq[h.node] || 0, h.seq);
  }
  for (const node of new Set([...Object.keys(ledger.vv), ...Object.keys(maxSeq)])) {
    if ((ledger.vv[node] || 0) !== (maxSeq[node] || 0)) {
      problems.push(`version vector mismatch for ${node}: vv=${ledger.vv[node] || 0} history=${maxSeq[node] || 0}`);
    }
  }
  for (const [key, perNode] of Object.entries(ledger.deltas)) {
    for (const [node, entry] of Object.entries(perNode)) {
      if (entry.seq > (ledger.vv[node] || 0)) {
        problems.push(`delta seq ${entry.seq} exceeds version vector for ${node} on ${key}`);
      }
    }
  }
  for (const p of ledger.pending) {
    if (p.reason !== 'negative-inventory') {
      problems.push(`pending entry without explanation: ${p.key} ${p.node}#${p.seq}`);
    }
    if (stockOf(ledger, p.key) + p.delta >= 0) {
      problems.push(`pending entry applicable but not applied: ${p.key} ${p.node}#${p.seq}`);
    }
  }
  return { ok: problems.length === 0, problems, stock, pending: ledger.pending };
}
