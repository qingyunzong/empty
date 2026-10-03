'use strict';

const { Chain, EXIT, sha256hex } = require('./chain');
const { ZERO_HASH } = require('./frame');

function ackOf(opId, outcome) {
  return sha256hex(`ACK:${opId}:${outcome}`);
}

// Protocol engine: dedup by opId, seq/prevHash ordering with buffering,
// virtual-clock lease enforcement, linearization by (seq, lease).
class Engine {
  constructor(dir, opts = {}) {
    this.chain = new Chain(dir, opts);
    this.clock = 0; // virtual clock: one tick per processed frame
    this.buffer = new Map(); // seq -> { frame, raw }  (out-of-order, awaiting predecessors)
    this.seen = new Map(); // opId -> result (dedup / retransmission cache)
    for (const e of this.chain.entries) {
      this.seen.set(e.opId, { opId: e.opId, status: 'applied', seq: e.seq, hash: e.hash, ack: ackOf(e.opId, e.hash) });
    }
    this.results = [];
    this.rejections = [];
  }

  get root() {
    return this.chain.tip;
  }

  _applyFrame(frame, raw) {
    const entry = this.chain.append({ opId: frame.opId, actor: frame.actor, cmd: frame.cmd, args: frame.args, kind: frame.cmd === 'undo' ? 'undo' : 'op' });
    const r = { opId: frame.opId, status: 'applied', seq: entry.seq, hash: entry.hash, ack: ackOf(frame.opId, entry.hash) };
    this.seen.set(frame.opId, r);
    this.results.push(r);
    return r;
  }

  _reject(frame, raw, reason, exitCode) {
    const evidence = {
      opId: frame.opId, actor: frame.actor, cmd: frame.cmd, seq: frame.seq,
      reason, clock: this.clock, leaseUntil: frame.leaseUntil,
      frameHash: sha256hex(raw),
    };
    this.rejections.push(evidence);
    this.chain.recordEvidence(evidence);
    const r = { opId: frame.opId, status: 'rejected', reason, exitCode, evidence: evidence.frameHash };
    this.seen.set(frame.opId, r);
    this.results.push(r);
    return r;
  }

  _drain() {
    for (;;) {
      const next = this.chain.count + 1;
      const pending = this.buffer.get(next);
      if (!pending) break;
      if (pending.frame.prevHash !== this.chain.tip) {
        const r = this._reject(pending.frame, pending.raw, 'chain-break: buffered prevHash does not match tip', EXIT.CHAIN);
        this.buffer.delete(next);
        return r;
      }
      this.buffer.delete(next);
      this._applyFrame(pending.frame, pending.raw);
    }
    return null;
  }

  // Process one decoded frame. raw = exact frame bytes (evidence).
  // Returns every result record produced by this frame: one frame may
  // trigger buffered successors to be applied.
  process(frame, raw) {
    const before = this.results.length;
    this._process(frame, raw);
    return this.results.slice(before);
  }

  _process(frame, raw) {
    const now = this.clock;
    this.clock += 1;

    // 1. retransmission / dedup
    const dup = this.seen.get(frame.opId);
    if (dup) {
      const r = { ...dup, status: dup.status === 'applied' ? 'duplicate' : dup.status, dedup: true };
      this.results.push(r);
      return r;
    }

    // 2. lease check against the virtual clock
    if (frame.leaseUntil < now) {
      return this._reject(frame, raw, `lease-expired: leaseUntil=${frame.leaseUntil} < clock=${now}`, EXIT.LEASE);
    }

    // 3. linearization by seq
    const next = this.chain.count + 1;
    if (frame.seq < next) {
      return this._reject(frame, raw, `stale-seq: seq=${frame.seq} already linearized (next=${next})`, EXIT.CHAIN);
    }
    if (frame.seq > next) {
      this.buffer.set(frame.seq, { frame, raw });
      const r = { opId: frame.opId, status: 'buffered', reason: `out-of-order: waiting for seq ${next}` };
      this.results.push(r);
      return r;
    }
    if (frame.prevHash !== this.chain.tip) {
      // right position, wrong predecessor: hold and hope the true predecessor arrives
      this.buffer.set(frame.seq, { frame, raw });
      const r = { opId: frame.opId, status: 'buffered', reason: 'prevHash mismatch at expected seq; held' };
      this.results.push(r);
      return r;
    }

    const r = this._applyFrame(frame, raw);
    const bad = this._drain();
    return bad || r;
  }

  finalize() {
    const pending = [...this.buffer.values()].map((b) => ({
      opId: b.frame.opId, status: 'pending', reason: `never linearized: missing predecessors up to seq ${b.frame.seq - 1}`,
    }));
    const checkpoint = this.chain.issueCheckpoint();
    const leaseRejected = this.rejections.some((r) => r.reason.startsWith('lease-expired'));
    const chainBroken = this.rejections.some((r) => r.reason.startsWith('chain-break'));
    const exitCode = chainBroken ? EXIT.CHAIN : leaseRejected ? EXIT.LEASE : pending.length ? EXIT.CHAIN : EXIT.OK;
    return {
      results: this.results, pending, rejections: this.rejections,
      root: this.chain.tip, count: this.chain.count, checkpoint, exitCode,
    };
  }
}

module.exports = { Engine, ackOf };
