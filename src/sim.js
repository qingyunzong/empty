'use strict';

// Verdict codes
const OK = 0;
const ERR_RELEASE_EXCEEDS = 10;   // release more than currently frozen
const ERR_NEGATIVE_AVAILABLE = 11; // op would drive available quota negative
const ERR_DUPLICATE_OPID = 12;    // duplicate opId in history
const ERR_DAILY_CAP = 13;         // account daily freeze budget exceeded (rejected, no partial effect)
const ERR_HOLD_WITHOUT_FREEZE = 14; // hold without a matching unreleased freeze
const ERR_INVALID_OP = 15;        // malformed op (bad amount, missing ref, unknown type)
const ERR_CAUSAL_CYCLE = 16;      // op participates in a causality cycle

const CODE_NAMES = {
  [OK]: 'ok',
  [ERR_RELEASE_EXCEEDS]: 'release_exceeds_frozen',
  [ERR_NEGATIVE_AVAILABLE]: 'negative_available',
  [ERR_DUPLICATE_OPID]: 'duplicate_opId',
  [ERR_DAILY_CAP]: 'daily_freeze_cap_exceeded',
  [ERR_HOLD_WITHOUT_FREEZE]: 'hold_without_unreleased_freeze',
  [ERR_INVALID_OP]: 'invalid_op',
  [ERR_CAUSAL_CYCLE]: 'causal_cycle',
};

/**
 * Per-account mutable quota state.
 * A freeze occupies quota: frozenTotal += amount.
 * A hold moves part of a freeze from `remaining` to `held` (still occupied).
 * A release frees occupied quota (held first, then remaining); partial allowed.
 */
class AccountState {
  constructor(config = {}) {
    this.limit = config.limit == null ? Infinity : config.limit;
    this.dailyFreezeCap = config.dailyFreezeCap == null ? Infinity : config.dailyFreezeCap;
    this.frozenTotal = 0;
    this.dailyFrozen = new Map(); // day -> accepted freeze amount (releases do not refund the daily budget)
    this.freezes = new Map();     // freezeOpId -> { amount, remaining, held, day }
  }

  clone() {
    const s = new AccountState({ limit: this.limit, dailyFreezeCap: this.dailyFreezeCap });
    s.frozenTotal = this.frozenTotal;
    s.dailyFrozen = new Map(this.dailyFrozen);
    s.freezes = new Map();
    for (const [k, v] of this.freezes) s.freezes.set(k, { ...v });
    return s;
  }

  get available() {
    return this.limit - this.frozenTotal;
  }

  /**
   * Apply one op. Returns a verdict code; state is mutated only when the
   * code is OK (rejected ops never have partial effects).
   */
  apply(op) {
    if (op.type === 'compensate') return OK; // repair marker: no quota effect
    const amount = op.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      return ERR_INVALID_OP;
    }
    if (op.type === 'freeze') {
      const day = op.day == null ? '' : String(op.day);
      const used = this.dailyFrozen.get(day) || 0;
      if (used + amount > this.dailyFreezeCap) return ERR_DAILY_CAP;
      if (this.frozenTotal + amount > this.limit) return ERR_NEGATIVE_AVAILABLE;
      this.dailyFrozen.set(day, used + amount);
      this.frozenTotal += amount;
      this.freezes.set(op.opId, { amount, remaining: amount, held: 0, day });
      return OK;
    }
    if (op.type === 'hold') {
      if (op.ref == null) return ERR_INVALID_OP;
      const f = this.freezes.get(op.ref);
      if (!f || f.remaining < amount) return ERR_HOLD_WITHOUT_FREEZE;
      f.remaining -= amount;
      f.held += amount;
      return OK;
    }
    if (op.type === 'release') {
      if (op.ref == null) return ERR_INVALID_OP;
      const f = this.freezes.get(op.ref);
      const occupied = f ? f.remaining + f.held : 0;
      if (amount > occupied) return ERR_RELEASE_EXCEEDS;
      let left = amount;
      const fromHeld = Math.min(f.held, left);
      f.held -= fromHeld;
      left -= fromHeld;
      f.remaining -= left;
      this.frozenTotal -= amount;
      return OK;
    }
    return ERR_INVALID_OP;
  }
}

module.exports = {
  OK,
  ERR_RELEASE_EXCEEDS,
  ERR_NEGATIVE_AVAILABLE,
  ERR_DUPLICATE_OPID,
  ERR_DAILY_CAP,
  ERR_HOLD_WITHOUT_FREEZE,
  ERR_INVALID_OP,
  ERR_CAUSAL_CYCLE,
  CODE_NAMES,
  AccountState,
};
