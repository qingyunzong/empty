import { LimError } from './errors.js';

// Static typing of the spec: scopes (account-level capacity vs strategy-level
// sub-quotas), constraint expression types, and order template references.
export function checkSpec(ast) {
  const accounts = new Map();
  for (const account of ast.accounts) {
    if (accounts.has(account.name)) {
      throw new LimError('E_TYPE', `duplicate account '${account.name}'`);
    }
    if (account.capacity === null) {
      throw new LimError('E_TYPE', `account '${account.name}' missing capacity`);
    }
    const strategies = new Map();
    let quotaSum = 0;
    for (const s of account.strategies) {
      if (strategies.has(s.name)) {
        throw new LimError('E_TYPE', `duplicate strategy '${s.name}' in account '${account.name}'`);
      }
      strategies.set(s.name, s.quota);
      quotaSum += s.quota;
    }
    // Scope rule: sum of strategy-level sub-limits must not exceed the account limit.
    if (quotaSum > account.capacity) {
      throw new LimError('E_TYPE',
        `account '${account.name}': strategy quotas sum to ${quotaSum} > capacity ${account.capacity}`);
    }
    const orders = new Map();
    for (const o of account.orders) {
      if (orders.has(o.name)) {
        throw new LimError('E_TYPE', `duplicate order '${o.name}' in account '${account.name}'`);
      }
      if (o.strategy === null || o.amount === null) {
        throw new LimError('E_TYPE', `order '${o.name}' in account '${account.name}' needs strategy and amount`);
      }
      if (!strategies.has(o.strategy)) {
        throw new LimError('E_TYPE', `order '${o.name}' references unknown strategy '${o.strategy}'`);
      }
      orders.set(o.name, o);
    }
    for (const expr of account.constraints) {
      const t = typeOfExpr(expr, account.name, strategies);
      if (t !== 'bool') {
        throw new LimError('E_TYPE', `constraint in account '${account.name}' must be a comparison (bool), got ${t}`);
      }
    }
    accounts.set(account.name, {
      name: account.name,
      capacity: account.capacity,
      strategies,
      constraints: account.constraints,
      orders,
      clock: account.clock,
    });
  }
  return { accounts };
}

function typeOfExpr(expr, accountName, strategies) {
  switch (expr.type) {
    case 'num':
    case 'capacity':
      return 'num';
    case 'used':
    case 'quota':
      if (!strategies.has(expr.strategy)) {
        throw new LimError('E_TYPE',
          `account '${accountName}': ${expr.type}() references unknown strategy '${expr.strategy}'`);
      }
      return 'num';
    case 'var':
      throw new LimError('E_TYPE', `account '${accountName}': unknown identifier '${expr.name}' in constraint`);
    case 'neg': {
      const t = typeOfExpr(expr.expr, accountName, strategies);
      if (t !== 'num') throw new LimError('E_TYPE', `account '${accountName}': unary - needs num, got ${t}`);
      return 'num';
    }
    case 'bin': {
      const lt = typeOfExpr(expr.left, accountName, strategies);
      const rt = typeOfExpr(expr.right, accountName, strategies);
      if (lt !== 'num' || rt !== 'num') {
        throw new LimError('E_TYPE',
          `account '${accountName}': operator '${expr.op}' needs num operands, got ${lt} and ${rt}`);
      }
      return ['+', '-', '*'].includes(expr.op) ? 'num' : 'bool';
    }
    default:
      throw new LimError('E_TYPE', `unknown expression node '${expr.type}'`);
  }
}
