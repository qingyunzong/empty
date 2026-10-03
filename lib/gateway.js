'use strict';

const { StructuralError, TYPE, parse } = require('./frame');
const { merkleRoot, CHUNK_SIZE } = require('./merkle');

const DEFAULT_MISSING_TIMEOUT_MS = 1000;

class ConflictError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ConflictError';
    this.detail = detail;
  }
}

function freshSession(session) {
  return {
    status: 'active',
    session,
    fragments: new Map(), // offset -> Buffer
    contiguous: 0,        // bytes covered without gaps starting at 0
    maxEnd: 0,            // highest byte end seen
    receivedBytes: 0,     // unique payload bytes accepted
    retransmits: 0,
    timer: null,
  };
}

function sortedOffsets(st) {
  return [...st.fragments.keys()].sort((a, b) => a - b);
}

function missingRanges(st) {
  const ranges = [];
  let cursor = st.contiguous;
  for (const o of sortedOffsets(st)) {
    const e = o + st.fragments.get(o).length;
    if (e <= cursor) continue;
    if (o > cursor) ranges.push({ offset: cursor, len: o - cursor });
    if (e > cursor) cursor = e;
  }
  return ranges;
}

class Gateway {
  constructor({ clock, missingTimeoutMs = DEFAULT_MISSING_TIMEOUT_MS, onEvent } = {}) {
    if (!clock) throw new Error('Gateway requires an injectable clock');
    this.clock = clock;
    this.missingTimeoutMs = missingTimeoutMs;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.buffer = Buffer.alloc(0);
    this.boards = new Map();  // board -> session state
    this.certMap = new Map(); // board -> last terminal cert
    this.stats = { frames: 0, badCrc: 0, retransmits: 0, commits: 0, aborts: 0, conflicts: 0 };
  }

  _emit(event) {
    this.onEvent({ t: this.clock.now(), ...event });
  }

