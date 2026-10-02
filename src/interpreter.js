'use strict';

// Safety interpreter for a robot welding cell.
// Maintains current mode / door / light curtain / key-permission snapshot and
// decides which requests the safety PLC may accept.

const MODES = ['auto', 'teach', 'maintenance'];
const TEACH_SPEED_LIMIT = 250; // mm/s, safety rule, always wins over throughput
const AUTO_SPEED_LIMIT = 2000; // mm/s
const DECEL_TICKS = 2; // a started deceleration window must run to completion

// Higher level wins when concurrent events share one logical clock.
const SAFETY_LEVEL = {
  key_revoke: 60,
  curtain: 50,
  door: 40,
  key_grant: 30,
  mode_request: 20,
  auto_start: 10,
  speed_request: 10,
};

// Permission inheritance: team (班组) -> station (工位) -> robot (机器人).
const KEY_SCOPES = {
  team: ['team', 'station', 'robot'],
  station: ['station', 'robot'],
  robot: ['robot'],
};

class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

function normalizeEvent(raw, lineNo) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ExitError(2, `line ${lineNo}: event must be a JSON object`);
  }
  const e = { ...raw };
  if (typeof e.type !== 'string' || !(e.type in SAFETY_LEVEL)) {
    throw new ExitError(2, `line ${lineNo}: unknown event type ${JSON.stringify(e.type)}`);
  }
  if (typeof e.clock !== 'number' || !Number.isFinite(e.clock)) {
    throw new ExitError(2, `line ${lineNo}: missing numeric "clock"`);
  }
  if (typeof e.seq !== 'number') e.seq = lineNo;
  if (typeof e.source !== 'string') e.source = 'unknown';
  if (e.type === 'mode_request' && !MODES.includes(e.mode)) {
    throw new ExitError(13, `line ${lineNo}: unknown mode ${JSON.stringify(e.mode)}`);
  }
  return e;
}

function compareEvents(a, b) {
  return (SAFETY_LEVEL[b.type] - SAFETY_LEVEL[a.type])
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    || (a.seq - b.seq);
}

class Interpreter {
  constructor(options = {}) {
    this.options = options;
    this.mode = 'maintenance'; // safest initial mode
    this.door = 'closed';
    this.curtain = 'clear';
    this.keys = new Map(); // keyId -> 'team' | 'station' | 'robot'
    this.running = false;
    this.speedLimit = 0;
    this.decel = null; // { start, end, pendingMode, cause }
    this.lastClock = -Infinity;
    this.transitions = [];
    this.violations = [];
  }

  hasPermission(scope) {
    for (const level of this.keys.values()) {
      if (KEY_SCOPES[level].includes(scope)) return true;
    }
    return false;
  }

  snapshot() {
    return {
      mode: this.mode,
      door: this.door,
      curtain: this.curtain,
      running: this.running,
      speedLimit: this.speedLimit,
      keys: [...this.keys.entries()].map(([key, level]) => ({ key, level })),
      permissions: {
        team: this.hasPermission('team'),
        station: this.hasPermission('station'),
        robot: this.hasPermission('robot'),
      },
      decel: this.decel ? { ...this.decel } : null,
    };
  }

  run(rawEvents) {
    const events = rawEvents.map((e, i) => normalizeEvent(e, i + 1));
    let i = 0;
    while (i < events.length) {
      const clock = events[i].clock;
      if (clock < this.lastClock) {
        throw new ExitError(14, `non-monotonic clock: ${clock} after ${this.lastClock}`);
      }
      this.lastClock = clock;
      let j = i;
      while (j < events.length && events[j].clock === clock) j++;
      this._applyGroup(events.slice(i, j));
      i = j;
    }
    return this;
  }

  _applyGroup(group) {
    const clock = group[0].clock;
    const doorStates = new Set(
      group.filter((e) => e.type === 'door').map((e) => e.state),
    );
    if (doorStates.size > 1) {
      throw new ExitError(15, `contradictory door sensor states at clock ${clock}`);
    }
    if (this.decel && clock >= this.decel.end) this._completeDecel(clock);
    const changed = new Set(); // state aspects changed within this clock group
    for (const e of [...group].sort(compareEvents)) this._apply(e, changed);
  }

