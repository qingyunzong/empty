'use strict';

const dfa = require('./dfa');

class ComplementAlphabetError extends Error {
  constructor() {
    super('complement (~) requires an explicit finite alphabet');
    this.code = 'COMPLEMENT_NO_ALPHABET';
  }
}

// ---------- Thompson NFA construction ----------

class NfaBuilder {
  constructor() {
    this.trans = [];
  }
  addState() {
    this.trans.push([]);
    return this.trans.length - 1;
  }
  add(from, sym, to) {
    this.trans[from].push({ sym, to });
  }
}

// Builds a fragment {start, end} with a single final state.
function buildNfa(node, b, alphabet, explicit) {
  switch (node.type) {
    case 'char': {
      const s = b.addState();
      const e = b.addState();
      b.add(s, node.ch, e);
      return { start: s, end: e };
    }
    case 'eps': {
      const s = b.addState();
      const e = b.addState();
      b.add(s, null, e);
      return { start: s, end: e };
    }
    case 'empty': {
      const s = b.addState();
      const e = b.addState();
      return { start: s, end: e };
    }
    case 'union': {
      const s = b.addState();
      const e = b.addState();
      const l = buildNfa(node.left, b, alphabet, explicit);
      const r = buildNfa(node.right, b, alphabet, explicit);
      b.add(s, null, l.start);
      b.add(s, null, r.start);
      b.add(l.end, null, e);
      b.add(r.end, null, e);
      return { start: s, end: e };
    }
    case 'concat': {
      const l = buildNfa(node.left, b, alphabet, explicit);
      const r = buildNfa(node.right, b, alphabet, explicit);
      b.add(l.end, null, r.start);
      return { start: l.start, end: r.end };
    }
    case 'star': {
      const s = b.addState();
      const e = b.addState();
      const c = buildNfa(node.child, b, alphabet, explicit);
      b.add(s, null, c.start);
      b.add(s, null, e);
      b.add(c.end, null, c.start);
      b.add(c.end, null, e);
      return { start: s, end: e };
    }
    case 'plus': {
      const s = b.addState();
      const e = b.addState();
      const c = buildNfa(node.child, b, alphabet, explicit);
      b.add(s, null, c.start);
      b.add(c.end, null, c.start);
      b.add(c.end, null, e);
      return { start: s, end: e };
    }
    case 'intersect':
    case 'complement': {
      // Automata-level op: compile child(ren) to DFA, combine, splice in as NFA.
      const sub = compile(node, alphabet, explicit);
      const s = b.addState();
      const e = b.addState();
      const base = [];
      for (let i = 0; i < sub.accept.length; i++) base.push(b.addState());
      for (let st = 0; st < sub.accept.length; st++) {
        for (let i = 0; i < sub.alphabet.length; i++) {
          b.add(base[st], sub.alphabet[i], base[sub.trans[st][i]]);
        }
        if (sub.accept[st]) b.add(base[st], null, e);
      }
      b.add(s, null, base[sub.start]);
      return { start: s, end: e };
    }
    default:
      throw new Error(`unknown node type ${node.type}`);
  }
}

// Compile AST to a total DFA over `alphabet`.
// `explicit` records whether the alphabet was user-supplied (required for ~).
function compile(node, alphabet, explicit = true) {
  if (node.type === 'intersect') {
    const l = compile(node.left, alphabet, explicit);
    const r = compile(node.right, alphabet, explicit);
    return dfa.intersect(l, r);
  }
  if (node.type === 'complement') {
    if (!explicit) throw new ComplementAlphabetError();
    return dfa.complement(compile(node.child, alphabet, explicit));
  }
  const b = new NfaBuilder();
  const frag = buildNfa(node, b, alphabet, explicit);
  return dfa.determinize(
    { count: b.trans.length, trans: b.trans, start: frag.start, finals: [frag.end] },
    alphabet,
  );
}

// ---------- Independent reference: Brzozowski derivatives ----------

function nullable(node) {
  switch (node.type) {
    case 'char': return false;
    case 'eps': return true;
    case 'empty': return false;
    case 'union': return nullable(node.left) || nullable(node.right);
    case 'intersect': return nullable(node.left) && nullable(node.right);
    case 'concat': return nullable(node.left) && nullable(node.right);
    case 'star': return true;
    case 'plus': return nullable(node.child);
    case 'complement': return !nullable(node.child);
    default: throw new Error(`unknown node ${node.type}`);
  }
}

function derive(node, c) {
  switch (node.type) {
    case 'char': return node.ch === c ? { type: 'eps' } : { type: 'empty' };
    case 'eps':
    case 'empty': return { type: 'empty' };
    case 'union':
      return { type: 'union', left: derive(node.left, c), right: derive(node.right, c) };
    case 'intersect':
      return { type: 'intersect', left: derive(node.left, c), right: derive(node.right, c) };
    case 'concat': {
      const first = { type: 'concat', left: derive(node.left, c), right: node.right };
      if (!nullable(node.left)) return first;
      return { type: 'union', left: first, right: derive(node.right, c) };
    }
    case 'star':
      return { type: 'concat', left: derive(node.child, c), right: node };
    case 'plus':
      return { type: 'concat', left: derive(node.child, c), right: { type: 'star', child: node.child } };
    case 'complement':
      return { type: 'complement', child: derive(node.child, c) };
    default:
      throw new Error(`unknown node ${node.type}`);
  }
}

// Reference membership test, independent of the NFA/DFA pipeline.
function derivativeMatch(node, word) {
  let cur = node;
  for (const c of word) cur = derive(cur, c);
  return nullable(cur);
}

module.exports = { compile, derivativeMatch, nullable, ComplementAlphabetError };
