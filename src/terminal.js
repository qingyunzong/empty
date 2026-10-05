'use strict';

const Ledger = require('./ledger');
const { ProtocolError, BudgetError } = require('./errors');
const { validateCommand, samePayload } = require('./validate');

// Line terminal: authoritative owner of the plan/budget state.
// Applies commands transactionally and replies ACK/NAK.
// - duplicate id@ver: idempotent, replays the cached ACK without re-applying
// - lower (stale) ver: ignored (returns null)
class Terminal {
  constructor(capOrLedger) {
    this.ledger = typeof capOrLedger === 'number' ? new Ledger(capOrLedger) : capOrLedger;
    this.lastVer = new Map(); // id -> highest ACKed ver
    this.applied = new Map(); // `${id}@${ver}` -> { cmd, reply }
    this.stats = { received: 0, duplicates: 0, staleIgnored: 0, naks: 0 };
  }

  receive(rawCmd) {
    this.stats.received++;
    const cmd = validateCommand(rawCmd);
    const key = `${cmd.id}@${cmd.ver}`;
    const last = this.lastVer.get(cmd.id) ?? 0;

    if (cmd.ver < last) {
      this.stats.staleIgnored++;
      return null; // out-of-order, lower ver: ignore
    }
    if (this.applied.has(key)) {
      const prev = this.applied.get(key);
      if (!samePayload(prev.cmd, cmd)) {
        throw new ProtocolError(`conflicting payload for ${key}`);
      }
      this.stats.duplicates++;
      return { ...prev.reply }; // dedup: re-ACK, never re-apply
    }

    const reply = this._apply(cmd);
    if (reply.status === 'ACK') {
      this.lastVer.set(cmd.id, cmd.ver);
      this.applied.set(key, { cmd, reply });
    } else {
      this.stats.naks++;
    }
    return reply;
  }

  _apply(cmd) {
    const ledger = this.ledger;
    ledger.begin();
    try {
      switch (cmd.op) {
        case 'PLAN': {
          if (ledger.jobs.has(cmd.id)) {
            throw new ProtocolError(`PLAN: job ${cmd.id} already exists`);
          }
          ledger.occupy({ op: 'PLAN', id: cmd.id, ver: cmd.ver, cost: cmd.cost, start: cmd.start, end: cmd.end });
          break;
        }
        case 'MOVE': {
          // Atomic: release old occupancy, then occupy the new one.
          // If the occupy fails, the whole frame rolls back and the old
          // occupancy is restored untouched.
          if (!ledger.jobs.has(cmd.id)) {
            throw new ProtocolError(`MOVE: unknown job ${cmd.id}`);
          }
          ledger.release(cmd.id, { op: 'MOVE', ver: cmd.ver });
          ledger.occupy({ op: 'MOVE', id: cmd.id, ver: cmd.ver, cost: cmd.cost, start: cmd.start, end: cmd.end });
          break;
        }
        case 'CANCEL': {
          if (!ledger.jobs.has(cmd.id)) {
            throw new ProtocolError(`CANCEL: unknown job ${cmd.id}`);
          }
          ledger.release(cmd.id, { op: 'CANCEL', ver: cmd.ver });
          break;
        }
        default:
          throw new ProtocolError(`unknown op: ${cmd.op}`);
      }
      ledger.commit();
      return { status: 'ACK', id: cmd.id, ver: cmd.ver };
    } catch (err) {
      ledger.rollback(); // any failed step: restore pre-command state
      if (err instanceof BudgetError) {
        return { status: 'NAK', id: cmd.id, ver: cmd.ver, reason: err.message };
      }
      throw err;
    }
  }
}

module.exports = Terminal;
