// Independent decision-tree reference implementation used to cross-check the
// bytecode VM. It interprets the checked AST directly (no bytecode involved).
import { parse } from '../../src/parser.js';
import { checkProgram } from '../../src/checker.js';
import { normalizeEvent, DECISION_RANK } from '../../src/engine.js';
import { cidrContains } from '../../src/ip.js';
import { RiskError } from '../../src/errors.js';

function evalExpr(node, event) {
  switch (node.kind) {
    case 'const':
      return node.value;
    case 'str':
    case 'boollit':
      return node.value;
    case 'regex':
      return node.source;
    case 'field':
      return event[node.name];
    case 'not':
      return !evalExpr(node.e, event);
    case 'bin': {
      if (node.op === 'and') return evalExpr(node.l, event) && evalExpr(node.r, event);
      if (node.op === 'or') return evalExpr(node.l, event) || evalExpr(node.r, event);
      const a = evalExpr(node.l, event);
      const b = evalExpr(node.r, event);
      switch (node.op) {
        case '>': return a > b;
        case '>=': return a >= b;
        case '<': return a < b;
        case '<=': return a <= b;
        case '==': return a === b;
        case '!=': return a !== b;
        default: throw new Error(`reference: bad op ${node.op}`);
      }
    }
    case 'in': {
      const l = evalExpr(node.l, event);
      if (node.inKind === 'cidr') return cidrContains(evalExpr(node.r, event), l);
      if (node.inKind === 'range') {
        const [lo, hi] = evalExpr(node.r, event);
        return l >= lo && l <= hi;
      }
      return new RegExp(evalExpr(node.r, event)).test(l);
    }
    default:
      throw new Error(`reference: unknown node kind ${node.kind}`);
  }
}

function scopeMatches(scope, event) {
  for (let s = scope; s && s.kind !== 'root'; s = s.parent) {
    if (s.kind === 'channel' && event.channel !== s.arg) return false;
    if (s.kind === 'merchant' && event.merchant !== s.arg) return false;
  }
  return true;
}

function pathOf(scope) {
  const parts = [];
  for (let s = scope; s && s.kind !== 'root'; s = s.parent) {
    parts.unshift(s.kind === 'global' ? 'global' : `${s.kind}("${s.arg}")`);
  }
  return parts.join('/');
}

export function evaluateReference(source, rawEvent) {
  const checked = checkProgram(parse(source));
  const event = normalizeEvent(rawEvent);
  let version = null;
  for (const v of checked.versions) {
    if (v.sinceMs <= event.timeMs && (!version || v.sinceMs > version.sinceMs)) version = v;
  }
  if (!version) {
    throw new RiskError('E_VERSION', `no rule version covers event time ${new Date(event.timeMs).toISOString()}`);
  }
  const hits = [];
  const walk = (scope) => {
    if (scopeMatches(scope, event)) {
      const path = pathOf(scope);
      for (const rule of scope.rules) {
        if (evalExpr(rule.expr, event)) {
          hits.push({ rule: rule.id, path, decision: rule.decision });
        }
      }
    }
    for (const child of scope.children) walk(child);
  };
  walk(version.root);
  const key = (h) => `${h.path}/${h.rule}`;
  hits.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  let decision = 'ALLOW';
  let strictest = [];
  if (hits.length > 0) {
    const top = Math.max(...hits.map((h) => DECISION_RANK[h.decision]));
    strictest = hits.filter((h) => DECISION_RANK[h.decision] === top);
    decision = strictest[0].decision.toUpperCase();
  }
  return { decision, version: version.id, hits, strictest };
}
