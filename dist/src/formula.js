import { formatAddr, parseAddr } from './address.js';
/** All addresses referenced anywhere in the formula (static superset of runtime deps). */
export function staticRefs(expr, into = new Set()) {
    switch (expr.type) {
        case 'num':
            break;
        case 'ref':
            into.add(formatAddr(expr.addr));
            break;
        case 'bin':
            staticRefs(expr.left, into);
            staticRefs(expr.right, into);
            break;
        case 'neg':
            staticRefs(expr.operand, into);
            break;
        case 'if':
            staticRefs(expr.cond, into);
            staticRefs(expr.thenBranch, into);
            staticRefs(expr.elseBranch, into);
            break;
    }
    return into;
}
function tokenize(text) {
    const tokens = [];
    let i = 0;
    const isDigit = (c) => c >= '0' && c <= '9';
    const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
    while (i < text.length) {
        const c = text[i];
        if (c === ' ' || c === '\t' || c === '\n') {
            i++;
        }
        else if (isDigit(c)) {
            let j = i;
            while (j < text.length && isDigit(text[j]))
                j++;
            tokens.push({ kind: 'num', value: Number.parseInt(text.slice(i, j), 10) });
            i = j;
        }
        else if (isAlpha(c)) {
            let j = i;
            while (j < text.length && (isAlpha(text[j]) || isDigit(text[j])))
                j++;
            const word = text.slice(i, j);
            if (word.toUpperCase() === 'IF') {
                tokens.push({ kind: 'if' });
            }
            else if (/^[A-Za-z]+[0-9]+$/.test(word)) {
                tokens.push({ kind: 'ref', addr: parseAddr(word.toUpperCase()) });
            }
            else {
                throw new Error(`invalid token: ${word}`);
            }
            i = j;
        }
        else if (c === '<' && text[i + 1] === '>') {
            tokens.push({ kind: 'op', op: '<>' });
            i += 2;
        }
        else if (c === '<' && text[i + 1] === '=') {
            tokens.push({ kind: 'op', op: '<=' });
            i += 2;
        }
        else if (c === '>' && text[i + 1] === '=') {
            tokens.push({ kind: 'op', op: '>=' });
            i += 2;
        }
        else if ('+-*/(),=<>'.includes(c)) {
            tokens.push({ kind: 'op', op: c });
            i++;
        }
        else {
            throw new Error(`unexpected character: ${c}`);
        }
    }
    return tokens;
}
/** Parse a formula string (optional leading '='). */
export function parseFormula(text) {
    const src = text.startsWith('=') ? text.slice(1) : text;
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const expectOp = (op) => {
        const t = tokens[pos];
        if (!t || t.kind !== 'op' || t.op !== op) {
            throw new Error(`expected '${op}' at token ${pos}`);
        }
        pos++;
    };
    const parsePrimary = () => {
        const t = tokens[pos];
        if (!t)
            throw new Error('unexpected end of formula');
        if (t.kind === 'num') {
            pos++;
            return { type: 'num', value: t.value };
        }
        if (t.kind === 'ref') {
            pos++;
            return { type: 'ref', addr: t.addr };
        }
        if (t.kind === 'if') {
            pos++;
            expectOp('(');
            const cond = parseExpr();
            expectOp(',');
            const thenBranch = parseExpr();
            expectOp(',');
            const elseBranch = parseExpr();
            expectOp(')');
            return { type: 'if', cond, thenBranch, elseBranch };
        }
        if (t.kind === 'op' && t.op === '(') {
            pos++;
            const e = parseExpr();
            expectOp(')');
            return e;
        }
        throw new Error(`unexpected token at ${pos}`);
    };
    const parseUnary = () => {
        const t = peek();
        if (t && t.kind === 'op' && t.op === '-') {
            pos++;
            return { type: 'neg', operand: parseUnary() };
        }
        return parsePrimary();
    };
    const parseMul = () => {
        let left = parseUnary();
        for (;;) {
            const t = peek();
            if (t && t.kind === 'op' && (t.op === '*' || t.op === '/')) {
                pos++;
                left = { type: 'bin', op: t.op, left, right: parseUnary() };
            }
            else
                return left;
        }
    };
    const parseAdd = () => {
        let left = parseMul();
        for (;;) {
            const t = peek();
            if (t && t.kind === 'op' && (t.op === '+' || t.op === '-')) {
                pos++;
                left = { type: 'bin', op: t.op, left, right: parseMul() };
            }
            else
                return left;
        }
    };
    const parseExpr = () => {
        let left = parseAdd();
        const t = peek();
        if (t && t.kind === 'op' && ['=', '<>', '<', '<=', '>', '>='].includes(t.op)) {
            pos++;
            left = { type: 'bin', op: t.op, left, right: parseAdd() };
        }
        return left;
    };
    const expr = parseExpr();
    if (pos !== tokens.length)
        throw new Error(`trailing tokens at ${pos}`);
    return expr;
}
