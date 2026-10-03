import { LedgerError } from './errors.js';

export function emptyState() {
  return { accounts: {}, payments: {} };
}

function accountFor(state, account, range) {
  if (typeof account !== 'string' || account.length === 0) {
    throw new LedgerError('BAD_EVENT', 'event account must be a non-empty string', range);
  }
  return (state.accounts[account] ??= { balance: 0, credit: 0 });
}

export function applyEvent(state, event, seq) {
  const range = [seq, seq];
  if (!event || typeof event !== 'object') {
    throw new LedgerError('BAD_EVENT', 'event must be an object', range);
  }
  switch (event.type) {
    case 'payment': {
      if (typeof event.id !== 'string' || event.id.length === 0) {
        throw new LedgerError('BAD_EVENT', 'payment id must be a non-empty string', range);
      }
      if (!Number.isFinite(event.amount) || event.amount <= 0) {
        throw new LedgerError('BAD_EVENT', 'payment amount must be a positive number', range);
      }
      if (state.payments[event.id]) {
        throw new LedgerError('DUPLICATE_PAYMENT', `payment ${event.id} already exists`, range);
      }
      const account = accountFor(state, event.account, range);
      account.balance += event.amount;
      state.payments[event.id] = { account: event.account, amount: event.amount, cancelled: false };
      return;
    }
    case 'cancel': {
      if (typeof event.paymentId !== 'string') {
        throw new LedgerError('BAD_EVENT', 'cancel paymentId must be a string', range);
      }
      const payment = state.payments[event.paymentId];
      if (!payment) {
        throw new LedgerError('UNKNOWN_PAYMENT', `unknown payment ${event.paymentId}`, range);
      }
      if (payment.cancelled) {
        throw new LedgerError('ALREADY_CANCELLED', `payment ${event.paymentId} already cancelled`, range);
      }
      payment.cancelled = true;
      accountFor(state, payment.account, range).balance -= payment.amount;
      return;
    }
    case 'adjust': {
      if (!Number.isFinite(event.delta)) {
        throw new LedgerError('BAD_EVENT', 'adjust delta must be a finite number', range);
      }
      const account = accountFor(state, event.account, range);
      const credit = account.credit + event.delta;
      if (credit - account.balance < 0) {
        throw new LedgerError(
          'NEGATIVE_AVAILABLE',
          `adjustment would make available negative for ${event.account}`,
          range,
        );
      }
      account.credit = credit;
      return;
    }
    default:
      throw new LedgerError('BAD_EVENT', `unknown event type ${event.type}`, range);
  }
}
