'use strict';

const crypto = require('node:crypto');
const { parse, alphabetOf, RegexSyntaxError } = require('./regex');
const {
  compileUnion,
  compileMatch,
  canonicalString,
  scanAccepts,
  distinguishingWitness,
} = require('./automata');

const KINDS = new Set(['red', 'yellow']);

class RuleLibError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RuleLibError';
    this.code = code;
  }
}

class RuleLibrary {
  constructor() {
    this.rules = new Map(); // id -> { id, kind, pattern, ast }
    this.history = []; // applied layers; each layer is a list of prepared ops
    this.redoStack = []; // undone layers, most recent on top
    this._cache = null;
  }

  // Applies one revision layer (a list of add/del ops) atomically: the
  // whole layer is validated against a scratch copy first, so a partial
  // failure never touches the committed state or older layers.
  applyLayer(ops) {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new RuleLibError('a revision layer needs at least one operation', 'empty-layer');
    }
    const temp = new Map(this.rules);
    const prepared = [];
    for (const op of ops) {
      if (op.type === 'add') {
        if (!KINDS.has(op.kind)) {
          throw new RuleLibError(`rule '${op.id}': kind must be 'red' or 'yellow'`, 'bad-kind');
        }
        if (temp.has(op.id)) {
          throw new RuleLibError(`duplicate rule id '${op.id}'`, 'duplicate-id');
        }
        const ast = op.ast || parse(op.pattern); // may throw RegexSyntaxError
        const rule = { id: op.id, kind: op.kind, pattern: op.pattern, ast };
        temp.set(op.id, rule);
        prepared.push({ type: 'add', rule });
      } else if (op.type === 'del') {
        const existing = temp.get(op.id);
        if (!existing) {
          throw new RuleLibError(`unknown rule id '${op.id}'`, 'unknown-id');
        }
        temp.delete(op.id);
        prepared.push({ type: 'del', rule: existing });
      } else {
        throw new RuleLibError(`unknown layer op type '${op.type}'`, 'bad-op');
      }
    }
    this.rules = temp;
    this.history.push(prepared);
    this.redoStack = [];
    this._cache = null;
  }

  undo(k) {
    const n = k === undefined ? 1 : k;
    if (!Number.isInteger(n) || n < 1) {
      throw new RuleLibError(`undo count must be a positive integer, got ${n}`, 'bad-count');
    }
    if (n > this.history.length) {
      throw new RuleLibError(
        `undo out of bounds: requested ${n}, only ${this.history.length} revision(s) available`,
        'undo-out-of-bounds'
      );
    }
    for (let j = 0; j < n; j++) {
      const layer = this.history.pop();
      for (let i = layer.length - 1; i >= 0; i--) {
        const op = layer[i];
        if (op.type === 'add') this.rules.delete(op.rule.id);
        else this.rules.set(op.rule.id, op.rule);
      }
      this.redoStack.push(layer);
    }
    this._cache = null;
  }

  redo(k) {
    const n = k === undefined ? 1 : k;
    if (!Number.isInteger(n) || n < 1) {
      throw new RuleLibError(`redo count must be a positive integer, got ${n}`, 'bad-count');
    }
    if (n > this.redoStack.length) {
      throw new RuleLibError(
        `redo out of bounds: requested ${n}, only ${this.redoStack.length} revision(s) available`,
        'redo-out-of-bounds'
      );
    }
    for (let j = 0; j < n; j++) {
      const layer = this.redoStack.pop();
      for (const op of layer) {
        if (op.type === 'add') this.rules.set(op.rule.id, op.rule);
        else this.rules.delete(op.rule.id);
      }
      this.history.push(layer);
    }
    this._cache = null;
  }

  alphabet() {
    const out = new Set();
    for (const rule of this.rules.values()) alphabetOf(rule.ast, out);
    return [...out].sort();
  }

  _compiled() {
    if (this._cache) return this._cache;
    const alphabet = this.alphabet();
    const perRule = new Map();
    const astsOf = { red: [], yellow: [] };
    for (const rule of this.rules.values()) {
      astsOf[rule.kind].push(rule.ast);
      perRule.set(rule.id, {
        kind: rule.kind,
        occurrenceDfa: compileUnion([rule.ast], alphabet),
        matchDfa: compileMatch(rule.ast, alphabet),
      });
    }
    const redUnion = compileUnion(astsOf.red, alphabet);
    const yellowUnion = compileUnion(astsOf.yellow, alphabet);
    const hash = crypto
      .createHash('sha256')
      .update('red\n' + canonicalString(redUnion, alphabet))
      .update('\nyellow\n' + canonicalString(yellowUnion, alphabet))
      .digest('hex');
    this._cache = { alphabet, perRule, redUnion, yellowUnion, hash };
    return this._cache;
  }

  snapshotHash() {
    return this._compiled().hash;
  }

  // Evaluates a plan event sequence (a string; one character per event).
  evaluate(plan) {
    const c = this._compiled();
    const matchedRed = [];
    const matchedYellow = [];
    for (const [id, r] of c.perRule) {
      if (scanAccepts(r.occurrenceDfa, plan)) {
        (r.kind === 'red' ? matchedRed : matchedYellow).push(id);
      }
    }
    const matchedRuleIds = [...matchedRed, ...matchedYellow].sort();
    const base = { matchedRuleIds, snapshotHash: c.hash };
    if (matchedRed.length > 0) {
      const dfas = matchedRed.map((id) => c.perRule.get(id).matchDfa);
      return { status: 'rejected', ...base, witness: shortestWindow(plan, dfas) };
    }
    if (matchedYellow.length > 0) {
      return { status: 'needs-confirmation', ...base, witness: null };
    }
    return { status: 'feasible', ...base, witness: null };
  }
}

