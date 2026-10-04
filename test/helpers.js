'use strict';

const { parseRegex } = require('../lib/regex');

// Independent matcher: direct recursive backtracking over the regex AST.
// Shares no code with the NFA/DFA engine, so brute-force enumeration with
// this matcher is a genuine cross-check of the automata pipeline.
function makeMatcher(pattern) {
  const ast = typeof pattern === 'string' ? parseRegex(pattern) : pattern;

  function inClass(node, cp) {
    for (const [lo, hi] of node.intervals) {
      if (cp >= lo && cp <= hi) return true;
    }
    return false;
  }

  function matchNode(node, cps, i, k) {
    switch (node.type) {
      case 'empty':
        return k(i);
      case 'char':
        return i < cps.length && cps[i] === node.code && k(i + 1);
      case 'class':
        return i < cps.length && inClass(node, cps[i]) && k(i + 1);
      case 'concat':
        return matchSeq(node.parts, 0, cps, i, k);
      case 'union':
        return node.options.some((o) => matchNode(o, cps, i, k));
      case 'opt':
        return matchNode(node.child, cps, i, k) || k(i);
      case 'star':
        return matchStar(node.child, cps, i, k);
      default:
        throw new Error(`unknown node type ${node.type}`);
    }
  }

  function matchSeq(parts, p, cps, i, k) {
    if (p === parts.length) return k(i);
    return matchNode(parts[p], cps, i, (j) => matchSeq(parts, p + 1, cps, j, k));
  }

  function matchStar(child, cps, i, k) {
    // j !== i guards against empty-loop divergence on nullable children.
    return matchNode(child, cps, i, (j) => j !== i && matchStar(child, cps, j, k)) || k(i);
  }

  return (s) => {
    const cps = [...s].map((c) => c.codePointAt(0));
    return matchNode(ast, cps, 0, (j) => j === cps.length);
  };
}

function makeSetMatcher(patterns) {
  const matchers = patterns.map(makeMatcher);
  return (s) => matchers.some((m) => m(s));
}

// All strings over `alphabet` with length 0..maxLen.
function enumerateStrings(alphabet, maxLen) {
  const out = [''];
  let cur = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next = [];
    for (const s of cur) {
      for (const c of alphabet) next.push(s + c);
    }
    out.push(...next);
    cur = next;
  }
  return out;
}

// Order used for witnesses: shortest first, then numerically by code point.
function witnessOrder(a, b) {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { makeMatcher, makeSetMatcher, enumerateStrings, witnessOrder };
