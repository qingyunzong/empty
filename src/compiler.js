// Compiler: turns lexed correction scripts into bytecode.
// Supported directives inside #!correction ... #!end blocks:
//   map <field> = <expr>
//   clamp <field> <min> <max>
//   filter <expr>
//   if <expr> then <field> = <expr>
// Expressions: numbers, "strings", field identifiers, + - * /,
// comparisons > < >= <= == !=, parentheses, unary minus.

import { lex } from './lexer.js';

export function compile(source) {
  const tokens = lex(source);
  const code = [];
  const csvRows = [];
  const dropPatches = [];
  const endPatches = [];
  for (const token of tokens) {
    if (token.type === 'DIRECTIVE_BEGIN' || token.type === 'DIRECTIVE_END') continue;
    if (token.type === 'CSV') {
      csvRows.push({ line: token.line, fields: token.fields });
      continue;
    }
    compileStatement(token, code, dropPatches, endPatches);
  }
  code.push({ op: 'HALT' });
  for (const index of endPatches) code[index].target = code.length - 1;
  if (dropPatches.length > 0) {
    const dropTarget = code.length;
    code.push({ op: 'DROP' });
    for (const index of dropPatches) code[index].target = dropTarget;
  }
  return { code, csvRows };
}

function compileStatement(stmt, code, dropPatches, endPatches) {
  const tokens = stmt.tokens;
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (message) => { throw new SyntaxError(`${message} at line ${stmt.line}`); };
  const expectIdent = () => {
    const token = next();
    if (!token || token.type !== 'ident') fail('expected identifier');
    return token.value;
  };
  const expectOp = (value) => {
    const token = next();
    if (!token || token.type !== 'op' || token.value !== value) fail(`expected "${value}"`);
  };
  const expectNumber = () => {
    const token = next();
    if (!token || token.type !== 'number') fail('expected number');
    return token.value;
  };

  const head = next();
  if (!head || head.type !== 'ident') fail('expected directive keyword');
  switch (head.value) {
    case 'map': {
      const field = expectIdent();
      expectOp('=');
      pos = parseExpr(tokens, pos, code, stmt.line);
      code.push({ op: 'STORE', field });
      break;
    }
    case 'clamp': {
      const field = expectIdent();
      const min = expectNumber();
      const max = expectNumber();
      if (min > max) fail('clamp min greater than max');
      code.push({ op: 'CLAMP', field, min, max });
      break;
    }
    case 'filter': {
      pos = parseExpr(tokens, pos, code, stmt.line);
      code.push({ op: 'JZ', target: null });
      dropPatches.push(code.length - 1);
      break;
    }
    case 'if': {
      pos = parseExpr(tokens, pos, code, stmt.line);
      const jzIndex = code.length;
      code.push({ op: 'JZ', target: null });
      endPatches.push(jzIndex);
      const thenToken = next();
      if (!thenToken || thenToken.type !== 'ident' || thenToken.value !== 'then') fail('expected "then"');
      const field = expectIdent();
      expectOp('=');
      pos = parseExpr(tokens, pos, code, stmt.line);
      code.push({ op: 'STORE', field });
      break;
    }
    default:
      fail(`unknown directive "${head.value}"`);
  }
  if (pos !== tokens.length) fail(`unexpected trailing token "${tokens[pos].value}"`);
}

function parseExpr(tokens, pos, code, line) {
  return parseComparison(tokens, pos, code, line);
}

function parseComparison(tokens, pos, code, line) {
  pos = parseAdditive(tokens, pos, code, line);
  const token = tokens[pos];
  if (token && token.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(token.value)) {
    pos = parseAdditive(tokens, pos + 1, code, line);
    code.push({ op: 'CMP', cmp: token.value });
  }
  return pos;
}

function parseAdditive(tokens, pos, code, line) {
  pos = parseMultiplicative(tokens, pos, code, line);
  while (tokens[pos] && tokens[pos].type === 'op' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
    const operator = tokens[pos].value;
    pos = parseMultiplicative(tokens, pos + 1, code, line);
    code.push({ op: operator === '+' ? 'ADD' : 'SUB' });
  }
  return pos;
}

function parseMultiplicative(tokens, pos, code, line) {
  pos = parseUnary(tokens, pos, code, line);
  while (tokens[pos] && tokens[pos].type === 'op' && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
    const operator = tokens[pos].value;
    pos = parseUnary(tokens, pos + 1, code, line);
    code.push({ op: operator === '*' ? 'MUL' : 'DIV' });
  }
  return pos;
}

function parseUnary(tokens, pos, code, line) {
  const token = tokens[pos];
  if (token && token.type === 'op' && token.value === '-') {
    pos = parseUnary(tokens, pos + 1, code, line);
    code.push({ op: 'NEG' });
    return pos;
  }
  return parsePrimary(tokens, pos, code, line);
}

function parsePrimary(tokens, pos, code, line) {
  const token = tokens[pos];
  if (!token) throw new SyntaxError(`unexpected end of expression at line ${line}`);
  if (token.type === 'number') {
    code.push({ op: 'PUSH', value: token.value });
    return pos + 1;
  }
  if (token.type === 'string') {
    code.push({ op: 'PUSH', value: token.value });
    return pos + 1;
  }
  if (token.type === 'ident') {
    code.push({ op: 'LOAD', field: token.value });
    return pos + 1;
  }
  if (token.type === 'op' && token.value === '(') {
    const next = parseExpr(tokens, pos + 1, code, line);
    const closing = tokens[next];
    if (!closing || closing.type !== 'op' || closing.value !== ')') {
      throw new SyntaxError(`missing ")" at line ${line}`);
    }
    return next + 1;
  }
  throw new SyntaxError(`unexpected token "${token.value}" at line ${line}`);
}