// Shortest substring of `plan` accepted by any of the given full-match
// DFAs, or null. BFS over (position, dfa, state); depth = window length.
function shortestWindow(plan, dfas) {
  for (const d of dfas) {
    if (d.accepts.has(d.start)) return '';
  }
  const visited = new Set();
  let frontier = [];
  for (let i = 0; i <= plan.length; i++) {
    for (let di = 0; di < dfas.length; di++) {
      const key = i + '|' + di + '|' + dfas[di].start;
      if (!visited.has(key)) {
        visited.add(key);
        frontier.push({ start: i, pos: i, d: di, state: dfas[di].start });
      }
    }
  }
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      if (node.pos >= plan.length) continue;
      const t = dfas[node.d].trans[node.state].get(plan[node.pos]);
      if (t === undefined) continue;
      if (dfas[node.d].accepts.has(t)) {
        return plan.slice(node.start, node.pos + 1);
      }
      const key = node.pos + 1 + '|' + node.d + '|' + t;
      if (!visited.has(key)) {
        visited.add(key);
        next.push({ start: node.start, pos: node.pos + 1, d: node.d, state: t });
      }
    }
    frontier = next;
  }
  return null;
}

// Shortest string over the combined alphabet on which the two libraries
// disagree (red or yellow occurrence language), or null if equivalent.
function distinguishingWitnessForLibs(libA, libB) {
  const alphabet = [...new Set([...libA.alphabet(), ...libB.alphabet()])].sort();
  const astsOf = (lib, kind) =>
    [...lib.rules.values()].filter((r) => r.kind === kind).map((r) => r.ast);
  let best = null;
  for (const kind of ['red', 'yellow']) {
    const dA = compileUnion(astsOf(libA, kind), alphabet);
    const dB = compileUnion(astsOf(libB, kind), alphabet);
    const w = distinguishingWitness(dA, dB, alphabet);
    if (w !== null && (best === null || w.length < best.length)) best = w;
  }
  return best;
}

module.exports = {
  RuleLibrary,
  RuleLibError,
  RegexSyntaxError,
  shortestWindow,
  distinguishingWitnessForLibs,
};
