import type { Expr } from './ast.js';
/** 规则中可比较的值；数值一律为 bigint。 */
export type Value = bigint | string | boolean | null;
/** 上下文字段值；整数 number 会自动转换为 bigint。 */
export type Context = Record<string, Value | number>;
export interface EvalResult {
    /** 规则求值结果 */
    result: boolean;
    /** 实际读取的字段名，按读取顺序排列（短路的字段不会出现） */
    reads: string[];
}
/**
 * 对 AST 求值。&& / || 短路：未访问的字段不读取、不校验、不报错。
 * 返回结果与实际读取字段顺序。
 */
export declare function evaluate(expr: Expr, ctx: Context): EvalResult;
