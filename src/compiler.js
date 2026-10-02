import { E } from './errors.js';
import { typecheckExpr } from './typecheck.js';

export const LEVEL_ORDER = { global: 0, channel: 1, merchant: 2 };

const CMP_OP = { '>': 'GT', '>=': 'GE', '<': 'LT', '<=': 'LE', '==': 'EQ', '!=': 'NE' };

export function compileRuleset(ast) {
  for (const rule of ast.rules)
    for (const stmt of rule.statements) typecheckExpr(stmt.expr);
  const overrideLog = checkOverrides(ast);
  const consts = [];
  const rules = ast.rules.map((rule) => ({
    name: rule.name,
    level: rule.level,
    match: rule.match,
    statements: rule.statements.map((stmt, index) => ({
      decision: stmt.decision,
      override: stmt.override,
      index,
      expr: stmt.expr,
      program: compileExpr(stmt.expr, consts),
    })),
  }));
  return { version: ast.version, validFrom: ast.validFrom, rules, consts, overrideLog };
}

function compileExpr(node, consts) {
  const code = [];
  emit(node, code, consts);
  return code;
}

function emit(node, code, consts) {
  switch (node.kind) {
    case 'and':
      emit(node.left, code, consts);
      emit(node.right, code, consts);
      code.push(['AND']);
      return;
    case 'or':
      emit(node.left, code, consts);
      emit(node.right, code, consts);
      code.push(['OR']);
      return;
    case 'not':
      emit(node.expr, code, consts);
      code.push(['NOT']);
      return;
    case 'cmp':
      code.push(['LOAD', node.field]);
      consts.push(node.value);
      code.push(['PUSH', consts.length - 1]);
      code.push([CMP_OP[node.op]]);
      return;
    case 'inCidr':
      code.push(['LOAD', node.field]);
      consts.push(node.cidr);
      code.push(['IN_CIDR', consts.length - 1]);
      return;
    case 'inRange':
      code.push(['LOAD', node.field]);
      consts.push({ lo: node.lo, hi: node.hi });
      code.push(['IN_RANGE', consts.length - 1]);
      return;
    case 'inList':
      code.push(['LOAD', node.field]);
      consts.push(node.items);
      code.push(['IN_LIST', consts.length - 1]);
      return;
    case 'matchRegex':
      code.push(['LOAD', node.field]);
      consts.push(new RegExp(`^(?:${node.regex})$`));
      code.push(['MATCH_RE', consts.length - 1]);
      return;
    default:
      throw E('E_TYPE', `cannot compile node '${node.kind}'`);
  }
}

// Lexical scoping: an inner level (channel < merchant, global < anything) may
// tighten an outer threshold freely, but loosening it requires an explicit
// `override` keyword, which is recorded in the override log (留痕).
function checkOverrides(ast) {
  const facts = [];
  for (const rule of ast.rules) {
    rule.statements.forEach((stmt, index) => {
      const e = stmt.expr;
      if (e.kind === 'cmp'
        && (e.value.kind === 'moneyLit' || e.value.kind === 'countLit')
        && (e.op === '>' || e.op === '>=' || e.op === '<' || e.op === '<=')) {
        facts.push({
          rule: rule.name, level: rule.level, index,
          decision: stmt.decision, field: e.field, op: e.op,
          value: e.value, override: stmt.override,
        });
      }
    });
  }
  const log = [];
  for (const inner of facts) {
    if (inner.level === 'global') continue;
    for (const outer of facts) {
      if (LEVEL_ORDER[outer.level] >= LEVEL_ORDER[inner.level]) continue;
      if (outer.decision !== inner.decision || outer.field !== inner.field) continue;
      if (!sameUnit(outer.value, inner.value)) continue;
      if (!isLooser(inner, outer)) continue;
      const msg = `rule '${inner.rule}' loosens ${inner.decision} threshold on ` +
        `${inner.field} from ${fmt(outer)} (rule '${outer.rule}') to ${fmt(inner)}`;
      if (!inner.override) throw E('E_OVERRIDE', `${msg}; add explicit 'override'`);
      log.push({
        rule: inner.rule, statement: inner.index, decision: inner.decision,
        field: inner.field, outerRule: outer.rule, outer: fmt(outer), inner: fmt(inner),
      });
    }
  }
  return log;
}

function sameUnit(a, b) {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'moneyLit') return a.currency === b.currency;
  return true;
}

const numOf = (v) => (v.kind === 'moneyLit' ? v.amount : v.value);

// A restrictive decision (deny/review) is loosened when its trigger set
// shrinks (fewer events caught); `allow` is loosened when its trigger set
// grows (more events waved through).
function isLooser(inner, outer) {
  const dir = (op) => (op === '>' || op === '>=' ? 'low' : 'high');
  if (dir(inner.op) !== dir(outer.op)) return false;
  const iv = numOf(inner.value);
  const ov = numOf(outer.value);
  const iIncl = inner.op.endsWith('=');
  const oIncl = outer.op.endsWith('=');
  let grows;
  let shrinks;
  if (dir(inner.op) === 'low') {
    grows = iv < ov || (iv === ov && iIncl && !oIncl);
    shrinks = iv > ov || (iv === ov && !iIncl && oIncl);
  } else {
    grows = iv > ov || (iv === ov && iIncl && !oIncl);
    shrinks = iv < ov || (iv === ov && !iIncl && oIncl);
  }
  return inner.decision === 'allow' ? grows : shrinks;
}

function fmt(f) {
  const v = f.value.kind === 'moneyLit' ? `${f.value.amount}${f.value.currency}` : `${f.value.value}`;
  return `${f.op} ${v}`;
}
