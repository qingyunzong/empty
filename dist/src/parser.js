"use strict";
/**
 * Parser for the constraint DSL.
 *
 * Grammar (line based, `#` starts a comment):
 *   domain      := "var" IDENT "in" "[" SIGNED_INT "," SIGNED_INT "]"
 *   constraint  := expr REL_OP expr
 *                | expr "%" INT "==" expr
 *                | expr "==" expr "(" "mod" INT ")"
 *   expr        := term (("+"|"-") term)*
 *   term        := factor ("*" factor)*        (must stay linear)
 *   factor      := INT | IDENT | "(" expr ")" | ("+"|"-") factor
 *   REL_OP      := "<=" | "<" | ">=" | ">" | "==" | "!="
 *
 * All integers are parsed as bigint: no floating point anywhere.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParseError = exports.INT64_MAX = exports.INT64_MIN = void 0;
exports.parseProblem = parseProblem;
exports.INT64_MIN = -(2n ** 63n);
exports.INT64_MAX = 2n ** 63n - 1n;
class ParseError extends Error {
    line;
    constructor(line, message) {
        super(`line ${line}: ${message}`);
        this.line = line;
        this.name = "ParseError";
    }
}
exports.ParseError = ParseError;
const REL_OPS = new Set(["<=", "<", ">=", ">", "==", "!="]);
function tokenize(s, line) {
    const toks = [];
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === " " || ch === "\t" || ch === "\r") {
            i++;
            continue;
        }
        if (ch >= "0" && ch <= "9") {
            let j = i;
            while (j < s.length && s[j] >= "0" && s[j] <= "9")
                j++;
            toks.push({ t: "int", v: BigInt(s.slice(i, j)) });
            i = j;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            let j = i;
            while (j < s.length && /[A-Za-z0-9_]/.test(s[j]))
                j++;
            toks.push({ t: "id", v: s.slice(i, j) });
            i = j;
            continue;
        }
        const two = s.slice(i, i + 2);
        if (two === "<=" || two === ">=" || two === "==" || two === "!=") {
            toks.push({ t: "sym", v: two });
            i += 2;
            continue;
        }
        if ("[](),+-*%<>".includes(ch)) {
            toks.push({ t: "sym", v: ch });
            i++;
            continue;
        }
        throw new ParseError(line, `unexpected character '${ch}'`);
    }
    return toks;
}
function constExpr(c) {
    return { coeffs: new Map(), constant: c };
}
function varExpr(name) {
    return { coeffs: new Map([[name, 1n]]), constant: 0n };
}
function addExpr(a, b, sign) {
    const coeffs = new Map(a.coeffs);
    for (const [v, k] of b.coeffs) {
        const nv = (coeffs.get(v) ?? 0n) + sign * k;
        if (nv === 0n)
            coeffs.delete(v);
        else
            coeffs.set(v, nv);
    }
    return { coeffs, constant: a.constant + sign * b.constant };
}
function scaleExpr(e, k) {
    if (k === 0n)
        return constExpr(0n);
    const coeffs = new Map();
    for (const [v, c] of e.coeffs)
        coeffs.set(v, c * k);
    return { coeffs, constant: e.constant * k };
}
function isConst(e) {
    return e.coeffs.size === 0;
}
function mulExpr(a, b, line) {
    if (isConst(a))
        return scaleExpr(b, a.constant);
    if (isConst(b))
        return scaleExpr(a, b.constant);
    throw new ParseError(line, "non-linear term (product of two variable expressions)");
}
class ExprParser {
    toks;
    line;
    pos = 0;
    constructor(toks, line) {
        this.toks = toks;
        this.line = line;
    }
    atEnd() {
        return this.pos >= this.toks.length;
    }
    peek() {
        return this.toks[this.pos];
    }
    parseExpr() {
        let left = this.parseTerm();
        for (;;) {
            const t = this.peek();
            if (t && t.t === "sym" && (t.v === "+" || t.v === "-")) {
                this.pos++;
                const right = this.parseTerm();
                left = addExpr(left, right, t.v === "+" ? 1n : -1n);
            }
            else {
                return left;
            }
        }
    }
    parseTerm() {
        let left = this.parseFactor();
        for (;;) {
            const t = this.peek();
            if (t && t.t === "sym" && t.v === "*") {
                this.pos++;
                const right = this.parseFactor();
                left = mulExpr(left, right, this.line);
            }
            else {
                return left;
            }
        }
    }
    parseFactor() {
        const t = this.peek();
        if (!t)
            throw new ParseError(this.line, "unexpected end of expression");
        if (t.t === "sym" && t.v === "-") {
            this.pos++;
            return scaleExpr(this.parseFactor(), -1n);
        }
        if (t.t === "sym" && t.v === "+") {
            this.pos++;
            return this.parseFactor();
        }
        if (t.t === "sym" && t.v === "(") {
            this.pos++;
            const e = this.parseExpr();
            const close = this.peek();
            if (!close || close.t !== "sym" || close.v !== ")") {
                throw new ParseError(this.line, "expected ')'");
            }
            this.pos++;
            return e;
        }
        if (t.t === "int") {
            this.pos++;
            return constExpr(t.v);
        }
        if (t.t === "id") {
            this.pos++;
            return varExpr(t.v);
        }
        throw new ParseError(this.line, `unexpected token '${t.v}'`);
    }
}
function parseExprTokens(toks, line) {
    const p = new ExprParser(toks, line);
    const e = p.parseExpr();
    if (!p.atEnd())
        throw new ParseError(line, "trailing tokens in expression");
    return e;
}
function subExpr(a, b) {
    return addExpr(a, b, -1n);
}
function isSym(t, v) {
    return t !== undefined && t.t === "sym" && t.v === v;
}
function isId(t, v) {
    return t !== undefined && t.t === "id" && t.v === v;
}
function parseSignedInt(toks, pos, line) {
    let sign = 1n;
    let i = pos;
    if (isSym(toks[i], "-")) {
        sign = -1n;
        i++;
    }
    else if (isSym(toks[i], "+")) {
        i++;
    }
    const t = toks[i];
    if (!t || t.t !== "int")
        throw new ParseError(line, "expected an integer");
    return { value: sign * t.v, next: i + 1 };
}
function parseDomain(toks, line) {
    // var IDENT in [ LO , HI ]
    const nameTok = toks[1];
    if (!nameTok || nameTok.t !== "id")
        throw new ParseError(line, "expected variable name after 'var'");
    if (!isId(toks[2], "in"))
        throw new ParseError(line, "expected 'in' after variable name");
    if (!isSym(toks[3], "["))
        throw new ParseError(line, "expected '['");
    const lo = parseSignedInt(toks, 4, line);
    if (!isSym(toks[lo.next], ","))
        throw new ParseError(line, "expected ','");
    const hi = parseSignedInt(toks, lo.next + 1, line);
    if (!isSym(toks[hi.next], "]"))
        throw new ParseError(line, "expected ']'");
    if (hi.next + 1 !== toks.length)
        throw new ParseError(line, "trailing tokens after domain");
    if (lo.value > hi.value)
        throw new ParseError(line, "domain lower bound exceeds upper bound");
    if (lo.value < exports.INT64_MIN || hi.value > exports.INT64_MAX) {
        throw new ParseError(line, "domain bounds must lie in the signed 64-bit range");
    }
    return { name: nameTok.v, domain: { lo: lo.value, hi: hi.value } };
}
function parseConstraint(toks, line, source) {
    // Form: expr == expr (mod INT)
    const n = toks.length;
    if (n >= 5 &&
        isSym(toks[n - 4], "(") &&
        isId(toks[n - 3], "mod") &&
        toks[n - 2].t === "int" &&
        isSym(toks[n - 1], ")")) {
        const modulus = toks[n - 2].v;
        if (modulus <= 0n)
            throw new ParseError(line, "modulus must be a positive integer");
        const body = toks.slice(0, n - 4);
        const eq = body.findIndex((t) => isSym(t, "=="));
        if (eq < 0)
            throw new ParseError(line, "expected '==' before '(mod ...)'");
        const lhs = parseExprTokens(body.slice(0, eq), line);
        const rhs = parseExprTokens(body.slice(eq + 1), line);
        return { kind: "cong", modulus, expr: subExpr(lhs, rhs), source, line };
    }
    // Locate the (single) top-level relational operator.
    let depth = 0;
    let opIdx = -1;
    let pctIdx = -1;
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.t === "sym" && t.v === "(")
            depth++;
        else if (t.t === "sym" && t.v === ")")
            depth--;
        else if (depth === 0 && t.t === "sym" && t.v === "%" && pctIdx < 0 && opIdx < 0)
            pctIdx = i;
        else if (depth === 0 && t.t === "sym" && REL_OPS.has(t.v)) {
            if (opIdx >= 0)
                throw new ParseError(line, "more than one relational operator");
            opIdx = i;
        }
    }
    if (opIdx < 0)
        throw new ParseError(line, "expected a relational operator");
    if (pctIdx >= 0) {
        // Form: expr % INT == expr
        const mTok = toks[pctIdx + 1];
        if (!mTok || mTok.t !== "int")
            throw new ParseError(line, "expected integer modulus after '%'");
        if (mTok.v <= 0n)
            throw new ParseError(line, "modulus must be a positive integer");
        if (!isSym(toks[pctIdx + 2], "==") || pctIdx + 2 !== opIdx) {
            throw new ParseError(line, "congruence must have the form 'expr % m == expr'");
        }
        const lhs = parseExprTokens(toks.slice(0, pctIdx), line);
        const rhs = parseExprTokens(toks.slice(opIdx + 1), line);
        return { kind: "cong", modulus: mTok.v, expr: subExpr(lhs, rhs), source, line };
    }
    const op = toks[opIdx].v;
    const lhs = parseExprTokens(toks.slice(0, opIdx), line);
    const rhs = parseExprTokens(toks.slice(opIdx + 1), line);
    return { kind: "ineq", op, expr: subExpr(lhs, rhs), source, line };
}
function parseProblem(text) {
    const domains = new Map();
    const constraints = [];
    const lines = text.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
        const lineNo = idx + 1;
        const raw = lines[idx];
        const hash = raw.indexOf("#");
        const body = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
        if (body === "")
            continue;
        const toks = tokenize(body, lineNo);
        if (toks.length === 0)
            continue;
        if (isId(toks[0], "var")) {
            const { name, domain } = parseDomain(toks, lineNo);
            if (domains.has(name))
                throw new ParseError(lineNo, `duplicate declaration of variable '${name}'`);
            domains.set(name, domain);
        }
        else {
            constraints.push(parseConstraint(toks, lineNo, body));
        }
    }
    if (domains.size === 0)
        throw new ParseError(0, "no variable declared (use 'var x in [lo, hi]')");
    for (const c of constraints) {
        for (const v of c.expr.coeffs.keys()) {
            if (!domains.has(v))
                throw new ParseError(c.line, `unknown variable '${v}'`);
        }
    }
    return { domains, constraints };
}
