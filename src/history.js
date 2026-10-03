import { LimError } from './errors.js';

const KINDS = new Set(['reserve', 'confirm', 'release']);

// Load and statically type a concurrent history. Each op has an
// invoke/response interval; an op with no response is PENDING and must
// never be treated as a failure.
export function checkHistory(spec, raw) {
  const ops = Array.isArray(raw) ? raw : raw?.ops;
  if (!Array.isArray(ops)) throw new LimError('E_TYPE', 'history must be a JSON array or { "ops": [...] }');

  const byId = new Map();
  const norm = ops.map((o, idx) => {
    const where = `op #${idx} (${o?.id ?? 'no id'})`;
    if (o === null || typeof o !== 'object') throw new LimError('E_TYPE', `${where}: must be an object`);
    if (typeof o.id !== 'string' || o.id === '') throw new LimError('E_TYPE', `${where}: id must be a non-empty string`);
    if (byId.has(o.id)) throw new LimError('E_TYPE', `duplicate op id '${o.id}'`);
    if (!KINDS.has(o.kind)) throw new LimError('E_TYPE', `${where}: kind must be reserve|confirm|release`);
    if (!Number.isInteger(o.invoke) || o.invoke < 0) throw new LimError('E_TYPE', `${where}: invoke must be a non-negative integer`);
    if (o.response !== null && o.response !== undefined && (!Number.isInteger(o.response) || o.response < o.invoke)) {
      throw new LimError('E_TYPE', `${where}: response must be null or an integer >= invoke`);
    }
    const response = o.response ?? null;
    let result = o.result ?? (response === null ? 'pending' : null);
    if (response === null) result = 'pending';
    if (!['ok', 'fail', 'pending'].includes(result)) {
      throw new LimError('E_TYPE', `${where}: result must be ok|fail|pending`);
    }
    if (result === 'pending' && response !== null) {
      throw new LimError('E_TYPE', `${where}: pending op must not have a response`);
    }
    if (o.clock !== undefined && (!Number.isInteger(o.clock) || o.clock < 0)) {
      throw new LimError('E_TYPE', `${where}: clock must be a non-negative integer`);
    }
    const op = {
      id: o.id, kind: o.kind, invoke: o.invoke, response, result,
      clock: o.clock ?? null,
      account: o.account ?? null, strategy: o.strategy ?? null,
      amount: o.amount ?? null, target: o.target ?? null, order: o.order ?? null,
    };
    byId.set(op.id, op);
    return op;
  });

  const releases = new Map();
  const confirms = new Map();
  for (const op of norm) {
    if (op.kind === 'reserve') {
      let accountName = op.account;
      let strategyName = op.strategy;
      let amount = op.amount;
      if (op.order !== null) {
        const account = accountName !== null ? spec.accounts.get(accountName) : null;
        const template = account?.orders.get(op.order)
          ?? [...spec.accounts.values()].map(a => a.orders.get(op.order)).find(Boolean);
        if (!template) throw new LimError('E_TYPE', `op '${op.id}': unknown order '${op.order}'`);
        accountName = accountName ?? [...spec.accounts.values()].find(a => a.orders.has(op.order))?.name;
        strategyName = strategyName ?? template.strategy;
        amount = amount ?? template.amount;
        if (op.clock === null && template.clock !== null) op.clock = template.clock;
      }
      const account = spec.accounts.get(accountName);
      if (!account) throw new LimError('E_TYPE', `op '${op.id}': unknown account '${accountName}'`);
      if (!account.strategies.has(strategyName)) {
        throw new LimError('E_TYPE', `op '${op.id}': unknown strategy '${strategyName}' in account '${accountName}'`);
      }
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new LimError('E_TYPE', `op '${op.id}': amount must be a positive integer`);
      }
      op.account = accountName; op.strategy = strategyName; op.amount = amount;
    } else {
      // confirm / release consume an existing reserve.
      const target = op.target !== null ? byId.get(op.target) : null;
      if (!target || target.kind !== 'reserve') {
        throw new LimError('E_TYPE', `op '${op.id}': ${op.kind} must reference an existing reserve, got '${op.target}'`);
      }
      const seen = op.kind === 'release' ? releases : confirms;
      if (seen.has(op.target)) {
        // Static guarantee: a reserve is consumed at most once per kind.
        throw new LimError('E_TYPE',
          `op '${op.id}': duplicate ${op.kind} of reserve '${op.target}' (first: '${seen.get(op.target)}')`);
      }
      seen.set(op.target, op.id);
    }
  }
  return norm;
}
