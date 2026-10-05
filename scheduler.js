'use strict';

// Deterministic PRNG (mulberry32) used to simulate packet loss.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const COMMAND_TYPES = new Set(['PLAN', 'MOVE', 'CANCEL']);
const TX_TYPES = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function isPosNum(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function validateOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new ProtocolError('op must be a plain object');
  }
  if (typeof op.type !== 'string' || (!COMMAND_TYPES.has(op.type) && !TX_TYPES.has(op.type))) {
    throw new ProtocolError(`unknown op type: ${String(op.type)}`);
  }
  if (TX_TYPES.has(op.type)) return;
  if (typeof op.id !== 'string' && typeof op.id !== 'number') {
    throw new ProtocolError(`${op.type}: id (string|number) is required`);
  }
  if (!Number.isInteger(op.ver) || op.ver < 1) {
    throw new ProtocolError(`${op.type} ${op.id}: ver must be a positive integer`);
  }
  if (op.type === 'PLAN') {
    if (!isNonNegInt(op.start)) throw new ProtocolError(`PLAN ${op.id}: start must be a non-negative integer (day index)`);
    if (!isPosNum(op.cost)) throw new ProtocolError(`PLAN ${op.id}: cost must be a positive number`);
  }
  if (op.type === 'MOVE') {
    if (!isNonNegInt(op.start)) throw new ProtocolError(`MOVE ${op.id}: start must be a non-negative integer (day index)`);
    if (op.cost !== undefined && !isPosNum(op.cost)) throw new ProtocolError(`MOVE ${op.id}: cost must be a positive number`);
  }
  for (const key of ['loseSend', 'loseAck']) {
    if (op[key] !== undefined && !isNonNegInt(op[key])) {
      throw new ProtocolError(`${op.type} ${op.id}: ${key} must be a non-negative integer`);
    }
  }
}

