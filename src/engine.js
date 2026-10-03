// Trading engine: execution occupies reserve, deducts fee, registers a match.
// Cancellation is a compensating saga running the exact reverse order:
// UNDO_MATCH -> REFUND_FEE -> RELEASE_RESERVE. Each branch is ACK-tracked;
// ACKed branches are idempotent and never compensate twice.

export const EXECUTION_STAGES = ['RESERVE', 'CHARGE_FEE', 'REGISTER_MATCH'];
export const BRANCHES = ['UNDO_MATCH', 'REFUND_FEE', 'RELEASE_RESERVE'];

export class TradeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TradeError';
    this.code = code;
  }
}

function freshState() {
  return {
    accounts: {},      // accountId -> { available, reserved }
    feesCollected: 0,  // fees currently held by the venue
    matches: {},       // tradeId -> match record
    trades: {},        // tradeId -> trade record
  };
}

export class TradingEngine {
  constructor(state) {
    this.state = state && typeof state === 'object' ? state : freshState();
    this.state.accounts ??= {};
    this.state.matches ??= {};
    this.state.trades ??= {};
    this.state.feesCollected ??= 0;
  }

  toJSON() {
    return this.state;
  }

  ensureAccount(accountId) {
    if (typeof accountId !== 'string' || accountId.length === 0) {
      throw new TradeError('INVALID_COMMAND', 'accountId must be a non-empty string');
    }
    return (this.state.accounts[accountId] ??= { available: 0, reserved: 0 });
  }

  getAccount(accountId) {
    const account = this.state.accounts[accountId];
    if (!account) throw new TradeError('UNKNOWN_ACCOUNT', `unknown account: ${accountId}`);
    return { accountId, ...account };
  }

  getTrade(tradeId) {
    const trade = this.state.trades[tradeId];
    if (!trade) throw new TradeError('UNKNOWN_TRADE', `unknown trade: ${tradeId}`);
    return trade;
  }

  deposit(accountId, amount) {
    assertAmount('amount', amount, true);
    const account = this.ensureAccount(accountId);
    account.available += amount;
    return { accountId, ...account };
  }

  // Execution stages in order: reserve funds, charge fee, register match.
  executeTrade({ tradeId, accountId, amount, fee = 0, irreversible = false } = {}) {
    if (typeof tradeId !== 'string' || tradeId.length === 0) {
      throw new TradeError('INVALID_COMMAND', 'tradeId must be a non-empty string');
    }
    assertAmount('amount', amount, true);
    assertAmount('fee', fee, false);
    if (this.state.trades[tradeId]) {
      throw new TradeError('DUPLICATE_TRADE', `trade already exists: ${tradeId}`);
    }
    const account = this.ensureAccount(accountId);
    if (account.available < amount + fee) {
      throw new TradeError(
        'INSUFFICIENT_FUNDS',
        `need ${amount + fee}, have ${account.available}`,
      );
    }
    // Stage 1: occupy reserve.
    account.available -= amount;
    account.reserved += amount;
    // Stage 2: deduct fee.
    account.available -= fee;
    this.state.feesCollected += fee;
    // Stage 3: register match result.
    this.state.matches[tradeId] = { tradeId, accountId, amount, fee };
    const trade = {
      tradeId,
      accountId,
      amount,
      fee,
      irreversible: Boolean(irreversible),
      status: 'EXECUTED',
      acks: { UNDO_MATCH: false, REFUND_FEE: false, RELEASE_RESERVE: false },
      compensationLog: [],
    };
    this.state.trades[tradeId] = trade;
    return trade;
  }

  // Applies one compensation branch to the ledger exactly once.
  // Returns true when newly applied, false when the branch was already ACKed.
  applyCompensation(trade, branch) {
    if (trade.acks[branch]) return false;
    const account = this.state.accounts[trade.accountId];
    switch (branch) {
      case 'UNDO_MATCH':
        delete this.state.matches[trade.tradeId];
        break;
      case 'REFUND_FEE':
        this.state.feesCollected -= trade.fee;
        account.available += trade.fee;
        break;
      case 'RELEASE_RESERVE':
        account.reserved -= trade.amount;
        account.available += trade.amount;
        break;
      default:
        throw new TradeError('UNKNOWN_BRANCH', `unknown branch: ${branch}`);
    }
    trade.acks[branch] = true;
    trade.compensationLog.push({ seq: trade.compensationLog.length + 1, branch });
    return true;
  }

  // Async ACK channel: duplicate ACKs are idempotent no-ops.
  acknowledge(tradeId, branch) {
    const trade = this.getTrade(tradeId);
    if (!BRANCHES.includes(branch)) {
      throw new TradeError('UNKNOWN_BRANCH', `unknown branch: ${branch}`);
    }
    const applied = this.applyCompensation(trade, branch);
    if (BRANCHES.every((b) => trade.acks[b])) trade.status = 'CANCELLED';
    return { tradeId, branch, applied, status: trade.status };
  }

  // Runs the compensating saga in reverse execution order. `hooks[branch]`
  // may be supplied (tests/CLI) to simulate a failing branch by throwing.
  // On failure the trade stays CANCELLING; retrying resumes at the first
  // incomplete branch because ACKed branches are skipped.
  cancelTrade(tradeId, hooks = {}) {
    const trade = this.getTrade(tradeId);
    if (trade.irreversible) {
      throw new TradeError(
        'IRREVERSIBLE_CONFLICT',
        `trade ${tradeId} is marked irreversible; cancellation rejected`,
      );
    }
    if (trade.status === 'CANCELLED') {
      return this.cancelResult(trade, null); // idempotent repeat
    }
    trade.status = 'CANCELLING';
    let failed = null;
    for (const branch of BRANCHES) {
      if (trade.acks[branch]) continue; // already ACKed: never compensate twice
      try {
        if (typeof hooks[branch] === 'function') hooks[branch](trade);
      } catch (err) {
        failed = { branch, message: String((err && err.message) || err) };
        break;
      }
      this.applyCompensation(trade, branch);
    }
    if (!failed && BRANCHES.every((b) => trade.acks[b])) {
      trade.status = 'CANCELLED';
    }
    return this.cancelResult(trade, failed);
  }

  cancelResult(trade, failed) {
    return {
      tradeId: trade.tradeId,
      status: trade.status,
      failed,
      acked: BRANCHES.filter((b) => trade.acks[b]),
      certificate: trade.status === 'CANCELLED' ? this.certificate(trade.tradeId) : null,
    };
  }

  certificate(tradeId) {
    const trade = this.getTrade(tradeId);
    const account = this.state.accounts[trade.accountId];
    return {
      tradeId: trade.tradeId,
      status: trade.status,
      compensated: trade.compensationLog.map((entry) => entry.branch),
      compensationLog: trade.compensationLog.map((entry) => ({ ...entry })),
      account: { accountId: trade.accountId, ...account },
      feesCollected: this.state.feesCollected,
      openMatches: Object.keys(this.state.matches).length,
    };
  }
}

function assertAmount(name, value, strictlyPositive) {
  const ok =
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (strictlyPositive ? value > 0 : value >= 0);
  if (!ok) {
    throw new TradeError(
      'INVALID_COMMAND',
      `${name} must be a finite number ${strictlyPositive ? '> 0' : '>= 0'}`,
    );
  }
}
