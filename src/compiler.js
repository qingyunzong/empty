import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { typeCheckContract, typeOf } from './typecheck.js';

// Bytecode ops (stack machine):
//   CONST_BPS|CONST_MONEY|CONST_UNITS value  -- push typed literal
//   LOAD_PARAM name                          -- push order override or evaluated default
//   ADD                                      -- pop b,a push a+b (same type)
//   MIN | MAX                                -- pop bound,expr push min/max (money)
//   APPLY                                    -- pop bps rate, push exact money = orderAmount * rate / 10000
//   PUSH_ORDER                               -- push order amount (money)
//   CMP_GE|CMP_LE|CMP_LT                     -- pop b,a push bool
//   JMP_IF_FALSE addr                        -- pop bool, jump if false
//   MATCH tierIndex                          -- record tier hit
//   REQUIRE_MATCH                            -- raise E_TIER if no tier matched
//   SELECT_MIN                               -- evaluate matched tier fee programs, keep cheapest, record ties
//   ROUND mode                               -- pop money, push rounded-to-cents money, record remainder
//   CONSERVE                                 -- pop total, verify conservation, record residual
//   HALT

function compileExpr(expr, out, scope) {
  switch (expr.kind) {
    case 'literal': {
      const op = { bps: 'CONST_BPS', money: 'CONST_MONEY', units: 'CONST_UNITS' }[expr.unit];
      out.push({ op, value: expr.value, ...(expr.currency ? { currency: expr.currency } : {}) });
      return;
    }
    case 'ref':
      out.push({ op: 'LOAD_PARAM', name: expr.name });
      return;
    case 'add':
      compileExpr(expr.left, out, scope);
      compileExpr(expr.right, out, scope);
      out.push({ op: 'ADD' });
      return;
    case 'min':
    case 'max': {
      compileExpr(expr.expr, out, scope);
      if (typeOf(expr.expr, scope) === 'bps') out.push({ op: 'APPLY' });
      compileExpr(expr.bound, out, scope);
      out.push({ op: expr.kind.toUpperCase() });
      return;
    }
    default:
      throw new Error(`cannot compile expression kind '${expr.kind}'`);
  }
}

function compileFeeExpr(expr, exprType, out, scope) {
  compileExpr(expr, out, scope);
  if (exprType === 'bps') out.push({ op: 'APPLY' });
}

export function compile(contract) {
  const { scope, feeType, currency } = typeCheckContract(contract);

  const paramPrograms = {};
  for (const d of contract.defaults) {
    const code = [];
    compileExpr(d.value, code, scope);
    paramPrograms[d.key] = code;
  }

  const main = [];
  const tierPrograms = [];
  const hasTiers = contract.fee.kind === 'tierList';

  if (hasTiers) {
    contract.fee.tiers.forEach((tier, i) => {
      const feeCode = [];
      compileFeeExpr(tier.fee, typeOf(tier.fee, scope), feeCode, scope);
      tierPrograms.push({ fee: feeCode, line: tier.line });

      main.push({ op: 'PUSH_ORDER' });
      compileExpr(tier.from, main, scope);
      main.push({ op: 'CMP_GE' });
      const skipFrom = main.length;
      main.push({ op: 'JMP_IF_FALSE', addr: null });
      let skipTo = null;
      if (tier.to) {
        main.push({ op: 'PUSH_ORDER' });
        compileExpr(tier.to, main, scope);
        main.push({ op: tier.toInclusive ? 'CMP_LE' : 'CMP_LT' });
        skipTo = main.length;
        main.push({ op: 'JMP_IF_FALSE', addr: null });
      }
      main.push({ op: 'MATCH', tier: i });
      const next = main.length;
      main[skipFrom].addr = next;
      if (skipTo !== null) main[skipTo].addr = next;
    });
    main.push({ op: 'REQUIRE_MATCH' });
    main.push({ op: 'SELECT_MIN' });
  } else {
    compileFeeExpr(contract.fee, feeType, main, scope);
  }
  main.push({ op: 'ROUND', mode: contract.rounding ?? 'HALF_UP' });
  main.push({ op: 'CONSERVE' });
  main.push({ op: 'HALT' });

  return {
    name: contract.name,
    currency,
    rounding: contract.rounding ?? 'HALF_UP',
    residualAccount: contract.residual,
    paramPrograms,
    paramTypes: Object.fromEntries(scope),
    tierPrograms,
    main,
    hasTiers,
  };
}

export function compileSource(source) {
  return compile(parse(tokenize(source)));
}
