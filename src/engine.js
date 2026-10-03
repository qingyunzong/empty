'use strict';

const crypto = require('node:crypto');
const { parse, literalsOf, RegexSyntaxError } = require('./regex');
const automata = require('./automata');

const LEVELS = ['red', 'yellow'];

class RuleError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RuleError';
    Object.assign(this, details);
  }
}

// A rule base with two rule levels (red = forbidden, yellow = needs
// confirmation), an incrementally maintained DFA decider per level, and
// layered undo/redo. Every mutating operation is atomic: validation happens
// before any state change, so a failed operation never pollutes existing
// layers.
class RuleBase {
  constructor() {
    this.rules = new Map(); // id -> { level, pattern, ast }
    this.layers = [];       // applied revisions, oldest first
    this.redoStack = [];    // undone revisions, most recently undone on top
    this._levelVersion = { red: 0, yellow: 0 };
    this._alphabet = [];
    this._alphabetVersion = 0;
    this._levelCache = new Map(); // `${level}\n${alphabet}` -> {version, alphaVersion, dfa}
    this._ruleCache = new Map();  // id -> { pattern, literalSet, sentinel, full, contains }
  }

  static get LEVELS() {
    return LEVELS;
  }

  alphabet() {
    return this._alphabet.slice();
  }

  _recomputeAlphabet() {
    const set = new Set();
    for (const r of this.rules.values()) {
      for (const c of literalsOf(r.ast)) set.add(c);
    }
    const next = [...set].sort();
    if (next.join('') !== this._alphabet.join('')) {
      this._alphabet = next;
      this._alphabetVersion++;
    }
  }

  _bump(level) {
    this._levelVersion[level]++;
    this._recomputeAlphabet();
  }

  add(id, level, pattern) {
    if (typeof id !== 'string' || id === '') {
      throw new RuleError('add requires a non-empty string id', { code: 'BAD_ID' });
    }
    if (!LEVELS.includes(level)) {
      throw new RuleError(`add requires level "red" or "yellow", got ${JSON.stringify(level)}`, { code: 'BAD_LEVEL' });
    }
    if (typeof pattern !== 'string') {
      throw new RuleError('add requires a string pattern', { code: 'BAD_PATTERN' });
    }
    const ast = parse(pattern); // throws RegexSyntaxError before any mutation
    if (this.rules.has(id)) {
      throw new RuleError(`duplicate rule id: ${id}`, { code: 'DUP_ID', id });
    }
    this.rules.set(id, { level, pattern, ast });
    this.layers.push({ op: 'add', id, level, pattern });
    this.redoStack.length = 0;
    this._bump(level);
  }

