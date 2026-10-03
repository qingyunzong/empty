import { crc32 } from './crc32.js';
import { parseLine, evalExpr } from './gcode.js';
import { CncError, E } from './errors.js';

function compare(cmp, l, r) {
  switch (cmp) {
    case 'EQ': return l === r;
    case 'NE': return l !== r;
    case 'GT': return l > r;
    case 'LT': return l < r;
    case 'GE': return l >= r;
    case 'LE': return l <= r;
  }
  throw new CncError(E.FORMAT, `bad comparator ${cmp}`);
}

export class Decoder {
  constructor({ maxDepth = 8, totalBlocks = null } = {}) {
    this.maxDepth = maxDepth;
    this.totalBlocks = totalBlocks;
    this.blocks = new Map(); // seq -> { payload, stmts }
    this.ack = 0; // confirmed prefix length; next needed seq
    this.pc = { seq: 0, line: 0 };
    this.stack = [];
    this.vars = new Map();
    this.pos = { x: 0, y: 0, z: 0 };
    this.events = [];
    this.done = false;
  }

  get complete() {
    return this.totalBlocks !== null && this.ack >= this.totalBlocks;
  }

  ingest({ seq, payload, crc }) {
    const actual = crc32(payload);
    if (actual !== crc) {
      throw new CncError(E.CRC, `block ${seq}: crc mismatch (want ${crc}, got ${actual})`);
    }
    const existing = this.blocks.get(seq);
    if (existing) {
      if (existing.payload === payload) {
        return { duplicate: true, ack: this.ack, next: this.ack };
      }
      throw new CncError(E.DUP, `block ${seq}: conflicting retransmission`);
    }
    this.blocks.set(seq, { payload, stmts: payload.split('\n').map(parseLine) });
    while (this.blocks.has(this.ack)) this.ack++;
    return { duplicate: false, ack: this.ack, next: this.ack };
  }

  findStmt(pred) {
    for (let seq = 0; seq < this.ack; seq++) {
      const { stmts } = this.blocks.get(seq);
      for (let line = 0; line < stmts.length; line++) {
        if (pred(stmts[line])) return { seq, line };
      }
    }
    return null;
  }

  resolveSub(name) {
    return this.findStmt((s) => s.op === 'sub' && s.name === name);
  }

  resolveLabel(n) {
    return this.findStmt((s) => s.label === n);
  }

  advance() {
    this.pc = { seq: this.pc.seq, line: this.pc.line + 1 };
  }

  jump(target) {
    const loc = this.resolveLabel(target);
    if (!loc) {
      if (this.complete) throw new CncError(E.TARGET, `missing label N${target}`);
      return true; // stall until more blocks arrive
    }
    this.pc = loc;
    return false;
  }

  skipSub() {
    let seq = this.pc.seq;
    let line = this.pc.line + 1;
    for (;;) {
      if (seq >= this.ack) {
        if (this.complete) throw new CncError(E.TARGET, 'unterminated subroutine');
        return true;
      }
      const { stmts } = this.blocks.get(seq);
      if (line >= stmts.length) { seq++; line = 0; continue; }
      if (stmts[line].op === 'ret') {
        this.pc = { seq, line: line + 1 };
        return false;
      }
      line++;
    }
  }

  exec(stmt) {
    switch (stmt.op) {
      case 'nop':
        this.advance();
        return false;
      case 'move': {
        const c = stmt.coords;
        if (c.X !== undefined) this.pos.x = c.X;
        if (c.Y !== undefined) this.pos.y = c.Y;
        if (c.Z !== undefined) this.pos.z = c.Z;
        this.events.push({ type: 'move', g: stmt.g, x: this.pos.x, y: this.pos.y, z: this.pos.z });
        this.advance();
        return false;
      }
      case 'assign':
        this.vars.set(stmt.var, evalExpr(stmt.expr, this.vars));
        this.advance();
        return false;
      case 'goto':
        return this.jump(stmt.target);
      case 'ifgoto': {
        const l = evalExpr(stmt.left, this.vars);
        const r = evalExpr(stmt.right, this.vars);
        if (compare(stmt.cmp, l, r)) return this.jump(stmt.target);
        this.advance();
        return false;
      }
      case 'call': {
        const loc = this.resolveSub(stmt.name);
        if (!loc) {
          if (this.complete) throw new CncError(E.TARGET, `missing subroutine ${stmt.name}`);
          return true;
        }
        if (this.stack.length >= this.maxDepth) {
          throw new CncError(E.DEPTH, `call depth exceeds ${this.maxDepth}`);
        }
        this.stack.push({ seq: this.pc.seq, line: this.pc.line + 1 });
        this.pc = { seq: loc.seq, line: loc.line + 1 };
        return false;
      }
      case 'ret': {
        const ret = this.stack.pop();
        if (!ret) { this.done = true; return false; }
        this.pc = ret;
        return false;
      }
      case 'sub':
        return this.skipSub();
      case 'end':
        this.done = true;
        return false;
    }
    throw new CncError(E.FORMAT, `unknown op ${stmt.op}`);
  }

  run() {
    const start = this.events.length;
    while (!this.done) {
      if (this.pc.seq >= this.ack) {
        if (this.complete) this.done = true; // fell off the end of a fully received program
        break;
      }
      const { stmts } = this.blocks.get(this.pc.seq);
      if (this.pc.line >= stmts.length) {
        this.pc = { seq: this.pc.seq + 1, line: 0 };
        continue;
      }
      if (this.exec(stmts[this.pc.line])) break; // stalled on unconfirmed data
    }
    return { done: this.done, stalled: !this.done, events: this.events.slice(start) };
  }

  snapshot() {
    return {
      maxDepth: this.maxDepth,
      totalBlocks: this.totalBlocks,
      blocks: [...this.blocks.entries()].map(([seq, b]) => ({ seq, payload: b.payload })),
      pc: this.pc,
      stack: this.stack,
      vars: [...this.vars.entries()],
      pos: this.pos,
      events: this.events,
      done: this.done,
    };
  }

  static restore(snap) {
    const dec = new Decoder({ maxDepth: snap.maxDepth, totalBlocks: snap.totalBlocks });
    for (const { seq, payload } of snap.blocks) {
      dec.blocks.set(seq, { payload, stmts: payload.split('\n').map(parseLine) });
    }
    while (dec.blocks.has(dec.ack)) dec.ack++;
    dec.pc = snap.pc;
    dec.stack = snap.stack;
    dec.vars = new Map(snap.vars);
    dec.pos = snap.pos;
    dec.events = snap.events;
    dec.done = snap.done;
    return dec;
  }
}
