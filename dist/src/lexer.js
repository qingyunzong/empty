import { RuleSyntaxError } from './errors.js';
function utf8Len(codePoint) {
    if (codePoint <= 0x7f)
        return 1;
    if (codePoint <= 0x7ff)
        return 2;
    if (codePoint <= 0xffff)
        return 3;
    return 4;
}
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_.]/;
const DIGIT = /[0-9]/;
export function tokenize(source) {
    const tokens = [];
    let i = 0; // UTF-16 索引
    let byte = 0; // UTF-8 字节偏移
    const advance = (text) => {
        for (const ch of text) {
            byte += utf8Len(ch.codePointAt(0));
        }
        i += text.length;
    };
    while (i < source.length) {
        const ch = source[i];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            advance(ch);
            continue;
        }
        const start = byte;
        if (ch === '(') {
            tokens.push({ type: 'lparen', value: '(', bytePos: start });
            advance(ch);
            continue;
        }
        if (ch === ')') {
            tokens.push({ type: 'rparen', value: ')', bytePos: start });
            advance(ch);
            continue;
        }
        if (ch === '&' || ch === '|') {
            if (source[i + 1] === ch) {
                tokens.push({ type: 'op', value: ch + ch, bytePos: start });
                advance(ch + ch);
            }
            else {
                throw new RuleSyntaxError(`单个 '${ch}' 不是合法运算符，是否想写 '${ch}${ch}'？`, start);
            }
            continue;
        }
        if (ch === '!') {
            if (source[i + 1] === '=') {
                tokens.push({ type: 'op', value: '!=', bytePos: start });
                advance('!=');
            }
            else {
                tokens.push({ type: 'op', value: '!', bytePos: start });
                advance('!');
            }
            continue;
        }
        if (ch === '=') {
            if (source[i + 1] === '=') {
                tokens.push({ type: 'op', value: '==', bytePos: start });
                advance('==');
            }
            else {
                throw new RuleSyntaxError("单个 '=' 不是合法运算符，是否想写 '=='？", start);
            }
            continue;
        }
        if (ch === '<' || ch === '>') {
            if (source[i + 1] === '=') {
                tokens.push({ type: 'op', value: ch + '=', bytePos: start });
                advance(ch + '=');
            }
            else {
                tokens.push({ type: 'op', value: ch, bytePos: start });
                advance(ch);
            }
            continue;
        }
        if (DIGIT.test(ch)) {
            let j = i;
            while (j < source.length && DIGIT.test(source[j]))
                j++;
            const text = source.slice(i, j);
            if (source[j] === '.' && DIGIT.test(source[j + 1] ?? '')) {
                throw new RuleSyntaxError('数值只支持整数（bigint），不支持小数', start);
            }
            tokens.push({ type: 'num', value: text, bytePos: start });
            advance(text);
            continue;
        }
        if (ch === '"' || ch === "'") {
            advance(ch);
            let value = '';
            let closed = false;
            while (i < source.length) {
                const c = source[i];
                if (c === ch) {
                    advance(c);
                    closed = true;
                    break;
                }
                if (c === '\\') {
                    const next = source[i + 1];
                    const escapes = {
                        '\\': '\\',
                        '"': '"',
                        "'": "'",
                        n: '\n',
                        t: '\t',
                        r: '\r',
                    };
                    if (next === undefined || !(next in escapes)) {
                        throw new RuleSyntaxError(`非法转义序列 '\\${next ?? ''}'`, byte);
                    }
                    value += escapes[next];
                    advance(c + next);
                    continue;
                }
                value += c;
                advance(c);
            }
            if (!closed) {
                throw new RuleSyntaxError('字符串未闭合', start);
            }
            tokens.push({ type: 'str', value, bytePos: start });
            continue;
        }
        if (IDENT_START.test(ch)) {
            let j = i;
            while (j < source.length && IDENT_PART.test(source[j]))
                j++;
            const text = source.slice(i, j);
            if (text === 'true' || text === 'false') {
                tokens.push({ type: 'bool', value: text, bytePos: start });
            }
            else if (text === 'null') {
                tokens.push({ type: 'null', value: text, bytePos: start });
            }
            else {
                tokens.push({ type: 'ident', value: text, bytePos: start });
            }
            advance(text);
            continue;
        }
        throw new RuleSyntaxError(`无法识别的字符 '${ch}'`, start);
    }
    tokens.push({ type: 'eof', value: '', bytePos: byte });
    return tokens;
}
