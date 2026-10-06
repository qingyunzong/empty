/**
 * Tiny integer expression evaluator for register-update / output expressions.
 * Grammar:
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/'|'%') factor)*
 *   factor := '-' factor | NUMBER | IDENT | '(' expr ')'
 * Division truncates toward zero. All values are plain integers; callers mask
 * to 8 bits when storing into a register.
 */

export type RegEnv = Record<string, number>;

export interface CompiledExpr {
  eval(env: RegEnv): number;
  vars: string[];
}

type Token =
  | { kind: "num"; value: number }
  | { kind: "ident"; name: string }
  | { kind: "op"; op: string }
  | { kind: "lparen" }
  | { kind: "rparen" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < src.length && src[j] >= "0" && src[j] <= "9") j++;
      tokens.push({ kind: "num", value: parseInt(src.slice(i, j), 10) });
      i = j; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: "ident", name: src.slice(i, j) });
      i = j; continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
      tokens.push({ kind: "op", op: ch }); i++; continue;
    }
    if (ch === "(") { tokens.push({ kind: "lparen" }); i++; continue; }
    if (ch === ")") { tokens.push({ kind: "rparen" }); i++; continue; }
    throw new Error(`expression: unexpected character '${ch}' in "${src}"`);
  }
  return tokens;
}

type Ast =
  | { kind: "num"; value: number }
  | { kind: "var"; name: string }
  | { kind: "neg"; e: Ast }
  | { kind: "bin"; op: string; l: Ast; r: Ast };

export function parseExpr(src: string): CompiledExpr {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  function parsePrimary(): Ast {
    const t = peek();
    if (!t) throw new Error(`expression: unexpected end of "${src}"`);
    if (t.kind === "num") { pos++; return { kind: "num", value: t.value }; }
    if (t.kind === "ident") { pos++; return { kind: "var", name: t.name }; }
    if (t.kind === "lparen") {
      pos++;
      const e = parseAdd();
      const close = peek();
      if (!close || close.kind !== "rparen") throw new Error(`expression: missing ')' in "${src}"`);
      pos++;
      return e;
    }
    if (t.kind === "op" && t.op === "-") { pos++; return { kind: "neg", e: parsePrimary() }; }
    throw new Error(`expression: unexpected token in "${src}"`);
  }

  function parseMul(): Ast {
    let l = parsePrimary();
    for (;;) {
      const t = peek();
      if (t && t.kind === "op" && (t.op === "*" || t.op === "/" || t.op === "%")) {
        pos++;
        l = { kind: "bin", op: t.op, l, r: parsePrimary() };
      } else return l;
    }
  }

  function parseAdd(): Ast {
    let l = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.kind === "op" && (t.op === "+" || t.op === "-")) {
        pos++;
        l = { kind: "bin", op: t.op, l, r: parseMul() };
      } else return l;
    }
  }

  const ast = parseAdd();
  if (pos !== tokens.length) throw new Error(`expression: trailing tokens in "${src}"`);

  const vars: string[] = [];
  (function collect(a: Ast): void {
    switch (a.kind) {
      case "var": if (!vars.includes(a.name)) vars.push(a.name); break;
      case "neg": collect(a.e); break;
      case "bin": collect(a.l); collect(a.r); break;
    }
  })(ast);

  function ev(a: Ast, env: RegEnv): number {
    switch (a.kind) {
      case "num": return a.value;
      case "var": {
        const v = env[a.name];
        if (v === undefined) throw new Error(`expression: unknown register '${a.name}'`);
        return v;
      }
      case "neg": return -ev(a.e, env);
      case "bin": {
        const l = ev(a.l, env);
        const r = ev(a.r, env);
        switch (a.op) {
          case "+": return l + r;
          case "-": return l - r;
          case "*": return l * r;
          case "/":
            if (r === 0) throw new Error("expression: division by zero");
            return Math.trunc(l / r);
          case "%":
            if (r === 0) throw new Error("expression: modulo by zero");
            return l % r;
        }
      }
    }
    throw new Error("expression: internal error");
  }

  return { eval: (env) => ev(ast, env), vars };
}

/** Mask an integer into an unsigned 8-bit register value. */
export function toByte(v: number): number {
  return v & 0xff;
}
