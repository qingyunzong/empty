'use strict';

const { ALPHABET } = require('./tokens');

// Independent verifier: naive backtracking matcher directly over the rule AST.
// Shares no code with the NFA/DFA pipeline, so it can cross-check witnesses.

function matchPositions(node, tokens, pos) {
  switch (node.type) {
    case 'empty':
      return new Set([pos]);
    case 'token':
      return pos < tokens.length && node.tokens.includes(tokens[pos])
        ? new Set([pos + 1])
        : new Set();
    case 'concat': {
      let current = new Set([pos]);
      for (const part of node.parts) {
        const nextSet = new Set();
        for (const p of current) {
          for (const q of matchPositions(part, tokens, p)) nextSet.add(q);
        }
        current = nextSet;
        if (current.size === 0) break;
      }
      return current;
    }
    case 'alt': {
      const out = new Set();
      for (const opt of node.options) {
        for (const q of matchPositions(opt, tokens, pos)) out.add(q);
      }
      return out;
    }
    case 'opt': {
      const out = matchPositions(node.expr, tokens, pos);
      out.add(pos);
      return out;
    }
    case 'star': {
      const reachable = new Set([pos]);
      const frontier = [pos];
      while (frontier.length) {
        const p = frontier.pop();
        for (const q of matchPositions(node.expr, tokens, p)) {
          if (!reachable.has(q)) {
            reachable.add(q);
            frontier.push(q);
          }
        }
      }
      return reachable;
    }
    case 'plus': {
      const first = matchPositions(node.expr, tokens, pos);
      const out = new Set();
      for (const p of first) {
        for (const q of matchPositions({ type: 'star', expr: node.expr }, tokens, p)) {
          out.add(q);
        }
      }
      return out;
    }
    default:
      throw new Error(`unsupported node: ${node.type}`);
  }
}

// Full-string match: does the AST match the entire token sequence?
function bruteMatch(ast, tokens) {
  return matchPositions(ast, tokens, 0).has(tokens.length);
}

// Enumerate all token strings of length 0..maxLen in lexicographic order
// (alphabet order, shorter first) and return the first string on which the
// two ASTs disagree, or null. Independent of the DFA equivalence checker.
function enumerateDivergence(astsA, astsB, maxLen) {
  const matchesA = (toks) => astsA.some((a) => bruteMatch(a, toks));
  const matchesB = (toks) => astsB.some((a) => bruteMatch(a, toks));
  const current = [];
  function* strings(len) {
    if (len === 0) {
      yield current.slice();
      return;
    }
    for (const tok of ALPHABET) {
      current.push(tok);
      yield* strings(len - 1);
      current.pop();
    }
  }
  for (let len = 0; len <= maxLen; len++) {
    for (const s of strings(len)) {
      if (matchesA(s) !== matchesB(s)) return s;
    }
  }
  return null;
}

module.exports = { bruteMatch, enumerateDivergence };
