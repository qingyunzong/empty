import type { Expr } from './ast.js';
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
export declare function parse(source: string): Expr;
