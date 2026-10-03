import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_BALANCE = 1_000_000;
export const EVENTS_FILE = 'events.jsonl';

const RISK_RESULTS = new Set(['pass', 'reject']);
const ACCOUNT_RESULTS = new Set(['pass', 'insufficient']);
const EVENT_TYPES = new Set(['instruction', 'risk', 'account', 'confirm']);

export class TradingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function initialState() {
  return {
    balances: { available: DEFAULT_BALANCE, frozen: 0 },
    trades: {},
  };
}

function requireString(obj, field) {
  if (typeof obj[field] !== 'string' || obj[field].length === 0) {
    throw new TradingError('INVALID_EVENT', `event.${field} must be a non-empty string`);
  }
  return obj[field];
}

export function validateEvent(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TradingError('INVALID_EVENT', 'event must be a JSON object');
  }
  const id = requireString(raw, 'id');
  const tradeId = requireString(raw, 'tradeId');
  if (!EVENT_TYPES.has(raw.type)) {
    throw new TradingError('UNKNOWN_EVENT_TYPE', `unknown event type: ${String(raw.type)}`);
  }
  switch (raw.type) {
    case 'instruction': {
      const amount = raw.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new TradingError('INVALID_EVENT', 'instruction.amount must be a positive finite number');
      }
      if (!RISK_RESULTS.has(raw.riskResult)) {
        throw new TradingError('INVALID_EVENT', `instruction.riskResult must be one of ${[...RISK_RESULTS].join(', ')}`);
      }
      if (!ACCOUNT_RESULTS.has(raw.accountResult)) {
        throw new TradingError('INVALID_EVENT', `instruction.accountResult must be one of ${[...ACCOUNT_RESULTS].join(', ')}`);
      }
      return {
        id, type: 'instruction', tradeId, amount,
        riskResult: raw.riskResult,
        accountResult: raw.accountResult,
        crashBeforeConfirm: raw.crashBeforeConfirm === true,
        manualBranches: raw.manualBranches === true,
      };
    }
    case 'risk':
    case 'account': {
      const event = { id, type: raw.type, tradeId };
      if (raw.result !== undefined) {
        const allowed = raw.type === 'risk' ? RISK_RESULTS : ACCOUNT_RESULTS;
        if (!allowed.has(raw.result)) {
          throw new TradingError('INVALID_EVENT', `${raw.type}.result must be one of ${[...allowed].join(', ')}`);
        }
        event.result = raw.result;
      }
      return event;
    }
    case 'confirm':
      return { id, type: 'confirm', tradeId };
    default:
      throw new TradingError('UNKNOWN_EVENT_TYPE', `unknown event type: ${String(raw.type)}`);
  }
}

function bothBranches(trade) {
  return trade.branches.risk !== undefined && trade.branches.account !== undefined;
}

// Pure state transition, used both live and when replaying the JSONL log.
function applyEvent(state, event) {
  switch (event.type) {
    case 'instruction': {
      if (state.trades[event.tradeId]) return;
      state.trades[event.tradeId] = {
        tradeId: event.tradeId,
        amount: event.amount,
        riskResult: event.riskResult,
        accountResult: event.accountResult,
        crashBeforeConfirm: event.crashBeforeConfirm,
        branches: {},
        frozen: 0,
        status: 'pending',
      };
      return;
    }
    case 'risk': {
      const trade = state.trades[event.tradeId];
      if (!trade || trade.branches.risk !== undefined) return;
      trade.branches.risk = event.result ?? trade.riskResult;
      return;
    }
    case 'account': {
      const trade = state.trades[event.tradeId];
      if (!trade || trade.branches.account !== undefined) return;
      let result = event.result ?? trade.accountResult;
      if (result === 'pass') {
        if (state.balances.available >= trade.amount) {
          state.balances.available -= trade.amount;
          state.balances.frozen += trade.amount;
          trade.frozen = trade.amount;
        } else {
          result = 'insufficient';
        }
      }
      trade.branches.account = result;
      return;
    }
    case 'confirm': {
      const trade = state.trades[event.tradeId];
      if (!trade || trade.status !== 'pending') return;
      if (!bothBranches(trade)) return;
      if (trade.branches.risk === 'pass' && trade.branches.account === 'pass') {
        trade.status = 'filled';
      } else {
        trade.status = 'cancelled';
        state.balances.available += trade.frozen;
      }
      state.balances.frozen -= trade.frozen;
      trade.frozen = 0;
      return;
    }
    default:
      return;
  }
}