  _transition(e, name, details) {
    if (this.options.trace === false) return;
    this.transitions.push({
      clock: e ? e.clock : this.lastClock,
      seq: e ? e.seq : null,
      kind: 'transition',
      transition: name,
      ...details,
      state: this.snapshot(),
    });
  }

  _deny(e, reason, kind) {
    if (this.options.trace === false) return;
    this.violations.push({
      clock: e.clock,
      seq: e.seq,
      kind,
      event: { type: e.type, source: e.source, seq: e.seq },
      reason,
    });
  }

  _startDecel(e, changed, cause) {
    if (this.decel) return;
    this.decel = { start: e.clock, end: e.clock + DECEL_TICKS, pendingMode: 'maintenance', cause };
    this.running = false;
    changed.add('decel');
    this._transition(e, 'decel_started', { cause, end: this.decel.end });
  }

  _completeDecel(clock) {
    const decel = this.decel;
    this.decel = null;
    const from = this.mode;
    this.mode = decel.pendingMode;
    this.running = false;
    this.speedLimit = 0;
    this._transition(null, 'decel_completed', { from, to: this.mode, cause: decel.cause });
  }

  _apply(e, changed) {
    switch (e.type) {
      case 'key_grant': return this._keyGrant(e, changed);
      case 'key_revoke': return this._keyRevoke(e, changed);
      case 'door': return this._door(e, changed);
      case 'curtain': return this._curtain(e, changed);
      case 'mode_request': return this._modeRequest(e, changed);
      case 'auto_start': return this._autoStart(e, changed);
      case 'speed_request': return this._speedRequest(e, changed);
      default: throw new ExitError(2, `unknown event type ${JSON.stringify(e.type)}`);
    }
  }

  _keyGrant(e, changed) {
    if (!KEY_SCOPES[e.level]) {
      throw new ExitError(2, `unknown key level ${JSON.stringify(e.level)}`);
    }
    this.keys.set(e.key, e.level);
    changed.add('keys');
    this._transition(e, 'key_granted', { key: e.key, level: e.level });
  }

  _keyRevoke(e, changed) {
    if (!this.keys.has(e.key)) {
      return this._deny(e, `cannot revoke unknown key ${JSON.stringify(e.key)}`, 'violation');
    }
    this.keys.delete(e.key); // revocation takes effect immediately
    changed.add('keys');
    this._transition(e, 'key_revoked', { key: e.key });
    if (this.mode === 'auto' && !this.hasPermission('robot')) {
      this._startDecel(e, changed, 'key revocation removed robot-scope permission in auto mode');
    }
  }

  _door(e, changed) {
    if (e.state !== 'open' && e.state !== 'closed') {
      throw new ExitError(15, `contradictory door sensor state ${JSON.stringify(e.state)}`);
    }
    this.door = e.state;
    changed.add('door');
    this._transition(e, e.state === 'open' ? 'door_opened' : 'door_closed', {});
    if (e.state === 'open' && this.mode === 'auto') {
      this._startDecel(e, changed, 'door opened in auto mode');
    }
  }

  _curtain(e, changed) {
    if (e.state !== 'clear' && e.state !== 'blocked') {
      throw new ExitError(2, `unknown light curtain state ${JSON.stringify(e.state)}`);
    }
    this.curtain = e.state;
    changed.add('curtain');
    this._transition(e, e.state === 'blocked' ? 'curtain_blocked' : 'curtain_cleared', {});
    if (e.state === 'blocked' && this.mode === 'auto') {
      this._startDecel(e, changed, 'light curtain blocked in auto mode');
    }
    if (e.state === 'blocked' && this.mode === 'teach' && this.speedLimit > TEACH_SPEED_LIMIT) {
      this.speedLimit = TEACH_SPEED_LIMIT;
    }
  }

