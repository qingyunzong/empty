'use strict';

// Canonical S-expression rendering of an AST node.
function canonical(node) {
  switch (node.type) {
    case 'and':
    case 'or':
      return `(${node.type} ${node.children.map(canonical).join(' ')})`;
    case 'not':
      return `(not ${canonical(node.child)})`;
    case 'text':
      return `(text ${canonicalValue(node.value)})`;
    case 'match':
      return `(match ${node.field} ${canonicalValue(node.value)})`;
    case 'cmp': {
      const op = node.op === '==' ? '=' : node.op;
      return `(cmp ${node.field} ${op} ${canonicalValue(node.value)})`;
    }
    default:
      throw new Error(`Cannot canonicalize node type ${node.type}`);
  }
}

function canonicalValue(value) {
  switch (value.kind) {
    case 'word':
      return `w${JSON.stringify(value.value)}`;
    case 'phrase':
      return `p${JSON.stringify(value.value)}`;
    case 'regex':
      return `r${JSON.stringify(`/${value.value}/${value.flags || ''}`)}`;
    default:
      throw new Error(`Cannot canonicalize value kind ${value.kind}`);
  }
}

// Normalize: flatten nested and/or, drop double negation, dedupe and
// sort children of commutative operators so equivalent queries share
// a single canonical form.
function normalize(node) {
  switch (node.type) {
    case 'and':
    case 'or': {
      const flat = [];
      for (const child of node.children) {
        const nc = normalize(child);
        if (nc.type === node.type) {
          flat.push(...nc.children);
        } else {
          flat.push(nc);
        }
      }
      const byKey = new Map();
      for (const child of flat) {
        byKey.set(canonical(child), child);
      }
      const sorted = [...byKey.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map((entry) => entry[1]);
      if (sorted.length === 1) return sorted[0];
      return { type: node.type, children: sorted };
    }
    case 'not': {
      const child = normalize(node.child);
      if (child.type === 'not') return child.child;
      return { type: 'not', child };
    }
    default:
      return node;
  }
}

module.exports = { normalize, canonical };
