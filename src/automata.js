'use strict';

function nfaFromAst(ast) {
  const trans = [];
  function newState() {
    trans.push(new Map());
    return trans.length - 1;
  }
  function add(from, sym, to) {
    if (!trans[from].has(sym)) trans[from].set(sym, new Set());
    trans[from].get(sym).add(to);
  }
  function build(node) {
    switch (node.type) {
      case 'eps': {
        const s = newState(); const e = newState();
        add(s, '', e);
        return { start: s, end: e };
      }
      case 'empty': {
        const s = newState(); const e = newState();
        return { start: s, end: e };
      }
      case 'lit': {
        const s = newState(); const e = newState();
        add(s, node.event, e);
        return { start: s, end: e };
      }
      case 'concat': {
        let first = null;
        let prev = null;
        for (const part of node.parts) {
          const frag = build(part);
          if (!first) first = frag;
          else add(prev.end, '', frag.start);
          prev = frag;
        }
        if (!first) return build({ type: 'eps' });
        return { start: first.start, end: prev.end };
      }
      case 'alt': {
        const s = newState(); const e = newState();
        for (const opt of node.options) {
          const frag = build(opt);
          add(s, '', frag.start);
          add(frag.end, '', e);
        }
        return { start: s, end: e };
      }
      case 'star': {
        const s = newState(); const e = newState();
        const frag = build(node.node);
        add(s, '', frag.start);
        add(s, '', e);
        add(frag.end, '', frag.start);
        add(frag.end, '', e);
        return { start: s, end: e };
      }
      case 'plus': {
        const s = newState(); const e = newState();
        const frag = build(node.node);
        add(s, '', frag.start);
        add(frag.end, '', frag.start);
        add(frag.end, '', e);
        return { start: s, end: e };
      }
      case 'opt': {
        const s = newState(); const e = newState();
        const frag = build(node.node);
        add(s, '', frag.start);
        add(s, '', e);
        add(frag.end, '', e);
        return { start: s, end: e };
      }
      default:
        throw new Error(`unknown AST node type: ${node.type}`);
    }
  }
  const { start, end } = build(ast);
  return { states: trans.length, trans, start, accept: end };
}

function dfaFromNfa(nfa, alphabet) {
  function epsClosure(set) {
    const out = new Set(set);
    const stack = [...set];
    while (stack.length) {
      const s = stack.pop();
      for (const t of nfa.trans[s].get('') ?? []) {
        if (!out.has(t)) { out.add(t); stack.push(t); }
      }
    }
    return out;
  }
  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const startSet = epsClosure(new Set([nfa.start]));
  const ids = new Map([[keyOf(startSet), 0]]);
  const sets = [startSet];
  const trans = [new Map()];
  const accept = new Set();
  if (startSet.has(nfa.accept)) accept.add(0);
  for (let qi = 0; qi < sets.length; qi += 1) {
    const cur = sets[qi];
    for (const a of alphabet) {
      const moved = new Set();
      for (const s of cur) {
        for (const t of nfa.trans[s].get(a) ?? []) moved.add(t);
      }
      if (moved.size === 0) continue;
      const cl = epsClosure(moved);
      const k = keyOf(cl);
      if (!ids.has(k)) {
        ids.set(k, sets.length);
        sets.push(cl);
        trans.push(new Map());
        if (cl.has(nfa.accept)) accept.add(ids.get(k));
      }
      trans[qi].set(a, ids.get(k));
    }
  }
  return { states: sets.length, start: 0, accept, trans };
}

function minimizeDfa(dfa, alphabet) {
  const n = dfa.states;
  const acc = [];
  const non = [];
  for (let s = 0; s < n; s += 1) (dfa.accept.has(s) ? acc : non).push(s);
  let blocks = [];
  if (acc.length) blocks.push(acc);
  if (non.length) blocks.push(non);
  for (;;) {
    const blockOf = new Array(n);
    blocks.forEach((b, bi) => b.forEach((s) => { blockOf[s] = bi; }));
    const next = [];
    let changed = false;
    for (const b of blocks) {
      const groups = new Map();
      for (const s of b) {
        const sig = alphabet
          .map((a) => {
            const t = dfa.trans[s].get(a);
            return t === undefined ? -1 : blockOf[t];
          })
          .join(',');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(s);
      }
      for (const g of groups.values()) next.push(g);
      if (groups.size > 1) changed = true;
    }
    blocks = next;
    if (!changed) break;
  }
  const blockOf = new Array(n);
  blocks.forEach((b, bi) => b.forEach((s) => { blockOf[s] = bi; }));
  const isAcceptBlock = blocks.map((b) => b.some((s) => dfa.accept.has(s)));
  const startBlock = blockOf[dfa.start];
  const idMap = new Map([[startBlock, 0]]);
  const order = [startBlock];
  const trans = [new Map()];
  const accept = new Set();
  if (isAcceptBlock[startBlock]) accept.add(0);
  for (let qi = 0; qi < order.length; qi += 1) {
    const rep = blocks[order[qi]][0];
    for (const a of alphabet) {
      const t = dfa.trans[rep].get(a);
      if (t === undefined) continue;
      const tb = blockOf[t];
      if (!idMap.has(tb)) {
        idMap.set(tb, order.length);
        order.push(tb);
        trans.push(new Map());
        if (isAcceptBlock[tb]) accept.add(idMap.get(tb));
      }
      trans[qi].set(a, idMap.get(tb));
    }
  }
  return { states: order.length, start: 0, accept, trans };
}

function hasLiveAccept(dfa) {
  const seen = new Set([dfa.start]);
  const queue = [dfa.start];
  while (queue.length) {
    const s = queue.shift();
    if (dfa.accept.has(s)) return true;
    for (const t of dfa.trans[s].values()) {
      if (!seen.has(t)) { seen.add(t); queue.push(t); }
    }
  }
  return false;
}

function simulate(dfa, events) {
  const states = [dfa.start];
  let s = dfa.start;
  for (let i = 0; i < events.length; i += 1) {
    const t = dfa.trans[s].get(events[i]);
    if (t === undefined) return { accepted: false, states, failIndex: i };
    s = t;
    states.push(s);
  }
  return { accepted: dfa.accept.has(s), states, failIndex: -1 };
}

module.exports = { nfaFromAst, dfaFromNfa, minimizeDfa, hasLiveAccept, simulate };