function comparePlan(a, b) {
  if (a.start !== b.start) return a.start - b.start;
  const sa = String(a.id);
  const sb = String(b.id);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// The line terminal: authoritative state for confirmed commands.
// Applies PLAN/MOVE/CANCEL atomically against the daily budget cap,
// dedups repeated (id, ver) commands and ignores stale versions.
class Terminal {
  constructor(cap) {
    this.cap = cap;
    this.plans = new Map(); // id -> {id, start, cost, ver}
    this.usage = new Map(); // day -> used budget
    this.lastVer = new Map(); // id -> last applied ver
    this.acked = new Map(); // `${id}:${ver}` -> content key (dedup)
    this.ledger = [];
    this.seq = 0;
  }

  used(day) {
    return this.usage.get(day) || 0;
  }

  contentKey(cmd) {
    return `${cmd.type}|${cmd.start === undefined ? '' : cmd.start}|${cmd.cost === undefined ? '' : cmd.cost}`;
  }

  record(op, id, day, delta, rollback) {
    const entry = { seq: ++this.seq, op, id, day, delta, used: this.used(day), cap: this.cap };
    if (rollback) entry.rollback = true;
    this.ledger.push(entry);
  }

  // Returns {status:'ACK', dup, undo} | {status:'STALE'} | {status:'NAK', reason}.
  receive(cmd, opts = {}) {
    const internal = opts.internal === true;
    const rollback = opts.rollback === true;
    if (!internal) {
      const last = this.lastVer.get(cmd.id);
      if (last !== undefined && cmd.ver < last) return { status: 'STALE' };
      if (last === cmd.ver) {
        const prev = this.acked.get(`${cmd.id}:${cmd.ver}`);
        if (prev !== undefined && prev === this.contentKey(cmd)) {
          return { status: 'ACK', dup: true, undo: null };
        }
        return { status: 'NAK', reason: 'version-conflict' };
      }
    }
    let undo = null;
    switch (cmd.type) {
      case 'PLAN': {
        if (this.plans.has(cmd.id)) return { status: 'NAK', reason: 'id-exists' };
        if (this.used(cmd.start) + cmd.cost > this.cap) return { status: 'NAK', reason: 'budget' };
        this.plans.set(cmd.id, { id: cmd.id, start: cmd.start, cost: cmd.cost, ver: cmd.ver });
        this.usage.set(cmd.start, this.used(cmd.start) + cmd.cost);
        this.record('PLAN', cmd.id, cmd.start, cmd.cost, rollback);
        undo = { type: 'CANCEL', id: cmd.id };
        break;
      }
      case 'MOVE': {
        const cur = this.plans.get(cmd.id);
        if (!cur) return { status: 'NAK', reason: 'unknown-id' };
        const newStart = cmd.start;
        const newCost = cmd.cost === undefined ? cur.cost : cmd.cost;
        // Atomic check: release old occupancy, then occupy the new slot.
        const oldDayAfter = this.used(cur.start) - cur.cost;
        const newDayAfter = (cur.start === newStart ? oldDayAfter : this.used(newStart)) + newCost;
        if (newDayAfter > this.cap) return { status: 'NAK', reason: 'budget' };
        this.usage.set(cur.start, oldDayAfter);
        this.record('MOVE-RELEASE', cmd.id, cur.start, -cur.cost, rollback);
        this.usage.set(newStart, newDayAfter);
        this.record('MOVE-OCCUPY', cmd.id, newStart, newCost, rollback);
        this.plans.set(cmd.id, { id: cmd.id, start: newStart, cost: newCost, ver: cmd.ver });
        undo = { type: 'MOVE', id: cmd.id, start: cur.start, cost: cur.cost };
        break;
      }
      case 'CANCEL': {
        const cur = this.plans.get(cmd.id);
        if (!cur) return { status: 'NAK', reason: 'unknown-id' };
        this.usage.set(cur.start, this.used(cur.start) - cur.cost);
        this.record('CANCEL', cmd.id, cur.start, -cur.cost, rollback);
        this.plans.delete(cmd.id);
        undo = { type: 'PLAN', id: cmd.id, start: cur.start, cost: cur.cost };
        break;
      }
      default:
        return { status: 'NAK', reason: 'bad-type' };
    }
    if (!internal) {
      this.lastVer.set(cmd.id, cmd.ver);
      this.acked.set(`${cmd.id}:${cmd.ver}`, this.contentKey(cmd));
    }
    return { status: 'ACK', dup: false, undo };
  }
}

// The scheduler: validates ops, runs the confirm protocol with the terminal,
// retransmits lost packets with exponential backoff, and manages nested
// transactions whose rollback may only undo unconfirmed work.
class Engine {
  constructor(options = {}) {
    const {
      cap,
      seed = 1,
      lossRate = 0,
      baseDelay = 100,
      maxAttempts = 8,
    } = options;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
      throw new ProtocolError('cap must be a non-negative finite number');
    }
    this.cap = cap;
    this.seed = seed;
    this.lossRate = lossRate;
    this.baseDelay = baseDelay;
    this.maxAttempts = maxAttempts;
    this.rand = mulberry32(seed);
    this.terminal = new Terminal(cap);
    this.txStack = [];
    this.pending = [];
    this.retransmissions = [];
    this.confirmed = [];
    this.ignored = [];
    this.rolledBack = [];
    this.keptAcked = [];
    this.errors = [];
    this.budgetFailed = false;
    this.protocolError = null;
  }

  randomLoss() {
    return this.rand() < this.lossRate;
  }

  delayFor(attempt) {
    return this.baseDelay * 2 ** (attempt - 1);
  }

  noteRetransmit(cmd, attempt, reason) {
    if (attempt >= this.maxAttempts) return;
    this.retransmissions.push({ id: cmd.id, ver: cmd.ver, attempt, delay: this.delayFor(attempt), reason });
  }

  recordTx(rec) {
    if (this.txStack.length > 0) this.txStack[this.txStack.length - 1].push(rec);
  }

  sendCommand(cmd) {
    const explicitLoss =
      Object.prototype.hasOwnProperty.call(cmd, 'loseSend') ||
      Object.prototype.hasOwnProperty.call(cmd, 'loseAck');
    const loseSend = cmd.loseSend || 0;
    const loseAck = cmd.loseAck || 0;
    let attempt = 0;
    let delivered = false;
    let undo = null;
    while (attempt < this.maxAttempts) {
      attempt += 1;
      const sendLost = explicitLoss ? attempt <= loseSend : this.randomLoss();
      if (sendLost) {
        this.noteRetransmit(cmd, attempt, 'send-lost');
        continue;
      }
      const res = this.terminal.receive(cmd);
      if (res.status === 'STALE') {
        this.ignored.push({ id: cmd.id, ver: cmd.ver, op: cmd.type, reason: 'stale-version' });
        this.recordTx({ cmd, status: 'stale' });
        return;
      }
      if (res.status === 'NAK') {
        if (res.reason === 'budget') {
          this.budgetFailed = true;
          this.errors.push({
            type: 'budget',
            op: cmd.type,
            id: cmd.id,
            ver: cmd.ver,
            day: cmd.start,
            message: 'insufficient daily budget; state unchanged',
          });
          this.recordTx({ cmd, status: 'nak-budget' });
          return;
        }
        throw new ProtocolError(`${cmd.type} ${cmd.id} v${cmd.ver}: ${res.reason}`);
      }
      // ACK
      delivered = true;
      if (!res.dup) undo = res.undo;
      const ackLost = explicitLoss ? attempt <= loseAck : this.randomLoss();
      if (ackLost) {
        this.noteRetransmit(cmd, attempt, 'ack-lost');
        continue;
      }
      this.confirmed.push({ id: cmd.id, ver: cmd.ver, op: cmd.type, dup: res.dup });
      this.recordTx({ cmd, status: res.dup ? 'acked-dup' : 'acked' });
      return;
    }
    const entry = { cmd, attempt, nextDelay: this.delayFor(attempt), delivered, undo };
    this.pending.push(entry);
    this.recordTx({ cmd, status: 'pending', entry });
  }

  rollbackLevel(level) {
    for (const rec of [...level].reverse()) {
      const { cmd, status, entry } = rec;
      if (status === 'pending') {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        if (entry.delivered && entry.undo) {
          const res = this.terminal.receive({ ...entry.undo, ver: cmd.ver }, { internal: true, rollback: true });
          if (res.status === 'NAK') {
            this.budgetFailed = true;
            this.errors.push({
              type: 'budget',
              op: entry.undo.type,
              id: cmd.id,
              message: 'rollback compensation failed: insufficient budget',
            });
          }
        }
        this.rolledBack.push({ id: cmd.id, ver: cmd.ver, op: cmd.type, delivered: entry.delivered });
      } else if (status === 'acked' || status === 'acked-dup') {
        // ACKed history must not be rolled back.
        this.keptAcked.push({ id: cmd.id, ver: cmd.ver, op: cmd.type });
      }
      // 'stale' and 'nak-budget' never mutated state: nothing to undo.
    }
  }

  step(op) {
    validateOp(op);
    if (op.type === 'BEGIN') {
      this.txStack.push([]);
      return;
    }
    if (op.type === 'COMMIT') {
      if (this.txStack.length === 0) throw new ProtocolError('COMMIT without BEGIN');
      const level = this.txStack.pop();
      if (this.txStack.length > 0) this.txStack[this.txStack.length - 1].push(...level);
      return;
    }
    if (op.type === 'ROLLBACK') {
      if (this.txStack.length === 0) throw new ProtocolError('ROLLBACK without BEGIN');
      this.rollbackLevel(this.txStack.pop());
      return;
    }
    this.sendCommand(op);
  }

  run(ops) {
    if (!Array.isArray(ops)) {
      this.protocolError = 'ops must be an array';
      this.errors.push({ type: 'protocol', message: this.protocolError });
      return this.result();
    }
    for (const op of ops) {
      try {
        this.step(op);
      } catch (err) {
        if (err instanceof ProtocolError) {
          this.protocolError = err.message;
          this.errors.push({ type: 'protocol', message: err.message });
          break;
        }
        throw err;
      }
    }
    return this.result();
  }

  result() {
    const plan = [...this.terminal.plans.values()]
      .map((p) => ({ id: p.id, start: p.start, cost: p.cost, ver: p.ver }))
      .sort(comparePlan);
    const usage = {};
    for (const [day, used] of [...this.terminal.usage.entries()].sort((a, b) => a[0] - b[0])) {
      if (used > 0) usage[day] = used;
    }
    const exitCode = this.protocolError ? 3 : this.budgetFailed ? 5 : 0;
    return {
      config: {
        cap: this.cap,
        seed: this.seed,
        lossRate: this.lossRate,
        baseDelay: this.baseDelay,
        maxAttempts: this.maxAttempts,
      },
      plan,
      usage,
      ledger: this.terminal.ledger,
      pending: this.pending.map((p) => ({
        id: p.cmd.id,
        ver: p.cmd.ver,
        op: p.cmd.type,
        attempt: p.attempt,
        nextDelay: p.nextDelay,
        delivered: p.delivered,
      })),
      retransmissions: this.retransmissions,
      confirmed: this.confirmed,
      ignored: this.ignored,
      rolledBack: this.rolledBack,
      keptAcked: this.keptAcked,
      errors: this.errors,
      exitCode,
    };
  }
}

function runOps(ops, options) {
  return new Engine(options).run(ops);
}

module.exports = { runOps, Engine, Terminal, ProtocolError, mulberry32 };