export class TradingEngine {
  #workdir;
  #eventsFile;
  #events = [];
  #seen = new Set();
  #state = initialState();
  #recovered = false;

  constructor(workdir) {
    this.#workdir = workdir;
    this.#eventsFile = path.join(workdir, EVENTS_FILE);
  }

  static async open(workdir) {
    const engine = new TradingEngine(workdir);
    await fs.mkdir(workdir, { recursive: true });
    let text = '';
    try {
      text = await fs.readFile(engine.#eventsFile, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      engine.#events.push(event);
      engine.#seen.add(`${event.tradeId}:${event.id}`);
      applyEvent(engine.#state, event);
    }
    return engine;
  }

  get workdir() {
    return this.#workdir;
  }

  get events() {
    return this.#events.map((event) => ({ ...event }));
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  stateHash() {
    return createHash('sha256').update(JSON.stringify(canonicalize(this.#state))).digest('hex');
  }

  certificate(extra = {}, tradeId = null) {
    const cert = {
      status: 'ok',
      ...extra,
      balances: { ...this.#state.balances },
      eventCount: this.#events.length,
      stateHash: this.stateHash(),
    };
    if (tradeId !== null) {
      cert.tradeId = tradeId;
      cert.tradeStatus = this.#state.trades[tradeId]?.status ?? null;
    }
    return cert;
  }

  // Persist first, mutate in-memory state second.
  async #append(event) {
    await fs.appendFile(this.#eventsFile, JSON.stringify(event) + '\n', 'utf8');
    this.#events.push(event);
    this.#seen.add(`${event.tradeId}:${event.id}`);
    applyEvent(this.#state, event);
  }

  async #tryJoin(tradeId) {
    const trade = this.#state.trades[tradeId];
    if (!trade || trade.status !== 'pending' || !bothBranches(trade)) return false;
    if (trade.crashBeforeConfirm && !this.#recovered) return false;
    await this.#append({ id: `confirm:${tradeId}`, type: 'confirm', tradeId });
    return true;
  }

  async submit(rawEvent) {
    const event = validateEvent(rawEvent);
    const key = `${event.tradeId}:${event.id}`;
    if (this.#seen.has(key)) {
      return this.certificate({ applied: false, duplicate: true }, event.tradeId);
    }
    const trade = this.#state.trades[event.tradeId];
    if (event.type === 'instruction') {
      if (trade) {
        throw new TradingError('DUPLICATE_TRADE', `trade ${event.tradeId} already exists`);
      }
    } else {
      if (!trade) {
        throw new TradingError('TRADE_NOT_FOUND', `trade ${event.tradeId} does not exist`);
      }
      if (event.type === 'confirm' && !bothBranches(trade)) {
        throw new TradingError('CONFIRM_NOT_READY', `trade ${event.tradeId} is still waiting for branch results`);
      }
    }

    await this.#append(event);

    if (event.type === 'instruction' && !event.manualBranches) {
      await this.#append({ id: `${event.id}:risk`, type: 'risk', tradeId: event.tradeId, result: event.riskResult });
      await this.#append({ id: `${event.id}:account`, type: 'account', tradeId: event.tradeId, result: event.accountResult });
    }

    const joined = await this.#tryJoin(event.tradeId);
    const current = this.#state.trades[event.tradeId];
    const crashed = !joined && current.status === 'pending' && bothBranches(current);
    return this.certificate({ applied: true, duplicate: false, crashed }, event.tradeId);
  }

  // Recovery after a crash: complete any trade whose branches both landed but
  // whose confirm was never persisted. Idempotent across restarts.
  async recover() {
    this.#recovered = true;
    const joined = [];
    for (const tradeId of Object.keys(this.#state.trades)) {
      if (await this.#tryJoin(tradeId)) joined.push(tradeId);
    }
    return this.certificate({ recovered: true, joined });
  }
}
