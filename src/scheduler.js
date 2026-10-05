'use strict';

const { ProtocolError } = require('./errors');

// Scheduler (sender) side of the confirmation protocol.
// Stop-and-wait ARQ: one unconfirmed command at a time, exponential backoff
// retransmission on timeout, duplicate ACK dedup.
class Scheduler {
  constructor({ baseTimeout = 4, maxRetries = 8 } = {}) {
    if (!Number.isFinite(baseTimeout) || baseTimeout <= 0) {
      throw new ProtocolError(`invalid baseTimeout: ${baseTimeout}`);
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 1) {
      throw new ProtocolError(`invalid maxRetries: ${maxRetries}`);
    }
    this.baseTimeout = baseTimeout;
    this.maxRetries = maxRetries;
    this.pending = null;      // { cmd, attempts, timeout }
    this.confirmed = new Set(); // `${id}@${ver}` already ACKed
    this.stats = { sent: 0, retransmissions: 0, duplicateAcks: 0 };
  }

  dispatch(cmd) {
    if (this.pending) {
      throw new ProtocolError('scheduler busy: stop-and-wait allows one pending command');
    }
    this.pending = { cmd, attempts: 1, timeout: this.baseTimeout };
    this.stats.sent++;
    return this.pending;
  }

  // No reply arrived before the timeout: retransmit with exponential backoff.
  onTimeout() {
    const p = this.pending;
    if (!p) throw new ProtocolError('timeout with no pending command');
    if (p.attempts >= this.maxRetries) {
      throw new ProtocolError(
        `command ${p.cmd.id}@${p.cmd.ver}: no reply after ${p.attempts} attempts (maxRetries=${this.maxRetries})`
      );
    }
    p.attempts++;
    p.timeout *= 2; // exponential backoff
    this.stats.sent++;
    this.stats.retransmissions++;
    return p;
  }

  onReply(reply) {
    const key = `${reply.id}@${reply.ver}`;
    if (this.confirmed.has(key)) {
      this.stats.duplicateAcks++;
      return { ignored: true }; // duplicate ACK: dedup
    }
    if (!this.pending) {
      throw new ProtocolError(`unsolicited reply for ${key}`);
    }
    const p = this.pending;
    if (p.cmd.id !== reply.id || p.cmd.ver !== reply.ver) {
      throw new ProtocolError(`reply ${key} does not match pending ${p.cmd.id}@${p.cmd.ver}`);
    }
    this.pending = null;
    if (reply.status === 'ACK') {
      this.confirmed.add(key);
      return { confirmed: true, cmd: p.cmd };
    }
    if (reply.status === 'NAK') {
      return { confirmed: false, cmd: p.cmd, reason: reply.reason };
    }
    throw new ProtocolError(`malformed reply status: ${JSON.stringify(reply.status)}`);
  }

  pendingQueue() {
    if (!this.pending) return [];
    const { cmd, attempts, timeout } = this.pending;
    return [{ op: cmd.op, id: cmd.id, ver: cmd.ver, attempts, nextTimeout: timeout }];
  }
}

module.exports = Scheduler;
