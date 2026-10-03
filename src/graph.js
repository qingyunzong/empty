// Directed debt graph helpers. Edge keys are "from>to"; amounts are BigInt cents.

export function edgeKey(from, to) {
  return `${from}>${to}`;
}

// Rotate a cycle so the lexicographically smallest member is first.
// This makes rotation-equivalent cycles compare equal (canonical form).
export function canonicalMembers(members) {
  let best = 0;
  for (let i = 1; i < members.length; i++) {
    if (members[i] < members[best]) best = i;
  }
  return members.slice(best).concat(members.slice(0, best));
}

export function canonicalKey(members) {
  return canonicalMembers(members).join('>');
}

// Aggregate obligations into a simple directed graph per currency.
// obligations: [{ from, to, ccy, amount:BigInt }]
// Returns Map ccy -> Map edgeKey -> BigInt
export function buildGraph(obligations) {
  const byCcy = new Map();
  for (const o of obligations) {
    let edges = byCcy.get(o.ccy);
    if (!edges) byCcy.set(o.ccy, (edges = new Map()));
    const k = edgeKey(o.from, o.to);
    edges.set(k, (edges.get(k) ?? 0n) + o.amount);
  }
  return byCcy;
}

// Net position per member: inflow - outflow. Positive = net receiver.
export function netPositions(edges) {
  const net = new Map();
  for (const [k, amt] of edges) {
    if (amt === 0n) continue;
    const [from, to] = k.split('>');
    net.set(from, (net.get(from) ?? 0n) - amt);
    net.set(to, (net.get(to) ?? 0n) + amt);
  }
  return net;
}

export function totalAmount(edges) {
  let t = 0n;
  for (const amt of edges.values()) t += amt;
  return t;
}

// Enumerate all simple cycles (length >= 2) of the directed graph in
// canonical form, sorted by canonical key. Deterministic.
export function enumerateCycles(edges) {
  const adj = new Map();
  const nodes = new Set();
  for (const [k, amt] of edges) {
    if (amt <= 0n) continue;
    const [from, to] = k.split('>');
    nodes.add(from);
    nodes.add(to);
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }
  for (const list of adj.values()) list.sort();
  const found = new Map();
  const sorted = [...nodes].sort();
  for (const start of sorted) {
    const stack = [start];
    const onStack = new Set([start]);
    const dfs = (u) => {
      for (const v of adj.get(u) ?? []) {
        if (v < start) continue; // start must be the min node of the cycle
        if (v === start) {
          if (stack.length >= 2) {
            const members = [...stack];
            found.set(members.join('>'), members);
          }
        } else if (!onStack.has(v)) {
          stack.push(v);
          onStack.add(v);
          dfs(v);
          stack.pop();
          onStack.delete(v);
        }
      }
    };
    dfs(start);
  }
  return [...found.values()]
    .map((members) => {
      const cyc = canonicalMembers(members);
      const edgeKeys = cyc.map((m, i) => edgeKey(m, cyc[(i + 1) % cyc.length]));
      let bottleneck = null;
      for (const ek of edgeKeys) {
        const a = edges.get(ek) ?? 0n;
        if (bottleneck === null || a < bottleneck) bottleneck = a;
      }
      return { key: cyc.join('>'), members: cyc, edgeKeys, bottleneck };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
