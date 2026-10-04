'use strict';

const OP = {
  PUSH: 0, LOADG: 1, LOADL: 2, STOREG: 3, STOREL: 4,
  ADD: 5, SUB: 6, MUL: 7, NEG: 8, NOT: 9,
  AND: 10, OR: 11,
  EQ: 12, NE: 13, LT: 14, LE: 15, GT: 16, GE: 17,
  JMP: 18, JF: 19, CALL: 20, RET: 21, ROUND: 22,
};
const OPNAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));

const RATE_SCALE = 1000000n;

function moneyToCents(text) {
  const neg = text.startsWith('-');
  const body = neg ? text.slice(1) : text;
  const [intPart, fracPart = ''] = body.split('.');
  const cents = BigInt(intPart) * 100n + BigInt((fracPart + '00').slice(0, 2));
  return neg ? -cents : cents;
}

function rateToScaled(text) {
  const [intPart, fracPart = ''] = text.split('.');
  return BigInt(intPart) * RATE_SCALE + BigInt((fracPart + '000000').slice(0, 6));
}

function dateToDays(text) {
  const [y, m, d] = text.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

const CMP_OP = { '==': OP.EQ, '!=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE };

function compileExpr(node, code) {
  switch (node.kind) {
    case 'money':
      code.push([OP.PUSH, ['money', moneyToCents(node.text).toString()]]);
      break;
    case 'rate':
      code.push([OP.PUSH, ['rate', rateToScaled(node.text).toString()]]);
      break;
    case 'date':
      code.push([OP.PUSH, ['date', String(dateToDays(node.text))]]);
      break;
    case 'bool':
      code.push([OP.PUSH, ['bool', node.value ? '1' : '0']]);
      break;
    case 'name':
      if (node.resolved.space === 'g') code.push([OP.LOADG, node.resolved.slot]);
      else code.push([OP.LOADL, node.resolved.slot]);
      break;
    case 'unary':
      compileExpr(node.expr, code);
      code.push([node.op === 'not' ? OP.NOT : OP.NEG]);
      break;
    case 'binary':
      if (node.op === 'and' || node.op === 'or') {
        compileExpr(node.l, code);
        compileExpr(node.r, code);
        code.push([node.op === 'and' ? OP.AND : OP.OR]);
      } else if (node.op === '+') {
        compileExpr(node.l, code);
        compileExpr(node.r, code);
        code.push([OP.ADD]);
      } else if (node.op === '-') {
        compileExpr(node.l, code);
        compileExpr(node.r, code);
        code.push([OP.SUB]);
      } else if (node.op === '*') {
        compileExpr(node.l, code);
        compileExpr(node.r, code);
        code.push([OP.MUL]);
      } else {
        compileExpr(node.l, code);
        compileExpr(node.r, code);
        code.push([CMP_OP[node.op]]);
      }
      break;
    case 'if': {
      compileExpr(node.cond, code);
      const jfAt = code.length;
      code.push([OP.JF, 0]);
      compileExpr(node.then, code);
      const jmpAt = code.length;
      code.push([OP.JMP, 0]);
      code[jfAt][1] = code.length;
      compileExpr(node.else, code);
      code[jmpAt][1] = code.length;
      break;
    }
    case 'call':
      if (node.name === 'round') {
        compileExpr(node.args[0], code);
        code.push([OP.ROUND]);
      } else {
        node.args.forEach((a) => compileExpr(a, code));
        code.push([OP.CALL, node.ruleIdx]);
      }
      break;
    default:
      throw new Error(`compiler: unknown node kind '${node.kind}'`);
  }
}

function compile(prog) {
  const init = [];
  prog.lets.forEach((l, i) => {
    compileExpr(l.expr, init);
    init.push([OP.STOREG, i]);
  });
  init.push([OP.PUSH, ['bool', '1']]);
  init.push([OP.RET]);
  const rules = prog.rules.map((r) => {
    const code = [];
    r.lets.forEach((l, i) => {
      compileExpr(l.expr, code);
      code.push([OP.STOREL, r.params.length + i]);
    });
    compileExpr(r.ret, code);
    code.push([OP.RET]);
    return {
      name: r.name,
      arity: r.params.length,
      nslots: r.params.length + r.lets.length,
      code,
    };
  });
  return { globals: prog.lets.length, init, rules };
}

module.exports = { compile, OP, OPNAME, RATE_SCALE, moneyToCents, dateToDays };
