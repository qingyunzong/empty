'use strict';

// 两条指令可配对：方向相反、证券/价格/数量完全相等
function compatible(a, b) {
  return a.side !== b.side &&
    a.security === b.security &&
    a.price === b.price &&
    a.quantity === b.quantity;
}

// 传播：删去不可能账户（许可之外或可用余额/持仓不足以覆盖该指令的账户）
function buildDomains(instructions, availability, permissions) {
  const domains = new Map();
  for (const inst of instructions) {
    const allowed = permissions.has(inst.id)
      ? permissions.get(inst.id)
      : [...availability.keys()];
    domains.set(inst.id, allowed.filter((accId) => {
      const av = availability.get(accId);
      if (!av) return false;
      if (inst.side === 'buy') return av.cash >= inst.price * inst.quantity;
      return (av.securities[inst.security] ?? 0) >= inst.quantity;
    }));
  }
  return domains;
}

// 回溯搜索：枚举买卖配对与交收账户，最大化成交对数（同一指令至多出现一次）
function solveMatching(instructions, domains, availability) {
  const candidatesOf = new Map();
  for (const inst of instructions) {
    candidatesOf.set(inst.id,
      instructions.filter((o) => o.id !== inst.id && compatible(inst, o)));
  }
  const order = [...instructions].sort(
    (a, b) => candidatesOf.get(a.id).length - candidatesOf.get(b.id).length);
  const used = new Set();
  const pairs = [];
  let best = [];

  function canUse(accId, inst) {
    const av = availability.get(accId);
    if (inst.side === 'buy') return av.cash >= inst.price * inst.quantity;
    return (av.securities[inst.security] ?? 0) >= inst.quantity;
  }
  function apply(accId, inst, sign) {
    const av = availability.get(accId);
    if (inst.side === 'buy') {
      av.cash -= sign * inst.price * inst.quantity;
    } else {
      av.securities[inst.security] = (av.securities[inst.security] ?? 0) - sign * inst.quantity;
    }
  }
  function makePair(a, b, accA, accB) {
    const buy = a.side === 'buy' ? a : b;
    const sell = a.side === 'buy' ? b : a;
    return {
      buy: buy.id,
      sell: sell.id,
      security: buy.security,
      price: buy.price,
      quantity: buy.quantity,
      buyAccount: a.side === 'buy' ? accA : accB,
      sellAccount: a.side === 'buy' ? accB : accA,
    };
  }

  function dfs(idx) {
    const upperBound = pairs.length + Math.floor((instructions.length - used.size) / 2);
    if (upperBound <= best.length) return;
    if (idx >= order.length) {
      if (pairs.length > best.length) best = pairs.map((p) => ({ ...p }));
      return;
    }
    const inst = order[idx];
    if (used.has(inst.id)) {
      dfs(idx + 1);
      return;
    }
    for (const other of candidatesOf.get(inst.id)) {
      if (used.has(other.id)) continue;
      for (const accI of domains.get(inst.id)) {
        if (!canUse(accI, inst)) continue;
        apply(accI, inst, 1);
        for (const accJ of domains.get(other.id)) {
          if (!canUse(accJ, other)) continue;
          apply(accJ, other, 1);
          used.add(inst.id);
          used.add(other.id);
          pairs.push(makePair(inst, other, accI, accJ));
          dfs(idx + 1);
          pairs.pop();
          used.delete(inst.id);
          used.delete(other.id);
          apply(accJ, other, -1);
        }
        apply(accI, inst, -1);
      }
    }
    dfs(idx + 1); // 该指令暂不配对
  }

  dfs(0);
  return best;
}

function bfsPath(src, dst, adj) {
  const prev = new Map([[src, null]]);
  const queue = [src];
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nxt of adj.get(cur) ?? []) {
      if (!prev.has(nxt)) {
        prev.set(nxt, cur);
        if (nxt === dst) {
          const path = [];
          let node = dst;
          while (node !== null) {
            path.unshift(node);
            node = prev.get(node);
          }
          return path;
        }
        queue.push(nxt);
      }
    }
  }
  return null;
}

// 经过指令 u 的最短环（邻接关系 = 两条指令的候选账户集合相交，即存在账户竞争）
function shortestCycleThrough(u, adj) {
  let best = null;
  for (const v of adj.get(u) ?? []) {
    const path = bfsPath(v, u, adj);
    if (path) {
      const cycle = [u, ...path.slice(0, -1)];
      if (!best || cycle.length < best.length) best = cycle;
    }
  }
  return best ?? [u];
}

// 冲突解释：给出最短指令环
function explainConflict(instructions, domains, result) {
  const empty = instructions.filter((i) => (domains.get(i.id) ?? []).length === 0);
  if (empty.length > 0) {
    const inst = empty[0];
    const need = inst.side === 'buy'
      ? `现金 ${inst.price * inst.quantity}`
      : `证券 ${inst.security} 数量 ${inst.quantity}`;
    return {
      cycle: [inst.id],
      explanation: `指令 ${inst.id} 没有可行交收账户：需要${need}，许可账户余额/持仓均不足`,
    };
  }
  const pairedIds = new Set(result.pairs.flatMap((p) => [p.buy, p.sell]));
  const unmatched = instructions.filter((i) => !pairedIds.has(i.id));
  const hasPartner = (i) => unmatched.some((o) => o.id !== i.id && compatible(i, o));
  const start = unmatched.find(hasPartner);
  if (!start) return null;
  const nodes = instructions.filter((i) => pairedIds.has(i.id) || hasPartner(i));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const a of nodes) {
    for (const b of nodes) {
      if (a.id === b.id) continue;
      const shared = (domains.get(a.id) ?? []).some((acc) => (domains.get(b.id) ?? []).includes(acc));
      if (shared) adj.get(a.id).push(b.id);
    }
  }
  const cycle = shortestCycleThrough(start.id, adj);
  return {
    cycle,
    explanation: `账户资源冲突，最短指令环: ${[...cycle, cycle[0]].join(' -> ')}`,
  };
}

module.exports = { compatible, buildDomains, solveMatching, explainConflict };
