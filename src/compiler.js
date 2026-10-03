const BINOP = { PLUS: 'ADD', MINUS: 'SUB', STAR: 'MUL', SLASH: 'DIV' };

function compileExpr(node, out) {
  if (node.type === 'num') { out.push({ op: 'PUSH', value: node.value }); return; }
  if (node.type === 'neg') { compileExpr(node.arg, out); out.push({ op: 'NEG' }); return; }
  compileExpr(node.left, out);
  compileExpr(node.right, out);
  out.push({ op: BINOP[node.op] });
}

// Compile a checked statement into a flat bytecode program.
// Trade-like statements leave [price, fee] on the stack for NEW_TRADE/AMEND.
export function compile(stmt) {
  const out = [];
  if (stmt.kind === 'revoke') {
    out.push({ op: 'REVOKE', id: stmt.id, version: stmt.version, date: stmt.date });
    return out;
  }
  compileExpr(stmt.priceExpr, out);
  if (stmt.feeExpr) compileExpr(stmt.feeExpr, out);
  else out.push({ op: 'PUSH', value: 0 });
  out.push({
    op: stmt.kind === 'trade' ? 'NEW_TRADE' : 'AMEND',
    id: stmt.id, version: stmt.version, date: stmt.date,
    side: stmt.side, qty: stmt.qty, isin: stmt.isin, priceKind: stmt.priceKind,
  });
  return out;
}
