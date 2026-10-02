// Independent reference evaluator ("decision tree"): walks the parsed AST
// directly with its own CIDR/bit logic. Used to cross-check the bytecode VM.
import { FIELD_TYPES } from '../src/parser.js';

function ipToBits(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = '';
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out += n.toString(2).padStart(8, '0');
  }
  return out;
}

function cidrMatch(cidr, ip) {
  const addr = ipToBits(ip);
  if (addr === null) return false;
  const base = cidr.base.toString(2).padStart(32, '0');
  return addr.slice(0, cidr.bits) === base.slice(0, cidr.bits);
}

function currencyOk(lit, event) {
  return !lit.currency || !event.currency || event.currency === lit.currency;
}

function cmpOp(op, a, b) {
  switch (op) {
    case '>': return a > b;
    case '>=': return a >= b;
    case '<': return a < b;
    case '<=': return a <= b;
    case '==': return a === b;
    case '!=': return a !== b;
    default: throw new Error(`ref: bad op ${op}`);
  }
}

export function evalNode(node, event) {
  switch (node.kind) {
    case 'and': return evalNode(node.left, event) && evalNode(node.right, event);
    case 'or': return evalNode(node.left, event) || evalNode(node.right, event);
    case 'not': return !evalNode(node.expr, event);
    case 'cmp': {
      const v = event[node.field];
      const lit = node.value;
      if (lit.kind === 'moneyLit') {
        if (typeof v !== 'number' || !currencyOk(lit, event)) return false;
        return cmpOp(node.op, v, lit.amount);
      }
      if (lit.kind === 'countLit') return typeof v === 'number' && cmpOp(node.op, v, lit.value);
      if (lit.kind === 'stringLit') return typeof v === 'string' && cmpOp(node.op, v, lit.value);
      return false;
    }
    case 'inCidr': return cidrMatch(node.cidr, event[node.field]);
    case 'inRange': {
      const v = event[node.field];
      if (typeof v !== 'number') return false;
      if (node.lo.kind === 'moneyLit') {
        if (!currencyOk(node.lo, event)) return false;
        return v >= node.lo.amount && v <= node.hi.amount;
      }
      return v >= node.lo.value && v <= node.hi.value;
    }
    case 'inList': {
      const v = event[node.field];
      return typeof v === 'string' && node.items.includes(v);
    }
    case 'matchRegex': {
      const v = event[node.field];
      return typeof v === 'string' && new RegExp(`^(?:${node.regex})$`).test(v);
    }
    default: throw new Error(`ref: cannot evaluate node '${node.kind}'`);
  }
}

const RANK = { allow: 0, review: 1, deny: 2 };
const LRANK = { global: 0, channel: 1, merchant: 2 };
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function referenceDecide(ast, event) {
  const hits = [];
  for (const rule of ast.rules) {
    if (rule.match) {
      const actual = rule.match.field === 'channel' ? event.channel : event.merchant;
      if (actual !== rule.match.value) continue;
    }
    rule.statements.forEach((stmt, index) => {
      if (evalNode(stmt.expr, event)) {
        hits.push({ rule: rule.name, level: rule.level, statement: index, decision: stmt.decision });
      }
    });
  }
  let decision = 'allow';
  for (const h of hits) if (RANK[h.decision] > RANK[decision]) decision = h.decision;
  const matched = hits
    .filter((h) => h.decision === decision)
    .sort((a, b) => LRANK[a.level] - LRANK[b.level] || cmpStr(a.rule, b.rule) || a.statement - b.statement);
  const outcome = decision === 'review'
    ? (event.review === 'approved' ? 'allow' : event.review === 'rejected' ? 'deny' : 'review')
    : decision;
  return { decision, outcome, matched };
}

export { FIELD_TYPES };
