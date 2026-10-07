import type { CmpOp, Expr } from './ast.js';
import { RuleSyntaxError } from './errors.js';
import { tokenize, type Token } from './lexer.js';

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

/**
 * 解析规则表达式为 AST。
 * 语法（优先级从低到高）：
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | cmp
 *   cmp     := primary ( cmpOp primary )?   // 不允许连续比较
 *   primary := '(' or ')' | 数字 | 字符串 | true | false | null | 字段名
 * 语法错误抛出 RuleSyntaxError，bytePos 为 UTF-8 字节偏移。
 */
export function parse(source: string): Expr {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;

  const parseOr = (): Expr => {
    let left = parseAnd();
    while (peek().type === 'op' && peek().value === '||') {
      const op = next();
      const right = parseAnd();
      left = { kind: 'or', left, right, bytePos: op.bytePos };
    }
    return left;
  };

  const parseAnd = (): Expr => {
    let left = parseUnary();
    while (peek().type === 'op' && peek().value === '&&') {
      const op = next();
      const right = parseUnary();
      left = { kind: 'and', left, right, bytePos: op.bytePos };
    }
    return left;
  };

  const parseUnary = (): Expr => {
    const tok = peek();
    if (tok.type === 'op' && tok.value === '!') {
      next();
      const operand = parseUnary();
      return { kind: 'not', operand, bytePos: tok.bytePos };
    }
    return parseCmp();
  };

  const parseCmp = (): Expr => {
    const left = parsePrimary();
    const tok = peek();
    if (tok.type === 'op' && CMP_OPS.has(tok.value)) {
      next();
      const right = parsePrimary();
      const after = peek();
      if (after.type === 'op' && CMP_OPS.has(after.value)) {
        throw new RuleSyntaxError(`不允许连续比较 '${after.value}'`, after.bytePos);
      }
      return { kind: 'cmp', op: tok.value as CmpOp, left, right, bytePos: tok.bytePos };
    }
    return left;
  };

  const parsePrimary = (): Expr => {
    const tok = next();
    switch (tok.type) {
      case 'lparen': {
        const inner = parseOr();
        const closing = peek();
        if (closing.type !== 'rparen') {
          throw new RuleSyntaxError("缺少右括号 ')'", closing.bytePos);
        }
        next();
        return inner;
      }
      case 'num':
        return { kind: 'num', value: BigInt(tok.value), bytePos: tok.bytePos };
      case 'str':
        return { kind: 'str', value: tok.value, bytePos: tok.bytePos };
      case 'bool':
        return { kind: 'bool', value: tok.value === 'true', bytePos: tok.bytePos };
      case 'null':
        return { kind: 'null', bytePos: tok.bytePos };
      case 'ident':
        return { kind: 'field', name: tok.value, bytePos: tok.bytePos };
      case 'eof':
        throw new RuleSyntaxError('表达式意外结束', tok.bytePos);
      default:
        throw new RuleSyntaxError(`意外的记号 '${tok.value}'`, tok.bytePos);
    }
  };

  const expr = parseOr();
  const tail = peek();
  if (tail.type !== 'eof') {
    throw new RuleSyntaxError(`意外的记号 '${tail.value}'`, tail.bytePos);
  }
  return expr;
}
