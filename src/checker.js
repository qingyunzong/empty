import { EscrowError } from './errors.js';
import { round6 } from './util.js';

export function evalExpr(node) {
  switch (node.type) {
    case 'num': return node.value;
    case 'neg': return -evalExpr(node.arg);
    case 'bin': {
      const l = evalExpr(node.left);
      const r = evalExpr(node.right);
      switch (node.op) {
        case 'PLUS': return l + r;
        case 'MINUS': return l - r;
        case 'STAR': return l * r;
        case 'SLASH': return l / r;
      }
    }
  }
  throw new EscrowError('E_PARSE', 'bad expression node');
}

export function assetType(isin) {
  return isin.startsWith('XS') ? 'bond' : 'equity';
}

// Static checks: sign of qty/price/fee and direction/asset-type consistency.
export function check(stmt) {
  if (stmt.kind === 'revoke') {
    if (!Number.isInteger(stmt.version) || stmt.version < 1) {
      throw new EscrowError('E_VERSION', `revoke version must be >= 1, got v${stmt.version}`);
    }
    return stmt;
  }
  if (!Number.isInteger(stmt.version) || stmt.version < 1) {
    throw new EscrowError('E_VERSION', `version must be >= 1, got v${stmt.version}`);
  }
  const price = round6(evalExpr(stmt.priceExpr));
  const fee = stmt.feeExpr ? round6(evalExpr(stmt.feeExpr)) : 0;
  if (!Number.isInteger(stmt.qty) || stmt.qty <= 0) {
    throw new EscrowError('E_SIGN', `quantity must be a positive integer, got ${stmt.qty}`);
  }
  if (!(price > 0)) throw new EscrowError('E_SIGN', `price must be positive, got ${price}`);
  if (!(fee >= 0)) throw new EscrowError('E_SIGN', `fee must be non-negative, got ${fee}`);
  const at = assetType(stmt.isin);
  if (at === 'bond' && stmt.priceKind !== 'gross') {
    throw new EscrowError('E_SIGN', `bond ${stmt.isin} must be priced gross, got ${stmt.priceKind}`);
  }
  if (at === 'equity' && stmt.priceKind !== 'net') {
    throw new EscrowError('E_SIGN', `equity ${stmt.isin} must be priced net, got ${stmt.priceKind}`);
  }
  return { ...stmt, price, fee };
}