  del(id) {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new RuleError(`unknown rule id: ${id}`, { code: 'UNKNOWN_ID', id });
    }
    this.rules.delete(id);
    this._ruleCache.delete(id);
    this.layers.push({ op: 'del', id, level: rule.level, pattern: rule.pattern });
    this.redoStack.length = 0;
    this._bump(rule.level);
  }

  undo(k = 1) {
    if (!Number.isInteger(k) || k < 1) {
      throw new RuleError(`undo requires a positive integer k, got ${JSON.stringify(k)}`, { code: 'BAD_K' });
    }
    if (k > this.layers.length) {
      throw new RuleError(`undo out of range: requested ${k}, depth ${this.layers.length}`, {
        code: 'UNDO_RANGE', requested: k, depth: this.layers.length,
      });
    }
    for (let i = 0; i < k; i++) {
      const layer = this.layers.pop();
      if (layer.op === 'add') {
        this.rules.delete(layer.id);
        this._ruleCache.delete(layer.id);
      } else {
        this.rules.set(layer.id, { level: layer.level, pattern: layer.pattern, ast: parse(layer.pattern) });
      }
      this.redoStack.push(layer);
      this._bump(layer.level);
    }
  }

  redo(k = 1) {
    if (!Number.isInteger(k) || k < 1) {
      throw new RuleError(`redo requires a positive integer k, got ${JSON.stringify(k)}`, { code: 'BAD_K' });
    }
    if (k > this.redoStack.length) {
      throw new RuleError(`redo out of range: requested ${k}, depth ${this.redoStack.length}`, {
        code: 'REDO_RANGE', requested: k, depth: this.redoStack.length,
      });
    }
    for (let i = 0; i < k; i++) {
      const layer = this.redoStack.pop();
      if (layer.op === 'add') {
        this.rules.set(layer.id, { level: layer.level, pattern: layer.pattern, ast: parse(layer.pattern) });
      } else {
        this.rules.delete(layer.id);
        this._ruleCache.delete(layer.id);
      }
      this.layers.push(layer);
      this._bump(layer.level);
    }
  }

  // Minimized "contains" DFA for one level over an explicit alphabet.
  // Cached per (level, alphabet); invalidated only when that level's rules
  // or the alphabet change, so edits to one level never recompile the other.
  _levelDfa(level, alphabet) {
    const key = level + '\n' + alphabet.join('');
    const cached = this._levelCache.get(key);
    if (
      cached &&
      cached.version === this._levelVersion[level] &&
      cached.alphaVersion === this._alphabetVersion
    ) {
      return cached.dfa;
    }
    const asts = [];
    for (const r of this.rules.values()) {
      if (r.level === level) asts.push(r.ast);
    }
    const dfa = automata.compileContains(asts, alphabet);
    this._levelCache.set(key, {
      version: this._levelVersion[level],
      alphaVersion: this._alphabetVersion,
      dfa,
    });
    return dfa;
  }

  // Per-rule DFAs compiled over the rule's own literals plus a sentinel
  // character standing for "any other character" (all characters outside a
  // pattern's literals behave identically in its contains-automaton).
  _ruleDfas(id) {
    const rule = this.rules.get(id);
    const cached = this._ruleCache.get(id);
    if (cached && cached.pattern === rule.pattern) return cached;
    const literalSet = literalsOf(rule.ast);
    let code = 0;
    while (literalSet.has(String.fromCodePoint(code))) code++;
    const sentinel = String.fromCodePoint(code);
    const alphabet = [...literalSet].sort().concat(sentinel);
    const entry = {
      pattern: rule.pattern,
      literalSet,
      sentinel,
      full: automata.compileFull([rule.ast], alphabet),
      contains: automata.compileContains([rule.ast], alphabet),
    };
    this._ruleCache.set(id, entry);
    return entry;
  }

  _mapCharFor(entry) {
    const { literalSet, sentinel } = entry;
    return (ch) => (literalSet.has(ch) ? ch : sentinel);
  }

  // Classify a plan event sequence.
  //   reject   - at least one red rule matches (red wins over yellow)
  //   confirm  - no red match, at least one yellow rule matches
  //   feasible - no rule matches
  // witness is the shortest matched substring of the decisive level.
  classify(plan) {
    const redIds = [];
    const yellowIds = [];
    for (const [id, rule] of this.rules) {
      const dfas = this._ruleDfas(id);
      if (automata.acceptsString(dfas.contains, plan, this._mapCharFor(dfas))) {
        (rule.level === 'red' ? redIds : yellowIds).push(id);
      }
    }
    const decisive = redIds.length ? redIds : yellowIds;
    decisive.sort();
    let witness = null;
    if (decisive.length) {
      for (const id of decisive) {
        const dfas = this._ruleDfas(id);
        const w = automata.shortestAcceptedSubstring(dfas.full, plan, this._mapCharFor(dfas));
        if (w !== null && (witness === null || w.length < witness.length || (w.length === witness.length && w < witness))) {
          witness = w;
        }
      }
    }
    return {
      status: redIds.length ? 'reject' : yellowIds.length ? 'confirm' : 'feasible',
      matchedRuleIds: decisive,
      witness,
    };
  }

  // Hash of the canonical minimal DFAs of both levels over the rule-induced
  // alphabet. Equivalent rewrites of the rule set (same alphabet, same
  // matched languages) yield the same hash.
  snapshotHash() {
    const alphabet = this._alphabet;
    const parts = [
      'factory-rule-snapshot/v1',
      'alphabet=' + alphabet.map(automata.escapeChar).join(','),
      'red=' + automata.canonicalSerialize(this._levelDfa('red', alphabet), alphabet),
      'yellow=' + automata.canonicalSerialize(this._levelDfa('yellow', alphabet), alphabet),
      '',
    ];
    return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  // Equivalence of the two rule sets (red vs red, yellow vs yellow) over the
  // union alphabet. Returns { equal, level, witness } where witness is a
  // shortest string matched by exactly one side (null when equal).
  equivalentTo(other) {
    const alphabet = [...new Set([...this._alphabet, ...other._alphabet])].sort();
    for (const level of LEVELS) {
      const d1 = this._levelDfa(level, alphabet);
      const d2 = other._levelDfa(level, alphabet);
      const witness = automata.shortestDistinguishing(d1, d2, alphabet);
      if (witness !== null) {
        return { equal: false, level, witness };
      }
    }
    return { equal: true, level: null, witness: null };
  }
}

module.exports = { RuleBase, RuleError, RegexSyntaxError, LEVELS };
