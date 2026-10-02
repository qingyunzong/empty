'use strict';

// Independent backtracking matcher over the regex AST. Used to cross-check
// the DFA pipeline in tests; shares no code with src/automata.js.

// Returns the set of end positions reachable from `pos` by matching `node`.
function matchEnds(node, str, pos, alphabet) {
  switch (node.type) {
    case 'eps':
      return new Set([pos]);
    case 'lit':
      return pos < str.length && str[pos] === node.ch
        ? new Set([pos + 1])
        : new Set();
    case 'any':
      return pos < str.length && alphabet.includes(str[pos])
        ? new Set([pos + 1])
        : new Set();
    case 'class': {
      if (pos >= str.length) return new Set();
      const ch = str[pos];
      const inClass = node.chars.includes(ch);
      const ok = node.negate
        ? !inClass && alphabet.includes(ch)
        : inClass;
      return ok ? new Set([pos + 1]) : new Set();
    }
    case 'concat': {
      let cur = new Set([pos]);
      for (const part of node.parts) {
        const next = new Set();
        for (const p of cur) {
          for (const e of matchEnds(part, str, p, alphabet)) next.add(e);
        }
        cur = next;
        if (cur.size === 0) break;
      }
      return cur;
    }
    case 'alt': {
      const out = new Set();
      for (const opt of node.options) {
        for (const e of matchEnds(opt, str, pos, alphabet)) out.add(e);
      }
      return out;
    }
    case 'opt': {
      const out = matchEnds(node.expr, str, pos, alphabet);
      out.add(pos);
      return out;
    }
    case 'star': {
      const seen = new Set([pos]);
      const stack = [pos];
      while (stack.length) {
        const p = stack.pop();
        for (const e of matchEnds(node.expr, str, p, alphabet)) {
          if (!seen.has(e)) {
            seen.add(e);
            stack.push(e);
          }
        }
      }
      return seen;
    }
    case 'plus': {
      const out = new Set();
      for (const e of matchEnds(node.expr, str, pos, alphabet)) {
        for (const e2 of matchEnds({ type: 'star', expr: node.expr }, str, e, alphabet)) {
          out.add(e2);
        }
      }
      return out;
    }
    default:
      throw new Error(`unknown AST node type: ${node.type}`);
  }
}

// Occurrence semantics: does the pattern match anywhere in `str`?
function search(ast, str, alphabet) {
  for (let i = 0; i <= str.length; i++) {
    if (matchEnds(ast, str, i, alphabet).size > 0) return true;
  }
  return false;
}

// Full-match semantics: does the pattern match all of `str`?
function fullMatch(ast, str, alphabet) {
  return matchEnds(ast, str, 0, alphabet).has(str.length);
}

module.exports = { matchEnds, search, fullMatch };
