import { createHash } from 'node:crypto';
import { compileExpr } from './expr.js';
import { checkEvent } from './check.js';

function canonical(ast) {
  const base = [ast.kind, ast.id ?? '', ast.version ?? '', ast.date ?? '',
    ast.dir ?? '', String(ast.qty ?? ''), ast.isin ?? '', ast.priceMode ?? '',
    String(ast.accrued ?? ''), String(ast.cash ?? '')];
  const ser = (n) => (n === null || n === undefined ? '' : JSON.stringify(n, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return `${base.join('|')}|${ser(ast.priceExpr)}|${ser(ast.feeExpr)}`;
}

export function contentHash(ast) {
  return createHash('sha256').update(canonical(ast)).digest('hex');
}

// AST -> bytecode program. Expressions become stack code; the event itself
// becomes a single VM instruction carrying its operand programs.
export function compileEvent(ast) {
  const { cls } = checkEvent(ast);
  const hash = contentHash(ast);
  switch (ast.kind) {
    case 'trade':
    case 'amend':
      return {
        op: ast.kind === 'trade' ? 'NEW_TRADE' : 'NEW_VERSION',
        id: ast.id, version: ast.version, date: ast.date, dir: ast.dir,
        qty: ast.qty, isin: ast.isin, cls, priceMode: ast.priceMode,
        accrued: ast.accrued,
        priceCode: compileExpr(ast.priceExpr),
        feeCode: ast.feeExpr ? compileExpr(ast.feeExpr) : null,
        hash, src: ast.src, line: ast.line,
      };
    case 'cancel':
      return { op: 'TOMBSTONE', id: ast.id, version: ast.version, date: ast.date,
        hash, src: ast.src, line: ast.line };
    case 'deposit':
      return { op: 'DEPOSIT', date: ast.date, isin: ast.isin, cls,
        qty: ast.qty, cash: ast.cash, hash, src: ast.src, line: ast.line };
    default:
      throw new Error(`cannot compile kind ${ast.kind}`);
  }
}
