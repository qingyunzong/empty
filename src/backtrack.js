'use strict';

// Independent backtracking matcher over the regex AST. Deliberately shares
// no code with the automata pipeline so tests can cross-check the two.

// Full match: does `ast` match s.slice(i, j) for some j with k(j) true?
function matchNode(node, s, i, k) {
  switch (node.type) {
    case 'eps':
      return k(i);
    case 'lit':
      return i < s.length && s[i] === node.char && k(i + 1);
    case 'cat':
      return matchSeq(node.parts, 0, s, i, k);
    case 'alt':
      return node.branches.some((b) => matchNode(b, s, i, k));
    case 'opt':
      return k(i) || matchNode(node.child, s, i, k);
    case 'star':
      return matchStar(node.child, s, i, k);
    case 'plus':
      return matchNode(node.child, s, i, (j) => j > i && matchStar(node.child, s, j, k));
    default:
      throw new Error(`unknown AST node type: ${node.type}`);
  }
}

function matchSeq(parts, idx, s, i, k) {
  if (idx === parts.length) return k(i);
  return matchNode(parts[idx], s, i, (j) => matchSeq(parts, idx + 1, s, j, k));
}

function matchStar(child, s, i, k) {
  // j > i guard prevents infinite recursion on nullable children.
  return k(i) || matchNode(child, s, i, (j) => j > i && matchStar(child, s, j, k));
}

// Does `ast` match the whole string s?
function fullMatch(ast, s) {
  return matchNode(ast, s, 0, (j) => j === s.length);
}

// Does `ast` match some substring of s?
function containsMatch(ast, s) {
  for (let start = 0; start <= s.length; start++) {
    if (matchNode(ast, s, start, () => true)) return true;
  }
  return false;
}

module.exports = { fullMatch, containsMatch };
