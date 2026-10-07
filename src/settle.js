// Net settlement: fold every invoice into the base currency with exact
// rational rates and report per-party net positions. Rounding (bankers,
// half-to-even) happens only here, at the very last step, and each rounded
// figure carries its exact error and worst-case bound.

import * as Q from './rational.js';
import { CodedError, partyOf } from './eventlog.js';
import { checkRateConsistency, buildCertificate } from './rates.js';

export function settle(log, { base, decimals = 2 } = {}) {
  const rates = log.rates();
  const invoices = log.invoices();
  const historyHash = log.head;

  const consistency = checkRateConsistency(rates);
  if (!consistency.ok) {
    return {
      status: 'infeasible',
      reason: 'rate-conflict',
      certificate: buildCertificate(rates),
      historyHash,
    };
  }

  const currencies = new Set();
  for (const r of rates) {
    currencies.add(r.from);
    currencies.add(r.to);
  }
  for (const inv of invoices) currencies.add(inv.ccy);

  if (base === undefined) {
    base = currencies.size ? [...currencies].sort()[0] : 'BASE';
  }
  if (currencies.size > 0 && !currencies.has(base)) {
    throw new CodedError('E_REF', `base currency "${base}" does not appear in the log`);
  }

  const valueOf = new Map();
  const pending = [];
  for (const ccy of currencies) {
    if (ccy === base) {
      valueOf.set(ccy, Q.ONE);
      continue;
    }
    consistency.find(ccy);
    consistency.find(base);
    if (consistency.find(ccy) === consistency.find(base)) {
      valueOf.set(ccy, Q.div(consistency.ratioOf(ccy), consistency.ratioOf(base)));
    } else {
      pending.push(ccy);
    }
  }

  if (pending.length > 0) {
    return {
      status: 'pending',
      error: {
        code: 'E_PENDING',
        message: `no rate path to base "${base}" for: ${pending.sort().join(', ')}`,
        pendingCurrencies: pending.sort(),
      },
      historyHash,
    };
  }

  const nets = new Map(); // party -> exact rational net in base currency
  for (const inv of invoices) {
    const party = partyOf(inv.id);
    const value = Q.mul(inv.amount, valueOf.get(inv.ccy));
    nets.set(party, Q.add(nets.get(party) ?? Q.ZERO, value));
  }

  const rows = [...nets.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([party, exact]) => {
    const { rounded, error, bound } = Q.roundHalfEven(exact, decimals);
    return {
      party,
      exact: Q.toString(exact),
      rounded: Q.formatDecimal(exact, decimals),
      roundingError: Q.toString(error),
      errorBound: Q.toString(bound),
    };
  });

  const total = [...nets.values()].reduce(Q.add, Q.ZERO);
  return {
    status: 'ok',
    base,
    decimals,
    balanced: Q.isZero(total),
    totalExact: Q.toString(total),
    note: 'net positions are the minimum-flow (optimal) clearing solution; rounding applied only at this final step',
    nets: rows,
    historyHash,
    stats: { ...log.stats },
  };
}