  feed(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      const result = parse(this.buffer);
      if (!result) return;
      this.buffer = this.buffer.subarray(result.size);
      this._dispatch(result.frame);
    }
  }

  end() {
    if (this.buffer.length) {
      const dropped = this.buffer.length;
      this.buffer = Buffer.alloc(0);
      this._emit({ event: 'truncated_tail', bytes: dropped });
      throw new StructuralError('truncated_tail', `stream ended with ${dropped} unconsumed byte(s)`);
    }
  }

  certs() {
    return [...this.certMap.values()].sort((a, b) => a.board - b.board);
  }

  _conflict(board, session, detail) {
    this.stats.conflicts++;
    this._emit({ event: 'conflict', board, session, detail });
    throw new ConflictError(`board ${board} session ${session}: ${detail}`, { board, session, detail });
  }

  _dispatch(frame) {
    this.stats.frames++;
    if (!frame.crcOk) {
      this.stats.badCrc++;
      this._emit({ event: 'bad_crc', board: frame.board, session: frame.session, type: frame.typeName });
      return;
    }
    if (frame.type === TYPE.DATA) this._onData(frame);
    else if (frame.type === TYPE.END) this._onEnd(frame);
    else this._onAbort(frame);
  }

  // Opens (or validates) the active session for a board, enforcing the
  // session-monotonicity rules against terminal states.
  _openSession(board, session) {
    let st = this.boards.get(board);
    if (!st) {
      st = freshSession(session);
      this.boards.set(board, st);
      return st;
    }
    if (st.status === 'active') {
      if (st.session !== session) {
        this._conflict(board, session, `active session is ${st.session}`);
      }
      return st;
    }
    // Terminal state (ended/aborted): a new session must be strictly greater.
    if (session <= st.session) {
      this._conflict(board, session, `board already ${st.status} at session ${st.session}`);
    }
    st = freshSession(session);
    this.boards.set(board, st);
    return st;
  }

  _onData(frame) {
    const st = this._openSession(frame.board, frame.session);
    const { offset, payload } = frame;
    const end = offset + payload.length;
    for (const [o, buf] of st.fragments) {
      const e = o + buf.length;
      if (offset < e && o < end) {
        if (o === offset && buf.length === payload.length && buf.equals(payload)) {
          st.retransmits++;
          this.stats.retransmits++;
          this._emit({ event: 'retransmit', board: frame.board, session: frame.session, offset, len: payload.length });
          return;
        }
        throw new StructuralError('overlap_mismatch',
          `board ${frame.board}: fragment at offset ${offset} overlaps incompatible fragment at offset ${o}`);
      }
    }
    st.fragments.set(offset, payload);
    st.receivedBytes += payload.length;
    if (end > st.maxEnd) st.maxEnd = end;
    let covered = 0;
    for (const o of sortedOffsets(st)) {
      if (o > covered) break;
      covered = Math.max(covered, o + st.fragments.get(o).length);
    }
    st.contiguous = covered;
    this._emit({
      event: 'data', board: frame.board, session: frame.session,
      offset, len: payload.length, contiguous: st.contiguous,
    });
    this._scheduleGapCheck(frame.board, st);
  }

  _scheduleGapCheck(board, st) {
    if (st.timer !== null) {
      this.clock.clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.status !== 'active' || missingRanges(st).length === 0) return;
    st.timer = this.clock.setTimeout(() => {
      st.timer = null;
      if (st.status !== 'active') return;
      const missing = missingRanges(st);
      if (missing.length === 0) return;
      for (const r of missing) {
        this._emit({ event: 'retransmit_request', board, session: st.session, offset: r.offset, len: r.len });
      }
      this._scheduleGapCheck(board, st);
    }, this.missingTimeoutMs);
  }

  _cancelTimer(st) {
    if (st.timer !== null) {
      this.clock.clearTimeout(st.timer);
      st.timer = null;
    }
  }

  _assemble(st) {
    const out = Buffer.alloc(st.contiguous);
    for (const [o, buf] of st.fragments) {
      if (o < st.contiguous) buf.copy(out, o, 0, Math.min(buf.length, st.contiguous - o));
    }
    return out;
  }

  _onEnd(frame) {
    let st = this.boards.get(frame.board);
    if (st && st.status === 'active') {
      if (st.session !== frame.session) {
        this._conflict(frame.board, frame.session, `active session is ${st.session}`);
      }
    } else {
      st = this._openSession(frame.board, frame.session);
    }
    if (st.contiguous < st.maxEnd) {
      throw new StructuralError('end_with_gaps',
        `board ${frame.board}: END with ${st.maxEnd - st.contiguous} missing byte(s)`);
    }
    const payload = this._assemble(st);
    const cert = {
      board: frame.board,
      session: frame.session,
      status: 'committed',
      merkleRoot: merkleRoot(payload),
      receivedBytes: payload.length,
      chunks: Math.ceil(payload.length / CHUNK_SIZE),
      retransmits: st.retransmits,
      discardReason: null,
    };
    this._cancelTimer(st);
    st.status = 'ended';
    st.fragments.clear();
    this.certMap.set(frame.board, cert);
    this.stats.commits++;
    this._emit({
      event: 'commit', board: frame.board, session: frame.session,
      merkleRoot: cert.merkleRoot, receivedBytes: cert.receivedBytes,
    });
  }

  _onAbort(frame) {
    const reason = frame.payload.length ? frame.payload.toString('utf8') : 'abort';
    const st = this.boards.get(frame.board);
    if (st && st.status === 'ended') {
      this._emit({ event: 'ignored', reason: 'abort_after_end', board: frame.board, session: frame.session });
      return;
    }
    if (st && st.status === 'aborted') {
      this._emit({ event: 'ignored', reason: 'abort_after_abort', board: frame.board, session: frame.session });
      return;
    }
    if (st && st.session !== frame.session) {
      this._conflict(frame.board, frame.session, `active session is ${st.session}`);
    }
    const received = st ? st.receivedBytes : 0;
    const retransmits = st ? st.retransmits : 0;
    const partial = st ? this._assemble(st) : Buffer.alloc(0);
    if (st) {
      this._cancelTimer(st);
      st.status = 'aborted';
      st.fragments.clear();
    } else {
      this.boards.set(frame.board, { ...freshSession(frame.session), status: 'aborted' });
    }
    const cert = {
      board: frame.board,
      session: frame.session,
      status: 'aborted',
      merkleRoot: merkleRoot(partial),
      receivedBytes: received,
      chunks: Math.ceil(partial.length / CHUNK_SIZE),
      retransmits,
      discardReason: reason,
    };
    this.certMap.set(frame.board, cert);
    this.stats.aborts++;
    this._emit({ event: 'abort', board: frame.board, session: frame.session, discardReason: reason, receivedBytes: received });
  }
}

module.exports = { Gateway, ConflictError, DEFAULT_MISSING_TIMEOUT_MS };
