'use strict';

const { TYPE } = require('./frame');

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

function requirePayload(payload, frameSeq) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProtocolError('INVALID_PAYLOAD', `frame ${frameSeq}: payload must be an object`);
  }
  if (typeof payload.orderId !== 'string' || payload.orderId.length === 0) {
    throw new ProtocolError('INVALID_PAYLOAD', `frame ${frameSeq}: orderId must be a non-empty string`);
  }
}

// Work-order ledger. Validates before mutating, so a rejected frame leaves
// state unchanged. UNDO rules:
//  - target must be a delivered WELD_END of the SAME work order;
//  - target must not already be reversed (closed loop);
//  - target must not be covered by a later WELD_START of that order.
// A successful UNDO emits a reverse event (WELD_END_REVERSED); the original
// WELD_END event stays in the log untouched.
class Ledger {
  constructor() {
    this.orders = new Map(); // orderId -> { lastStartSeq }
    this.ends = new Map(); // endSeq -> { seq, orderId, weldId, undone }
  }

  _order(id) {
    let order = this.orders.get(id);
    if (!order) {
      order = { lastStartSeq: -1 };
      this.orders.set(id, order);
    }
    return order;
  }

  apply(frame) {
    const p = frame.payload;
    switch (frame.type) {
      case TYPE.WELD_START: {
        requirePayload(p, frame.seq);
        const order = this._order(p.orderId);
        order.lastStartSeq = frame.seq;
        return { event: 'WELD_START', seq: frame.seq, orderId: p.orderId, weldId: p.weldId ?? null };
      }
      case TYPE.WELD_END: {
        requirePayload(p, frame.seq);
        this._order(p.orderId);
        const rec = { seq: frame.seq, orderId: p.orderId, weldId: p.weldId ?? null, undone: false };
        this.ends.set(frame.seq, rec);
        return { event: 'WELD_END', seq: frame.seq, orderId: rec.orderId, weldId: rec.weldId };
      }
      case TYPE.UNDO: {
        requirePayload(p, frame.seq);
        if (!Number.isInteger(p.targetSeq) || p.targetSeq < 0) {
          throw new ProtocolError('INVALID_PAYLOAD', `frame ${frame.seq}: targetSeq must be a non-negative integer`);
        }
        const target = this.ends.get(p.targetSeq);
        if (!target) {
          throw new ProtocolError('UNDO_TARGET_NOT_FOUND', `frame ${frame.seq}: no WELD_END at seq ${p.targetSeq}`);
        }
        if (target.orderId !== p.orderId) {
          throw new ProtocolError('CROSS_ORDER_UNDO',
            `frame ${frame.seq}: end ${p.targetSeq} belongs to order ${target.orderId}, not ${p.orderId}`);
        }
        if (target.undone) {
          throw new ProtocolError('UNDO_ALREADY_CLOSED', `frame ${frame.seq}: end ${p.targetSeq} already reversed`);
        }
        if (this._order(p.orderId).lastStartSeq > target.seq) {
          throw new ProtocolError('UNDO_COVERED_BY_START',
            `frame ${frame.seq}: end ${p.targetSeq} covered by a later WELD_START`);
        }
        target.undone = true;
        return { event: 'WELD_END_REVERSED', seq: frame.seq, orderId: p.orderId, targetSeq: p.targetSeq };
      }
      default:
        throw new ProtocolError('UNKNOWN_TYPE', `frame ${frame.seq}: unknown type ${frame.type}`);
    }
  }
}

module.exports = { Ledger, ProtocolError };
