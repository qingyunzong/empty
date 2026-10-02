import { DslError } from './errors.js';
import { lex } from './lexer.js';

// Pratt parser. Precedence (low -> high): or < and < ==/!= < not < primary.
const INFIX = {
  or: [10, 'or'],
  and: [20, 'and'],
  '==': [30, 'eq'],
  '!=': [30, 'ne'],
};
const NOT_PREC = 70;

export function parse(source, file = '<input>') {
  const tokens = lex(source, file);
  let pos = 0;

  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];
  const fail = (msg, tok = peek()) => {
    throw new DslError(msg, tok.line, tok.col, file);
  };
  const isSym = (t, v) => t.type === 'sym' && t.value === v;
  const isKw = (t, kw) => t.type === 'ident' && t.value === kw;
  const expectSym = (v) => {
    const t = peek();
    if (!isSym(t, v)) fail(`expected '${v}' but found '${t.value}'`);
    return advance();
  };
  const expectIdent = (what = 'identifier') => {
    const t = peek();
    if (t.type !== 'ident') fail(`expected ${what} but found '${t.value}'`);
    return advance();
  };
  const eatKw = (kw) => {
    const t = peek();
    if (!isKw(t, kw)) fail(`expected '${kw}' but found '${t.value}'`);
    return advance();
  };

  function parseExpr(minPrec = 0) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      let op = null;
      if (t.type === 'ident' && INFIX[t.value]) op = INFIX[t.value];
      else if (t.type === 'sym' && INFIX[t.value]) op = INFIX[t.value];
      if (!op || op[0] < minPrec) return left;
      advance();
      const right = parseExpr(op[0] + 1);
      left = { type: op[1], left, right, line: t.line, col: t.col };
    }
  }

  function parsePrefix() {
    const t = peek();
    if (isKw(t, 'not')) {
      advance();
      return { type: 'not', expr: parseExpr(NOT_PREC), line: t.line, col: t.col };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'ident') {
      if (t.value === 'true' || t.value === 'false') {
        advance();
        return { type: 'bool', value: t.value === 'true', line: t.line, col: t.col };
      }
      advance();
      if (isSym(peek(), '.')) {
        advance();
        const member = expectIdent('enum member');
        return { type: 'enumref', enumName: t.value, member: member.value, line: t.line, col: t.col };
      }
      return { type: 'ident', name: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'ms') {
      advance();
      return { type: 'ms', value: t.value, line: t.line, col: t.col };
    }
    if (isSym(t, '(')) {
      advance();
      const e = parseExpr(0);
      expectSym(')');
      return e;
    }
    fail(`expected expression but found '${t.value}'`, t);
    return null;
  }

  function parseBoolType() {
    const t = expectIdent('type');
    if (t.value !== 'bool') fail(`expected type 'bool' but found '${t.value}'`, t);
  }

  function parseInput() {
    const kw = eatKw('input');
    const name = expectIdent('input name');
    expectSym(':');
    parseBoolType();
    expectSym(';');
    return { name: name.value, line: kw.line, col: kw.col };
  }

  function parseOutput() {
    const kw = eatKw('output');
    const name = expectIdent('output name');
    expectSym(':');
    parseBoolType();
    let init = false;
    if (isSym(peek(), '=')) {
      advance();
      const v = expectIdent("'true' or 'false'");
      if (v.value !== 'true' && v.value !== 'false') {
        fail(`expected 'true' or 'false' but found '${v.value}'`, v);
      }
      init = v.value === 'true';
    }
    expectSym(';');
    return { name: name.value, init, line: kw.line, col: kw.col };
  }

  function parseTimer() {
    const kw = eatKw('timer');
    const name = expectIdent('timer name');
    expectSym(':');
    const d = peek();
    if (d.type !== 'ms') fail(`expected millisecond duration (e.g. 250ms) but found '${d.value}'`);
    advance();
    expectSym(';');
    return { name: name.value, ms: d.value, line: kw.line, col: kw.col };
  }

  function parseEnum() {
    const kw = eatKw('enum');
    const name = expectIdent('enum name');
    expectSym('{');
    const members = [];
    for (;;) {
      const m = expectIdent('enum member');
      members.push({ name: m.value, line: m.line, col: m.col });
      if (isSym(peek(), ',')) {
        advance();
        continue;
      }
      break;
    }
    expectSym('}');
    return { name: name.value, members, line: kw.line, col: kw.col };
  }

  function parseVar() {
    const kw = eatKw('var');
    const name = expectIdent('var name');
    expectSym(':');
    const ty = expectIdent('type');
    let init = null;
    if (isSym(peek(), '=')) {
      advance();
      init = parseExpr(0);
    }
    expectSym(';');
    return {
      name: name.value,
      typeName: ty.value,
      typeLine: ty.line,
      typeCol: ty.col,
      init,
      line: kw.line,
      col: kw.col,
    };
  }

  function parseInvariant() {
    const kw = eatKw('invariant');
    const expr = parseExpr(0);
    expectSym(';');
    return { expr, line: kw.line, col: kw.col };
  }

  function parseAction() {
    const t = peek();
    if (isKw(t, 'set')) {
      advance();
      const name = expectIdent('signal name');
      expectSym('=');
      const expr = parseExpr(0);
      expectSym(';');
      return { kind: 'set', name: name.value, expr, line: t.line, col: t.col };
    }
    if (isKw(t, 'start') || isKw(t, 'stop')) {
      advance();
      const name = expectIdent('timer name');
      expectSym(';');
      return { kind: t.value, name: name.value, line: t.line, col: t.col };
    }
    fail(`expected action ('set', 'start' or 'stop') but found '${t.value}'`);
    return null;
  }

  function parseEnter() {
    expectSym('{');
    const actions = [];
    while (!isSym(peek(), '}')) actions.push(parseAction());
    expectSym('}');
    return actions;
  }

  function parseOn() {
    const kw = eatKw('on');
    const event = expectIdent('event name');
    let guard = null;
    if (isKw(peek(), 'when')) {
      advance();
      guard = parseExpr(0);
    }
    expectSym('->');
    const target = expectIdent('target state');
    expectSym(';');
    return {
      event: event.value,
      guard,
      target: target.value,
      targetLine: target.line,
      targetCol: target.col,
      line: kw.line,
      col: kw.col,
    };
  }

  function parseWhen() {
    const kw = eatKw('when');
    const guard = parseExpr(0);
    expectSym('->');
    const target = expectIdent('target state');
    expectSym(';');
    return {
      event: null,
      guard,
      target: target.value,
      targetLine: target.line,
      targetCol: target.col,
      line: kw.line,
      col: kw.col,
    };
  }

  function parseState() {
    const kw = eatKw('state');
    const name = expectIdent('state name');
    expectSym('{');
    const st = { name: name.value, line: kw.line, col: kw.col, enter: [], transitions: [] };
    while (!isSym(peek(), '}')) {
      const t = peek();
      if (isKw(t, 'enter')) {
        advance();
        st.enter.push(...parseEnter());
      } else if (isKw(t, 'on')) {
        st.transitions.push(parseOn());
      } else if (isKw(t, 'when')) {
        st.transitions.push(parseWhen());
      } else {
        fail(`expected 'enter', 'on' or 'when' but found '${t.value}'`);
      }
    }
    expectSym('}');
    return st;
  }

  function parseDevice() {
    const kw = eatKw('device');
    const name = expectIdent('device name');
    expectSym('{');
    const dev = {
      name: name.value,
      line: kw.line,
      col: kw.col,
      inputs: [],
      outputs: [],
      timers: [],
      enums: [],
      vars: [],
      invariants: [],
      states: [],
    };
    while (!isSym(peek(), '}')) {
      const t = peek();
      if (t.type !== 'ident') fail(`expected device member but found '${t.value}'`);
      switch (t.value) {
        case 'input':
          dev.inputs.push(parseInput());
          break;
        case 'output':
          dev.outputs.push(parseOutput());
          break;
        case 'timer':
          dev.timers.push(parseTimer());
          break;
        case 'enum':
          dev.enums.push(parseEnum());
          break;
        case 'var':
          dev.vars.push(parseVar());
          break;
        case 'invariant':
          dev.invariants.push(parseInvariant());
          break;
        case 'state':
          dev.states.push(parseState());
          break;
        default:
          fail(`unexpected device member '${t.value}'`);
      }
    }
    expectSym('}');
    return dev;
  }

  const devices = [];
  while (peek().type !== 'eof') devices.push(parseDevice());
  return { devices };
}
