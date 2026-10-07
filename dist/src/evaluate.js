import { RuleEvalError } from './errors.js';
const typeName = (v) => {
    if (v === null)
        return 'null';
    if (typeof v === 'bigint')
        return '数值';
    if (typeof v === 'string')
        return '字符串';
    return '布尔值';
};
function requireBool(v, bytePos) {
    if (typeof v !== 'boolean') {
        throw new RuleEvalError('type-mismatch', `逻辑运算的操作数必须是布尔值，实际是${typeName(v)}`, bytePos);
    }
    return v;
}
function compare(op, l, r, bytePos) {
    if (l === null || r === null) {
        if (op === '==')
            return l === r;
        if (op === '!=')
            return l !== r;
        throw new RuleEvalError('null-ordering', `空值(null)只允许 == / != 比较，不允许 '${op}'`, bytePos);
    }
    if (typeof l !== typeof r) {
        if (op === '==')
            return false;
        if (op === '!=')
            return true;
        throw new RuleEvalError('type-mismatch', `不能比较${typeName(l)}与${typeName(r)}`, bytePos);
    }
    if (typeof l === 'boolean') {
        if (op === '==')
            return l === r;
        if (op === '!=')
            return l !== r;
        throw new RuleEvalError('type-mismatch', `布尔值只允许 == / != 比较，不允许 '${op}'`, bytePos);
    }
    // l 与 r 同为 bigint 或同为 string，均支持全序比较
    if (op === '==')
        return l === r;
    if (op === '!=')
        return l !== r;
    if (typeof l === 'bigint') {
        const rb = r;
        if (op === '<')
            return l < rb;
        if (op === '<=')
            return l <= rb;
        if (op === '>')
            return l > rb;
        return l >= rb;
    }
    const rs = r;
    if (op === '<')
        return l < rs;
    if (op === '<=')
        return l <= rs;
    if (op === '>')
        return l > rs;
    return l >= rs;
}
function evalExpr(expr, ctx, reads) {
    switch (expr.kind) {
        case 'or': {
            const l = requireBool(evalExpr(expr.left, ctx, reads), expr.left.bytePos);
            if (l)
                return true; // 短路：不访问右侧
            return requireBool(evalExpr(expr.right, ctx, reads), expr.right.bytePos);
        }
        case 'and': {
            const l = requireBool(evalExpr(expr.left, ctx, reads), expr.left.bytePos);
            if (!l)
                return false; // 短路：不访问右侧
            return requireBool(evalExpr(expr.right, ctx, reads), expr.right.bytePos);
        }
        case 'not':
            return !requireBool(evalExpr(expr.operand, ctx, reads), expr.operand.bytePos);
        case 'cmp': {
            const l = evalExpr(expr.left, ctx, reads);
            const r = evalExpr(expr.right, ctx, reads);
            return compare(expr.op, l, r, expr.bytePos);
        }
        case 'field': {
            reads.push(expr.name);
            if (!(expr.name in ctx)) {
                throw new RuleEvalError('unknown-field', `未知字段 '${expr.name}'`, expr.bytePos);
            }
            const v = ctx[expr.name];
            if (typeof v === 'number') {
                if (!Number.isInteger(v)) {
                    throw new RuleEvalError('type-mismatch', `字段 '${expr.name}' 的数值必须是整数（bigint）`, expr.bytePos);
                }
                return BigInt(v);
            }
            if (typeof v === 'bigint' ||
                typeof v === 'string' ||
                typeof v === 'boolean' ||
                v === null) {
                return v;
            }
            throw new RuleEvalError('type-mismatch', `字段 '${expr.name}' 的值类型不受支持`, expr.bytePos);
        }
        case 'num':
            return expr.value;
        case 'str':
            return expr.value;
        case 'bool':
            return expr.value;
        case 'null':
            return null;
    }
}
/**
 * 对 AST 求值。&& / || 短路：未访问的字段不读取、不校验、不报错。
 * 返回结果与实际读取字段顺序。
 */
export function evaluate(expr, ctx) {
    const reads = [];
    const value = evalExpr(expr, ctx, reads);
    if (typeof value !== 'boolean') {
        throw new RuleEvalError('not-boolean', '规则结果必须是布尔值', expr.bytePos);
    }
    return { result: value, reads };
}
