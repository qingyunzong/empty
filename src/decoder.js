import { crc32 } from './crc32.js';

export class DecodeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
  }
}

// Incremental decoder / execution engine.
//
// Blocks arrive by sequence number (any order, duplicates allowed) and are
// confirmed as a contiguous prefix. Execution starts at the main program
// entry and advances as far as the confirmed blocks allow, maintaining a
// call stack across M98 (call) / M99 (return). GOTO N<label> branches
// within the current program.
//
// Errors: E_CRC (corrupt block), E_DEPTH (nesting over maxDepth),
// E_TARGET (missing subroutine or jump label).
export class Decoder {
  constructor(index, { maxDepth = 8, recordTrace = true } = {}) {
    this.index = index;
    this.maxDepth = maxDepth;
    this.recordTrace = recordTrace;
    this.blocks = new Map(); // seq -> lines[]
    this.trace = []; // recorded executed lines (when recordTrace)
    this.executedCount = 0; // executed lines including unrecorded replay
    this.stack = []; // return addresses { prog, seq, line }
    this.pc = null;
    this.done = false;
  }

  // Number of contiguous confirmed blocks starting at seq 0.
  get confirmed() {
    let seq = 0;
    while (this.blocks.has(seq)) seq++;
    return seq;
  }

  // Next sequence number the sender should transmit, or null when complete.
  get nextSeq() {
    const c = this.confirmed;
    return c < this.index.blockCount ? c : null;
  }

  // Feed one block. CRC is verified; retransmitted blocks are deduped by
  // sequence number and never re-executed.
  addBlock(seq, crc, payload) {
    if (this.blocks.has(seq)) return { duplicate: true };
    if (crc32(payload) !== crc) {
      throw new DecodeError('E_CRC', `block ${seq}: crc mismatch`);
    }
    const text = payload.toString('utf8');
    this.blocks.set(seq, text.length === 0 ? [] : text.split('\n'));
    return { duplicate: false };
  }

  // Advance execution until the program ends or a needed block is missing.
  run() {
    if (this.pc === null && !this.done) {
      const mainInfo = this.index.programs[this.index.main];
      if (!mainInfo) throw new DecodeError('E_TARGET', `unknown main program: ${this.index.main}`);
      this.pc = { prog: this.index.main, seq: mainInfo.start + mainInfo.entry, line: 0 };
    }
    while (!this.done && this.step()) {
      // advance until blocked or done
    }
    return this.status();
  }

  status() {
    return {
      done: this.done,
      confirmed: this.confirmed,
      nextSeq: this.nextSeq,
      waitingFor: this.done ? null : this.pc.seq,
      trace: this.trace,
    };
  }

  // One execution step. Returns false when blocked on a missing block.
  step() {
    const progInfo = this.index.programs[this.pc.prog];
    const lines = this.blocks.get(this.pc.seq);
    if (!lines) return false;

    if (this.pc.line >= lines.length) {
      if (this.pc.seq < progInfo.end) {
        this.pc = { prog: this.pc.prog, seq: this.pc.seq + 1, line: 0 };
      } else {
        this.returnFromSub(); // falling off the end behaves like M99
      }
      return true;
    }

    const text = lines[this.pc.line];
    const tokens = text.split(/\s+/);

    if (tokens.includes('M98')) {
      const ptoken = tokens.find((t) => /^P/i.test(t));
      const name = ptoken ? ptoken.slice(1) : null;
      const target = name ? this.index.programs[name] : null;
      if (!target) throw new DecodeError('E_TARGET', `missing subroutine: ${name ?? '(none)'}`);
      if (this.stack.length + 1 > this.maxDepth) {
        throw new DecodeError('E_DEPTH', `call depth exceeds ${this.maxDepth}`);
      }
      this.emit(text);
      this.stack.push({ prog: this.pc.prog, seq: this.pc.seq, line: this.pc.line + 1 });
      this.pc = { prog: name, seq: target.start + target.entry, line: 0 };
      return true;
    }

    if (tokens.includes('M99')) {
      this.emit(text);
      this.returnFromSub();
      return true;
    }

    const gotoIdx = tokens.indexOf('GOTO');
    if (gotoIdx !== -1) {
      const label = (tokens[gotoIdx + 1] ?? '').replace(/^N/i, '');
      const hit = this.findLabel(progInfo, label);
      if (hit === null) return false; // blocked: a program block is still missing
      if (hit === undefined) {
        throw new DecodeError('E_TARGET', `missing label N${label} in ${this.pc.prog}`);
      }
      this.emit(text);
      this.pc = { prog: this.pc.prog, seq: hit.seq, line: hit.line };
      return true;
    }

    this.emit(text);
    this.pc = { prog: this.pc.prog, seq: this.pc.seq, line: this.pc.line + 1 };
    return true;
  }

  returnFromSub() {
    const ret = this.stack.pop();
    if (ret) {
      this.pc = ret;
    } else {
      this.done = true;
    }
  }

  // Locate N<label> inside the current program's block range.
  // Returns {seq, line}, undefined (not found), or null (blocked).
  findLabel(progInfo, label) {
    const want = `N${label}`;
    for (let seq = progInfo.start; seq <= progInfo.end; seq++) {
      const lines = this.blocks.get(seq);
      if (!lines) return null;
      for (let line = 0; line < lines.length; line++) {
        if (lines[line].split(/\s+/)[0] === want) return { seq, line };
      }
    }
    return undefined;
  }

  emit(text) {
    this.executedCount++;
    if (this.recordTrace) {
      this.trace.push({ prog: this.pc.prog, seq: this.pc.seq, line: this.pc.line, text });
    }
  }
}
