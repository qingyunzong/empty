import { typeError } from './errors.js';

// Static types: 'bps' | 'money' | 'units'
// Rules:
//  - literals carry their unit type
//  - refs resolve against the defaults scope
//  - min/max require money operand and money bound, yield money
//  - add requires identical types on both sides (bps + money is rejected)
//  - tier bounds must be money; tier fee must be money (flat) or bps (rate)
export function typeOf(expr, scope) {
  switch (expr.kind) {
    case 'literal':
      return expr.unit;
    case 'ref': {
      const t = scope.get(expr.name);
      if (!t) throw typeError(`unknown parameter '${expr.name}' at line ${expr.line}`);
      return t;
    }
    case 'min':
    case 'max': {
      const t = typeOf(expr.expr, scope);
      const bt = typeOf(expr.bound, scope);
      if (t !== 'money' && t !== 'bps') {
        throw typeError(`${expr.kind} operand at line ${expr.line} must be money or bps, got ${t}`);
      }
      if (bt !== 'money') throw typeError(`${expr.kind} bound at line ${expr.line} must be money, got ${bt}`);
      return 'money';
    }
    case 'add': {
      const l = typeOf(expr.left, scope);
      const r = typeOf(expr.right, scope);
      if (l !== r) {
        throw typeError(`cannot add ${l} and ${r} at line ${expr.line}: mixing units is forbidden`);
      }
      return l;
    }
    case 'tierList':
      for (const tier of expr.tiers) typeCheckTier(tier, scope);
      return 'money';
    default:
      throw typeError(`unknown expression kind '${expr.kind}'`);
  }
}

function typeCheckTier(tier, scope) {
  for (const [label, bound] of [['lower', tier.from], ['upper', tier.to]]) {
    if (!bound) continue;
    const t = typeOf(bound, scope);
    if (t !== 'money') throw typeError(`tier ${label} bound at line ${bound.line} must be money, got ${t}`);
  }
  const ft = typeOf(tier.fee, scope);
  if (ft !== 'money' && ft !== 'bps') {
    throw typeError(`tier fee at line ${tier.line} must be money or bps, got ${ft}`);
  }
}

export function typeCheckContract(contract) {
  const scope = new Map();
  for (const d of contract.defaults) {
    if (scope.has(d.key)) throw typeError(`duplicate default parameter '${d.key}' at line ${d.line}`);
    scope.set(d.key, typeOf(d.value, scope));
  }
  const feeType = typeOf(contract.fee, scope);
  if (feeType !== 'money' && feeType !== 'bps') {
    throw typeError(`contract fee must be money or bps, got ${feeType}`);
  }
  // currency consistency across money literals
  const currencies = new Set();
  const walk = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.kind === 'literal' && e.unit === 'money') currencies.add(e.currency);
    for (const k of ['expr', 'bound', 'left', 'right', 'from', 'to', 'fee', 'value']) walk(e[k]);
    if (Array.isArray(e.tiers)) e.tiers.forEach(walk);
  };
  contract.defaults.forEach((d) => walk(d.value));
  walk(contract.fee);
  if (currencies.size > 1) throw typeError(`mixed currencies in contract: ${[...currencies].join(', ')}`);
  return { scope, feeType, currency: [...currencies][0] ?? null };
}
