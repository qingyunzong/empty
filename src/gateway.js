'use strict';

const crypto = require('node:crypto');
const { TYPES } = require('./frame');

class ProtocolViolation extends Error {
  constructor(code, offset) {
    super(`protocol violation ${code} at offset ${offset}`);
    this.name = 'ProtocolViolation';
    this.code = code;
    this.offset = offset;
  }
}

const FUTURE_WINDOW = 64; // frames this far ahead of expected seq are buffered
const DEDUP_CACHE_MAX = 128; // bounded dedup cache of processed seq numbers

// Session gateway between the PLC uplink and the offline work-order ledger.
// - orders frames by seq, buffering out-of-order frames and requesting
//   retransmission of gaps (NAK)
// - drops duplicates via a bounded dedup cache (never double-posts)
// - retries retransmit requests on a virtual clock (--clock N = timeout ticks,
//   one tick per input byte; 0 disables retries)
// - applies the weld state machine per work order
class Gateway {
  constructor({ timeout = 0, maxRetries = 3 } = {}) {
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.expected = 0; // next in-order seq byte
    this.reorderBuffer = new Map(); // seq -> frame (future frames)
    this.dedupCache = new Set(); // recently processed seq bytes
    this.dedupOrder = []; // FIFO for cache eviction
    this.pending = null; // { seq, since, attempts } open retransmission gap
    this.workOrders = new Map(); // wo -> { records: [{kind,eventId,undone}], open }
    this.domainEvents = [];
    this.nextEventId = 1;
    this.stats = {
      frames: 0,
      duplicates: 0,
      retransmitRequests: 0,
      retries: 0,
    };
  }

  handleFrame(frame, tick) {
    this.stats.frames++;
    const k = (frame.seq - this.expected + 256) & 0xFF;
    if (k === 0) {
      const events = this.processFrame(frame, tick);
      this.rememberSeq(frame.seq);
      this.expected = (this.expected + 1) & 0xFF;
      while (this.reorderBuffer.has(this.expected)) {
        const next = this.reorderBuffer.get(this.expected);
        this.reorderBuffer.delete(this.expected);
        events.push(...this.processFrame(next, tick));
        this.rememberSeq(next.seq);
        this.expected = (this.expected + 1) & 0xFF;
      }
      if (this.pending && this.pending.seq === frame.seq) this.pending = null;
      return events;
    }
    if (k <= FUTURE_WINDOW) {
      if (this.reorderBuffer.has(frame.seq)) {
        this.stats.duplicates++;
        return [];
      }
      this.reorderBuffer.set(frame.seq, frame);
      if (!this.pending) {
        this.pending = { seq: this.expected, since: tick, attempts: 0 };
        this.stats.retransmitRequests++;
        return [{ type: 'retransmit_request', seq: this.expected, tick }];
      }
      return [];
    }
    // Past frame: already processed (dedup cache hit or evicted old seq).
    this.stats.duplicates++;
    return [];
  }

  rememberSeq(seq) {
    this.dedupCache.add(seq);
    this.dedupOrder.push(seq);
    if (this.dedupOrder.length > DEDUP_CACHE_MAX) {
      this.dedupCache.delete(this.dedupOrder.shift());
    }
  }

  // Virtual clock advanced; emit retransmit retries for an open gap.
  checkTimeout(tick) {
    if (this.timeout <= 0 || !this.pending) return [];
    if (this.pending.attempts >= this.maxRetries) return [];
    if (tick - this.pending.since < this.timeout) return [];
    this.pending.attempts++;
    this.pending.since = tick;
    this.stats.retries++;
    return [{
      type: 'retransmit_retry',
      seq: this.pending.seq,
      attempt: this.pending.attempts,
      tick,
    }];
  }

  processFrame(frame, tick) {
    let st = this.workOrders.get(frame.wo);
    if (!st) {
      st = { records: [], open: false };
      this.workOrders.set(frame.wo, st);
    }
    switch (frame.type) {
      case TYPES.WELD_START: {
        const ev = { type: 'weld_start', id: this.nextEventId++, wo: frame.wo, seq: frame.seq, tick };
        st.records.push({ kind: 'start', eventId: ev.id });
        st.open = true;
        this.domainEvents.push(ev);
        return [ev];
      }
      case TYPES.WELD_END: {
        if (!st.open) {
          throw new ProtocolViolation('END_WITHOUT_START', frame.offset);
        }
        const ev = { type: 'weld_end', id: this.nextEventId++, wo: frame.wo, seq: frame.seq, tick };
        st.records.push({ kind: 'end', eventId: ev.id, undone: false });
        st.open = false;
        this.domainEvents.push(ev);
        return [ev];
      }
      case TYPES.UNDO: {
        // Undoable iff the latest record is a WELD_END that is not yet
        // closed by an undo and not covered by a later WELD_START.
        const last = st.records[st.records.length - 1];
        if (!last || last.kind !== 'end' || last.undone) {
          throw new ProtocolViolation('UNDO_NOT_ALLOWED', frame.offset);
        }
        last.undone = true;
        const ev = {
          type: 'weld_undo',
          id: this.nextEventId++,
          wo: frame.wo,
          seq: frame.seq,
          tick,
          undoes: last.eventId, // reverse event; original weld_end is kept
        };
        st.records.push({ kind: 'undo', eventId: ev.id });
        this.domainEvents.push(ev);
        return [ev];
      }
      default:
        throw new ProtocolViolation('UNKNOWN_TYPE', frame.offset);
    }
  }

  // End of input: an unresolved retransmission gap means lost frames.
  finish(offset) {
    if (this.pending || this.reorderBuffer.size > 0) {
      return { code: 'SEQ_GAP', offset };
    }
    return null;
  }

  certificate(finalTick) {
    const openWorkOrders = [...this.workOrders.entries()]
      .filter(([, st]) => st.open)
      .map(([wo]) => wo)
      .sort();
    const stateHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(this.domainEvents))
      .digest('hex');
    return {
      type: 'certificate',
      frames: this.stats.frames,
      duplicates: this.stats.duplicates,
      retransmitRequests: this.stats.retransmitRequests,
      retries: this.stats.retries,
      events: this.domainEvents.length,
      workOrders: this.workOrders.size,
      openWorkOrders,
      finalTick,
      stateHash,
    };
  }
}

module.exports = { Gateway, ProtocolViolation };
