'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

const EVENT_TYPES = new Set(['instruction', 'risk', 'account', 'finalize']);

class Engine {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.logFile = path.join(dir, 'events.jsonl');
    this.initialQuota = opts.quota ?? 1000;
    this.quota = { available: this.initialQuota, frozen: 0 };
    this.trades = new Map();
    this.seenIds = new Set();
    this.events = 0;

    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(this.logFile)) {
      const lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        this._fold(JSON.parse(line));
        this.events += 1;
      }
    }
    this._recover();
  }

  apply(event) {
    this._validate(event);
    if (this.seenIds.has(event.id)) {
      return { ...this.certificate(event.tradeId), deduped: true };
    }
    switch (event.type) {
      case 'instruction':
        return this._applyInstruction(event);
      case 'risk':
      case 'account': {
        this._requireTrade(event.tradeId);
        this._persist(event);
        this._maybeJoin(event.tradeId);
        return this.certificate(event.tradeId);
      }
      case 'finalize':
        this.finalize(event.tradeId);
        return this.certificate(event.tradeId);
      default:
        throw new EngineError('INVALID_EVENT', `unsupported event type: ${event.type}`);
    }
  }

  finalize(tradeId) {
    const trade = this.trades.get(tradeId);
    if (!trade) {
      throw new EngineError('TRADE_NOT_FOUND', `unknown tradeId: ${tradeId}`);
    }
    if (trade.status !== 'open') {
      return false;
    }
    if (trade.risk === null || trade.account === null) {
      throw new EngineError(
        'TRADE_NOT_READY',
        `trade ${tradeId} cannot join: waiting for ${trade.risk === null ? 'risk' : 'account'} branch`
      );
    }
    const finalId = `final:${tradeId}`;
    if (this.seenIds.has(finalId)) {
      return false;
    }
    if (trade.risk.approved && trade.account.frozen) {
      this._persist({ id: finalId, type: 'confirm', tradeId });
    } else {
      const reason = !trade.risk.approved ? 'risk_rejected' : 'account_insufficient';
      this._persist({ id: finalId, type: 'cancel', tradeId, reason });
    }
    return true;
  }

  certificate(tradeId = null) {
    const trade = tradeId === null ? null : this.trades.get(tradeId) ?? null;
    return {
      ok: true,
      tradeId,
      status: trade ? trade.status : null,
      quota: { ...this.quota },
      events: this.events,
      stateHash: this.stateHash(),
    };
  }

  stateHash() {
    const trades = [...this.trades.values()]
      .sort((a, b) => (a.tradeId < b.tradeId ? -1 : 1))
      .map((t) => ({
        tradeId: t.tradeId,
        amount: t.amount,
        status: t.status,
        risk: t.risk,
        account: t.account,
      }));
    const canonical = JSON.stringify({ quota: this.quota, trades });
    return crypto.createHash('sha256').update(canonical).digest('hex');
  }

  _applyInstruction(event) {
    if (this.trades.has(event.tradeId)) {
      this.seenIds.add(event.id);
      return { ...this.certificate(event.tradeId), deduped: true };
    }
    this._persist(event);

    const hasRisk = event.riskResult !== undefined;
    const hasAccount = event.accountResult !== undefined;
    if (hasRisk) {
      this._persist({
        id: `risk:${event.tradeId}`,
        type: 'risk',
        tradeId: event.tradeId,
        approved: event.riskResult === 'approve',
      });
    }
    if (hasAccount) {
      const canFreeze =
        event.accountResult === 'sufficient' && this.quota.available >= event.amount;
      this._persist({
        id: `account:${event.tradeId}`,
        type: 'account',
        tradeId: event.tradeId,
        frozen: canFreeze,
      });
    }
    if (event.crashBeforeConfirm === true) {
      return { ...this.certificate(event.tradeId), crashed: true };
    }
    this._maybeJoin(event.tradeId);
    return this.certificate(event.tradeId);
  }

  _maybeJoin(tradeId) {
    const trade = this.trades.get(tradeId);
    if (trade && trade.status === 'open' && trade.risk !== null && trade.account !== null) {
      this.finalize(tradeId);
    }
  }

  _recover() {
    for (const trade of this.trades.values()) {
      if (trade.status === 'open' && trade.risk !== null && trade.account !== null) {
        this.finalize(trade.tradeId);
      }
    }
  }

  _persist(event) {
    fs.appendFileSync(this.logFile, JSON.stringify(event) + '\n');
    this._fold(event);
    this.events += 1;
  }

  _fold(event) {
    this.seenIds.add(event.id);
    switch (event.type) {
      case 'instruction': {
        if (!this.trades.has(event.tradeId)) {
          this.trades.set(event.tradeId, {
            tradeId: event.tradeId,
            amount: event.amount,
            status: 'open',
            risk: null,
            account: null,
          });
        }
        break;
      }
      case 'risk': {
        const trade = this.trades.get(event.tradeId);
        if (trade) trade.risk = { approved: event.approved };
        break;
      }
      case 'account': {
        const trade = this.trades.get(event.tradeId);
        if (trade && event.frozen) {
          this.quota.available -= trade.amount;
          this.quota.frozen += trade.amount;
        }
        if (trade) trade.account = { frozen: event.frozen };
        break;
      }
      case 'confirm': {
        const trade = this.trades.get(event.tradeId);
        if (trade) {
          this.quota.frozen -= trade.amount;
          trade.status = 'confirmed';
        }
        break;
      }
      case 'cancel': {
        const trade = this.trades.get(event.tradeId);
        if (trade) {
          if (trade.account && trade.account.frozen) {
            this.quota.frozen -= trade.amount;
            this.quota.available += trade.amount;
          }
          trade.status = 'cancelled';
        }
        break;
      }
      default:
        break;
    }
  }

  _requireTrade(tradeId) {
    if (!this.trades.has(tradeId)) {
      throw new EngineError('TRADE_NOT_FOUND', `unknown tradeId: ${tradeId}`);
    }
    return this.trades.get(tradeId);
  }

  _validate(event) {
    const bad = (msg) => {
      throw new EngineError('INVALID_EVENT', msg);
    };
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      bad('event must be a JSON object');
    }
    if (typeof event.id !== 'string' || event.id.length === 0) {
      bad('event.id must be a non-empty string');
    }
    if (!EVENT_TYPES.has(event.type)) {
      bad(`event.type must be one of: ${[...EVENT_TYPES].join(', ')}`);
    }
    if (typeof event.tradeId !== 'string' || event.tradeId.length === 0) {
      bad('event.tradeId must be a non-empty string');
    }
    if (event.type === 'instruction') {
      if (typeof event.amount !== 'number' || !(event.amount > 0)) {
        bad('event.amount must be a positive number');
      }
      if (event.riskResult !== undefined && !['approve', 'reject'].includes(event.riskResult)) {
        bad('event.riskResult must be "approve" or "reject"');
      }
      if (
        event.accountResult !== undefined &&
        !['sufficient', 'insufficient'].includes(event.accountResult)
      ) {
        bad('event.accountResult must be "sufficient" or "insufficient"');
      }
    }
    if (event.type === 'risk' && typeof event.approved !== 'boolean') {
      bad('event.approved must be a boolean');
    }
    if (event.type === 'account') {
      if (typeof event.frozen !== 'boolean') {
        bad('event.frozen must be a boolean');
      }
      if (event.frozen === true && this.trades.has(event.tradeId)) {
        const trade = this.trades.get(event.tradeId);
        if (trade.account === null && this.quota.available < trade.amount) {
          throw new EngineError(
            'INSUFFICIENT_QUOTA',
            `available quota ${this.quota.available} cannot freeze ${trade.amount}`
          );
        }
      }
    }
  }
}

module.exports = { Engine, EngineError };
