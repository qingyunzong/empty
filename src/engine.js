'use strict';

const { encodeFrame, decodeFrame, chunkFrame } = require('./frame');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lessEvent(a, b) {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (lessEvent(a[i], a[p])) {
        [a[i], a[p]] = [a[p], a[i]];
        i = p;
      } else {
        break;
      }
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && lessEvent(a[l], a[m])) m = l;
        if (r < a.length && lessEvent(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

class Engine {
  constructor(opts = {}) {
    this.now = 0;
    this.maxTime = opts.maxTime ?? 5000;
    this.heap = new MinHeap();
    this.eventSeq = 0;
    this.msgSeq = 0;
    this.nodes = new Map();
    this.disks = new Map();
    this.factories = new Map();
    this.faults = (opts.faults || []).map((f) => ({ times: Infinity, used: 0, ...f }));
    this.crashSpecs = (opts.crashes || []).map((c) => ({ restartDelay: 5, consumed: false, ...c }));
    this.fragmentSize = opts.fragmentSize || 0;
    this.reorder = !!opts.reorder;
    this.rng = mulberry32(opts.seed ?? 1);
    this.coordId = 'COORD';
    this.stats = { sent: 0, dropped: 0, duplicated: 0, corrupted: 0, crcErrors: 0, delivered: 0 };
    this.errors = [];
  }

  register(nodeId, disk, factory) {
    this.disks.set(nodeId, disk);
    this.factories.set(nodeId, factory);
    this.nodes.set(nodeId, factory(disk));
  }

  schedule(delay, fn) {
    const time = this.now + Math.max(0, delay);
    if (time > this.maxTime) return;
    this.heap.push({ time, seq: this.eventSeq++, fn });
  }

  error(type, detail) {
    this.errors.push({ type, ...detail });
  }

  maybeCrash(nodeId, tx, point) {
    for (const spec of this.crashSpecs) {
      if (spec.consumed) continue;
      if (spec.node !== nodeId || spec.point !== point) continue;
      if (spec.tx !== undefined && spec.tx !== tx) continue;
      spec.consumed = true;
      const node = this.nodes.get(nodeId);
      if (node) node.crashed = true;
      this.schedule(spec.restartDelay, () => this.restart(nodeId));
      return true;
    }
    return false;
  }

  restart(nodeId) {
    const factory = this.factories.get(nodeId);
    if (!factory) return;
    this.nodes.set(nodeId, factory(this.disks.get(nodeId)));
  }

  matchFaults(msgIndex, from, to, msg) {
    const actions = [];
    for (const f of this.faults) {
      if (f.used >= f.times) continue;
      if (f.msgIndex !== undefined && f.msgIndex !== msgIndex) continue;
      if (f.from !== undefined && f.from !== from) continue;
      if (f.to !== undefined && f.to !== to) continue;
      if (f.phase !== undefined && f.phase !== msg.phase) continue;
      if (f.tx !== undefined && f.tx !== msg.tx) continue;
      if (f.acct !== undefined && f.acct !== msg.acct) continue;
      f.used += 1;
      actions.push(f.action);
    }
    return actions;
  }

  send(from, to, msg) {
    const sender = this.nodes.get(from);
    const seq = sender ? sender.nextSeq() : 0;
    const full = { ack: '', reason: '', ...msg, seq };
    const frame = encodeFrame(full);
    const frameId = from + '#' + seq;
    const chunks = chunkFrame(frameId, frame, this.fragmentSize);
    const msgIndex = this.msgSeq++;
    this.stats.sent += 1;
    const actions = this.matchFaults(msgIndex, from, to, full);
    let copies = 1;
    let extraDelay = 0;
    let dupExtraDelay = 0;
    let drop = false;
    let corrupt = false;
    for (const a of actions) {
      if (a === 'drop') drop = true;
      else if (a === 'dup') copies += 1;
      else if (a.startsWith('dup:')) {
        copies += 1;
        dupExtraDelay += Number(a.slice(4)) || 0;
      } else if (a === 'corrupt') corrupt = true;
      else if (a.startsWith('delay:')) extraDelay += Number(a.slice(6)) || 0;
    }
    if (drop) {
      this.stats.dropped += 1;
      return;
    }
    if (corrupt) this.stats.corrupted += 1;
    if (copies > 1) this.stats.duplicated += copies - 1;
    for (let c = 0; c < copies; c++) {
      for (let ci = 0; ci < chunks.length; ci++) {
        let data = chunks[ci].data;
        if (corrupt && c === 0 && ci === 0 && data.length > 0) {
          data = String.fromCharCode(data.charCodeAt(0) ^ 1) + data.slice(1);
        }
        let d = 1 + extraDelay + (c > 0 ? dupExtraDelay : 0);
        if (this.reorder) d += Math.floor(this.rng() * 4);
        const out = { ...chunks[ci], data };
        this.schedule(d, () => this.deliver(to, out));
      }
    }
  }

  deliver(to, chunk) {
    const node = this.nodes.get(to);
    if (!node || node.crashed) {
      this.stats.dropped += 1;
      return;
    }
    const frameStr = node.reassembler.push(chunk);
    if (frameStr === null) return;
    const res = decodeFrame(frameStr);
    if (!res.ok) {
      this.stats.crcErrors += 1;
      return;
    }
    this.stats.delivered += 1;
    node.onMessage(res.msg);
  }

  run() {
    let guard = 0;
    while (this.heap.size > 0) {
      if (++guard > 1000000) throw new Error('event guard tripped');
      const ev = this.heap.pop();
      this.now = ev.time;
      ev.fn();
    }
  }
}

module.exports = { Engine, MinHeap, mulberry32 };