  _modeRequest(e, changed) {
    if (this.decel) {
      return this._deny(e, `deceleration window in progress until clock ${this.decel.end}; mode change would be a mid-window jump`, 'discarded');
    }
    if (!this.options.naive) {
      if (!this.hasPermission('station')) {
        return this._deny(e, 'mode switch requires key permission at station scope (team->station->robot inheritance)', changed.has('keys') ? 'discarded' : 'violation');
      }
      if (e.mode === 'auto') {
        if (this.door !== 'closed') {
          return this._deny(e, 'cannot enter auto mode while door is open', changed.has('door') ? 'discarded' : 'violation');
        }
        if (this.curtain !== 'clear') {
          return this._deny(e, 'cannot enter auto mode while light curtain is blocked', changed.has('curtain') ? 'discarded' : 'violation');
        }
      }
    }
    const from = this.mode;
    this.mode = e.mode;
    if (e.mode === 'maintenance') {
      this.running = false;
      this.speedLimit = 0;
    } else if (e.mode === 'teach') {
      this.running = false;
      this.speedLimit = Math.min(this.speedLimit, TEACH_SPEED_LIMIT);
    }
    this._transition(e, 'mode_changed', { from, to: e.mode });
  }

  _autoStart(e, changed) {
    if (this.decel) {
      return this._deny(e, `deceleration window in progress until clock ${this.decel.end}; automatic start discarded`, 'discarded');
    }
    if (this.options.naive) {
      // Reference-only variant used to demonstrate counterexample search.
      if (this.mode !== 'auto') {
        return this._deny(e, `automatic start requires auto mode (current: ${this.mode})`, 'violation');
      }
      this.running = true;
      this.speedLimit = AUTO_SPEED_LIMIT;
      return this._transition(e, 'auto_started', {});
    }
    if (this.mode === 'maintenance') {
      return this._deny(e, 'maintenance mode forbids automatic start', 'violation');
    }
    if (this.mode !== 'auto') {
      return this._deny(e, `automatic start requires auto mode (current: ${this.mode})`, 'violation');
    }
    if (this.door !== 'closed') {
      return this._deny(e, 'automatic start requested with door open', changed.has('door') ? 'discarded' : 'violation');
    }
    if (this.curtain !== 'clear') {
      return this._deny(e, 'automatic start requested while light curtain is blocked', changed.has('curtain') ? 'discarded' : 'violation');
    }
    if (!this.hasPermission('robot')) {
      return this._deny(e, 'automatic start requires key permission at robot scope', changed.has('keys') ? 'discarded' : 'violation');
    }
    this.running = true;
    this.speedLimit = AUTO_SPEED_LIMIT;
    this._transition(e, 'auto_started', {});
  }

  _speedRequest(e, changed) {
    if (typeof e.mm_s !== 'number' || !(e.mm_s >= 0)) {
      throw new ExitError(2, `speed_request requires non-negative numeric "mm_s"`);
    }
    if (this.decel) {
      return this._deny(e, `deceleration window in progress until clock ${this.decel.end}; speed request discarded`, 'discarded');
    }
    if (this.mode === 'maintenance') {
      return this._deny(e, 'maintenance mode forbids motion commands', 'violation');
    }
    if (this.mode === 'teach') {
      const effective = Math.min(e.mm_s, TEACH_SPEED_LIMIT);
      if (e.mm_s > TEACH_SPEED_LIMIT) {
        // Safety rule wins over the throughput rule.
        this._deny(e, `safety speed limit ${TEACH_SPEED_LIMIT} mm/s overrides throughput request ${e.mm_s} mm/s in teach mode`, 'violation');
      }
      this.speedLimit = effective;
      return this._transition(e, 'speed_set', { requested: e.mm_s, effective });
    }
    const effective = Math.min(e.mm_s, AUTO_SPEED_LIMIT);
    this.speedLimit = effective;
    this._transition(e, 'speed_set', { requested: e.mm_s, effective });
  }
}

module.exports = {
  Interpreter,
  ExitError,
  normalizeEvent,
  compareEvents,
  MODES,
  SAFETY_LEVEL,
  KEY_SCOPES,
  TEACH_SPEED_LIMIT,
  AUTO_SPEED_LIMIT,
  DECEL_TICKS,
};
