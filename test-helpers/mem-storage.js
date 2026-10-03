// In-memory durable storage with crash simulation.
// Writes go to a volatile view; fsync() makes the volatile view durable.
// crash() returns a new storage containing only the durable state, which
// models a power loss: anything written after the last fsync is gone.
export class MemStorage {
  constructor() {
    this.volatile = Buffer.alloc(0);
    this.durable = Buffer.alloc(0);
    this.fsyncs = 0;
  }

  size() {
    return this.volatile.length;
  }

  read(offset, len) {
    return Buffer.from(this.volatile.subarray(offset, Math.min(offset + len, this.volatile.length)));
  }

  write(offset, buf) {
    const next = Buffer.alloc(Math.max(this.volatile.length, offset + buf.length));
    this.volatile.copy(next);
    buf.copy(next, offset);
    this.volatile = next;
  }

  fsync() {
    this.durable = Buffer.from(this.volatile);
    this.fsyncs++;
  }

  truncate(size) {
    this.volatile = Buffer.from(this.volatile.subarray(0, size));
  }

  close() {}

  crash() {
    const crashed = new this.constructor();
    crashed.volatile = Buffer.from(this.durable);
    crashed.durable = Buffer.from(this.durable);
    return crashed;
  }

  // Test-only: mutate the durable image directly (torn writes, tampering).
  corruptDurable(fn) {
    const next = fn(Buffer.from(this.durable)) ?? this.durable;
    this.durable = Buffer.from(next);
    this.volatile = Buffer.from(next);
  }
}

export class CrashError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CrashError';
  }
}

// Fails on the (n+1)-th fsync, simulating a crash after the write of a page
// but before its durability barrier.
export class CrashStorage extends MemStorage {
  constructor() {
    super();
    this.crashAfterFsyncs = Infinity;
  }

  armCrashAfterFsyncs(n) {
    this.crashAfterFsyncs = n;
  }

  fsync() {
    if (this.fsyncs >= this.crashAfterFsyncs) {
      throw new CrashError(`simulated crash before fsync #${this.fsyncs + 1}`);
    }
    super.fsync();
  }
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
