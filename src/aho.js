'use strict';

// Aho-Corasick multi-pattern exact matcher.
// scan(text) returns all (possibly overlapping) occurrences plus the
// automaton state trajectory (state id after each consumed char, states[0]
// is the root before any input) for audit replay.
class AhoCorasick {
  constructor(patterns) {
    this.next = [Object.create(null)];
    this.fail = [0];
    this.out = [[]];
    for (const { id, pattern } of patterns) this._add(id, pattern);
    this._build();
    this.stateCount = this.next.length;
  }

  _add(id, pattern) {
    let s = 0;
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i];
      if (this.next[s][ch] === undefined) {
        this.next.push(Object.create(null));
        this.fail.push(0);
        this.out.push([]);
        this.next[s][ch] = this.next.length - 1;
      }
      s = this.next[s][ch];
    }
    this.out[s].push({ id, len: pattern.length });
  }

  _build() {
    const queue = [];
    for (const ch of Object.keys(this.next[0])) queue.push(this.next[0][ch]);
    while (queue.length) {
      const s = queue.shift();
      for (const ch of Object.keys(this.next[s])) {
        const t = this.next[s][ch];
        queue.push(t);
        let f = this.fail[s];
        while (f !== 0 && this.next[f][ch] === undefined) f = this.fail[f];
        const g = this.next[f][ch];
        this.fail[t] = g !== undefined && g !== t ? g : 0;
        if (this.out[this.fail[t]].length) {
          this.out[t] = this.out[t].concat(this.out[this.fail[t]]);
        }
      }
    }
  }

  scan(text) {
    const hits = [];
    const states = [0];
    let s = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      while (s !== 0 && this.next[s][ch] === undefined) s = this.fail[s];
      const nxt = this.next[s][ch];
      s = nxt === undefined ? 0 : nxt;
      states.push(s);
      for (const o of this.out[s]) {
        hits.push({ start: i - o.len + 1, length: o.len, ruleId: o.id });
      }
    }
    return { hits, states };
  }
}

module.exports = { AhoCorasick };
