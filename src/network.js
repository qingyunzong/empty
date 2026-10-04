'use strict';
const frames = require('./frames');

// Deterministic in-process link layer. Fault rules match on message fields
// {tx, phase, acct, from, to}; each rule fires on its n-th matching send
// (occurrence: 0-based int) or on every match (occurrence: "all").
class Network {
  constructor(clock, opts) {
    this.clock = clock;
    this.latency = opts.latency ?? 1;
    this.faults = (opts.faults || []).map((f) => ({ ...f, seen: 0, logged: 0 }));
    this.onDeliver = opts.onDeliver;
    this.onEvent = opts.onEvent || (() => {});
    this.frameCounter = 0;
  }
  _matches(rule, ctx) {
    const m = rule.match || {};
    for (const k of Object.keys(m)) if (m[k] !== ctx[k]) return false;
    return true;
  }
  send(from, to, msgFields) {
    const frame = frames.encodeMessage(msgFields);
    const ctx = { from, to, tx: msgFields.tx, phase: msgFields.phase, acct: msgFields.acct };
    let drop = false;
    let delay = 0;
    let copies = 1;
    let chunks = 0;
    let reverse = false;
    for (const rule of this.faults) {
      if (!this._matches(rule, ctx)) continue;
      const applies = rule.occurrence === 'all' || (rule.occurrence ?? 0) === rule.seen;
      rule.seen++;
      if (!applies) continue;
      const tag = `${rule.type} ${ctx.phase} ${from}->${to} tx=${ctx.tx}`;
      if (rule.type === 'drop') {
        drop = true;
        if (rule.logged++ < 3) this.onEvent(`fault ${tag}`);
      } else if (rule.type === 'delay') {
        delay += rule.delay;
        if (rule.logged++ < 3) this.onEvent(`fault ${tag} +${rule.delay}`);
      } else if (rule.type === 'duplicate') {
        copies += rule.times ?? 1;
        if (rule.logged++ < 3) this.onEvent(`fault ${tag} x${copies}`);
      } else if (rule.type === 'fragment') {
        chunks = Math.max(chunks, rule.chunks ?? 2);
        reverse = reverse || !!rule.reverse;
        if (rule.logged++ < 3) this.onEvent(`fault ${tag} chunks=${chunks}`);
      }
    }
    if (drop) return;
    for (let c = 0; c < copies; c++) {
      const fid = `${from}>${to}#${++this.frameCounter}`;
      if (chunks > 1) {
        const parts = frames.fragmentFrame(frame, chunks, fid);
        parts.forEach((p, i) => {
          const extra = reverse ? (parts.length - 1 - i) * this.latency : 0;
          this._schedule(to, { ...p, from }, delay + extra);
        });
      } else {
        this._schedule(to, { frame, from }, delay);
      }
    }
  }
  _schedule(to, payload, delay) {
    this.clock.schedule(this.latency + delay, 0, () => this.onDeliver(to, payload));
  }
}

module.exports = Network;
