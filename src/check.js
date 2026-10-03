import { DslError, E_SIGN } from './errors.js';
import { evalAst } from './expr.js';

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function assetClass(isin) {
  if (!ISIN_RE.test(isin)) return null;
  if (isin.startsWith('CNE')) return 'equity';
  if (isin.startsWith('CND')) return 'bond';
  return null;
}

function varsOf(node, out = new Set()) {
  if (!node) return out;
  if (node.k === 'var') out.add(node.name);
  if (node.k === 'bin') { varsOf(node.l, out); varsOf(node.r, out); }
  if (node.k === 'neg') varsOf(node.e, out);
  return out;
}

// Static typing: direction vs asset class, price mode vs asset class,
// constant-positive price, variable scoping in fee expressions.
export function checkEvent(ast) {
  if (ast.kind === 'deposit') {
    const cls = assetClass(ast.isin);
    if (!cls) throw new DslError(E_SIGN, `unknown asset class for ISIN ${ast.isin}`);
    return { cls };
  }
  if (ast.kind === 'cancel') return { cls: null };

  const cls = assetClass(ast.isin);
  if (!cls) {
    throw new DslError(E_SIGN, `unknown asset class for ISIN ${ast.isin}`);
  }
  if (cls === 'equity' && ast.priceMode !== 'gross') {
    throw new DslError(E_SIGN, `equity ${ast.isin} must be priced gross, got net`);
  }
  if (cls === 'bond' && ast.priceMode !== 'net') {
    throw new DslError(E_SIGN, `bond ${ast.isin} must be priced net, got gross`);
  }
  if (cls === 'equity' && ast.accrued !== 0n) {
    throw new DslError(E_SIGN, 'accrued interest only applies to bonds');
  }

  const priceVars = varsOf(ast.priceExpr);
  if (priceVars.size > 0) {
    throw new DslError(E_SIGN, 'price expression must be constant');
  }
  const price = evalAst(ast.priceExpr, {});
  if (price <= 0n) {
    throw new DslError(E_SIGN, `price must be positive, got ${price}`);
  }

  for (const v of varsOf(ast.feeExpr)) {
    if (v === 'accrued' && cls !== 'bond') {
      throw new DslError(E_SIGN, "'accrued' is only valid for bond fees");
    }
  }
  return { cls };
}
