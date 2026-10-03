'use strict';

// Aho-Corasick automaton for exact multi-pattern matching.
class AhoCorasick {
  constructor() {
    this.next = [new Map()]; // goto edges per state
    this.fail = [0];
    this.out = [[]]; // outputs per state: [{ruleId, len, pattern}]
  }

  add(pattern, ruleId) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw new Error('empty exact pattern');
    }
    let s = 0;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      let t = this.next[s].get(ch);
      if (t === undefined) {
        t = this.next.length;
        this.next.push(new Map());
        this.fail.push(0);
        this.out.push([]);
        this.next[s].set(ch, t);
      }
      s = t;
    }
    this.out[s].push({ ruleId, len: pattern.length, pattern });
  }

  build() {
    const queue = [];
    for (const t of this.next[0].values()) {
      this.fail[t] = 0;
      queue.push(t);
    }
    while (queue.length) {
      const r = queue.shift();
      for (const [ch, t] of this.next[r]) {
        queue.push(t);
        let f = this.fail[r];
        while (f !== 0 && !this.next[f].has(ch)) f = this.fail[f];
        const g = this.next[f].get(ch);
        this.fail[t] = g === undefined || g === t ? 0 : g;
        if (this.out[this.fail[t]].length) {
          this.out[t] = this.out[t].concat(this.out[this.fail[t]]);
        }
      }
    }
  }

  stateCount() {
    return this.next.length;
  }

  // Scan text, return hits [{start, end, ruleId}] (end exclusive, code-unit indexes).
  scan(text) {
    const hits = [];
    let s = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (s !== 0 && !this.next[s].has(ch)) s = this.fail[s];
      const t = this.next[s].get(ch);
      s = t === undefined ? 0 : t;
      for (const o of this.out[s]) {
        hits.push({ start: i - o.len + 1, end: i + 1, ruleId: o.ruleId });
      }
    }
    return hits;
  }

  // Deterministic trie walk for a known pattern (used for proof trajectories).
  trajectory(pattern) {
    const states = [0];
    let s = 0;
    for (let i = 0; i < pattern.length; i++) {
      const t = this.next[s].get(pattern[i]);
      if (t === undefined) return null;
      s = t;
      states.push(s);
    }
    return states;
  }
}

module.exports = { AhoCorasick };
