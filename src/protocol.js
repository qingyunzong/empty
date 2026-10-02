export class Protocol {
  constructor() {
    this.nextSeq = 1;
    this.buffer = new Map();
    this.seen = new Map();
    this.lastAck = 0;
  }

  push(frame) {
    if (Number.isInteger(frame.ack)) {
      this.lastAck = Math.max(this.lastAck, frame.ack);
      for (const seq of [...this.seen.keys()]) {
        if (seq <= this.lastAck) this.seen.delete(seq);
      }
    }
    if (frame.seq < this.nextSeq) {
      return [{ dup: true, seq: frame.seq, response: this.seen.get(frame.seq) ?? null }];
    }
    if (this.buffer.has(frame.seq)) {
      return [{ dup: true, seq: frame.seq, response: null, buffered: true }];
    }
    this.buffer.set(frame.seq, frame);
    const out = [];
    while (this.buffer.has(this.nextSeq)) {
      out.push({ frame: this.buffer.get(this.nextSeq) });
      this.buffer.delete(this.nextSeq);
      this.nextSeq += 1;
    }
    return out;
  }

  flush() {
    const rest = [...this.buffer.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, frame]) => ({ frame, gap: true }));
    this.buffer.clear();
    return rest;
  }

  record(seq, response) {
    this.seen.set(seq, response);
  }
}
