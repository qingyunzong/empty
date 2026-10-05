import { TemplateSyntaxError } from "./errors";
import type { SourcePosition } from "./errors";
import { tokenize } from "./lexer";
import type { Token } from "./lexer";

export type Expr =
  | { kind: "literal"; value: string | number | boolean | null; pos: SourcePosition }
  | { kind: "path"; segments: string[]; pos: SourcePosition }
  | { kind: "filter"; input: Expr; name: string; args: Expr[]; pos: SourcePosition };

export type Node =
  | { kind: "text"; value: string; pos: SourcePosition }
  | { kind: "output"; expr: Expr; pos: SourcePosition }
  | { kind: "if"; cond: Expr; body: Node[]; elseBody: Node[]; pos: SourcePosition }
  | {
      kind: "for";
      varName: string;
      iterable: Expr;
      body: Node[];
      elseBody: Node[];
      pos: SourcePosition;
    };

export function parse(source: string): Node[] {
  const tokens = tokenize(source);
  let cursor = 0;

  const peek = (): Token => tokens[cursor] as Token;
  const take = (): Token => tokens[cursor++] as Token;

  const expect = (kind: Token["kind"], what: string): Token => {
    const token = take();
    if (token.kind !== kind) {
      throw new TemplateSyntaxError(
        `expected ${what} but found ${describe(token)}`,
        token.pos
      );
    }
    return token;
  };

  const describe = (token: Token): string =>
    token.kind === "eof" ? "end of template" : JSON.stringify(token.value);

  const parseExpr = (): Expr => {
    let expr = parsePrimary();
    while (peek().kind === "pipe") {
      take();
      const nameToken = expect("ident", "a filter name");
      const args: Expr[] = [];
      if (peek().kind === "lparen") {
        take();
        if (peek().kind !== "rparen") {
          for (;;) {
            args.push(parseExpr());
            if (peek().kind !== "comma") break;
            take();
          }
        }
        expect("rparen", "')'");
      }
      expr = { kind: "filter", input: expr, name: nameToken.value, args, pos: nameToken.pos };
    }
    return expr;
  };

  const parsePrimary = (): Expr => {
    const token = take();
    switch (token.kind) {
      case "number":
        return { kind: "literal", value: Number(token.value), pos: token.pos };
      case "string":
        return { kind: "literal", value: token.value, pos: token.pos };
      case "ident": {
        if (token.value === "true") return { kind: "literal", value: true, pos: token.pos };
        if (token.value === "false") return { kind: "literal", value: false, pos: token.pos };
        if (token.value === "null") return { kind: "literal", value: null, pos: token.pos };
        const segments = [token.value];
        while (peek().kind === "dot") {
          take();
          const segment = take();
          if (segment.kind === "ident" || segment.kind === "number") {
            segments.push(segment.value);
          } else {
            throw new TemplateSyntaxError(
              `expected a field name after "." but found ${describe(segment)}`,
              segment.pos
            );
          }
        }
        return { kind: "path", segments, pos: token.pos };
      }
      default:
        throw new TemplateSyntaxError(
          `expected an expression but found ${describe(token)}`,
          token.pos
        );
    }
  };

  interface Block {
    nodes: Node[];
    stop: Token | undefined;
  }

  const parseNodes = (stopKeywords: string[]): Block => {
    const nodes: Node[] = [];
    for (;;) {
      const token = take();
      if (token.kind === "eof") return { nodes, stop: undefined };
      if (token.kind === "text") {
        nodes.push({ kind: "text", value: token.value, pos: token.pos });
        continue;
      }
      if (token.kind === "openVar") {
        const expr = parseExpr();
        expect("closeVar", '"}}"');
        nodes.push({ kind: "output", expr, pos: token.pos });
        continue;
      }
      if (token.kind === "openTag") {
        const keyword = expect("ident", "a tag keyword");
        if (stopKeywords.includes(keyword.value)) {
          return { nodes, stop: keyword };
        }
        if (keyword.value === "if") {
          const cond = parseExpr();
          expect("closeTag", '"%}"');
          const body = parseNodes(["else", "endif"]);
          let elseBody: Node[] = [];
          if (body.stop === undefined) {
            throw new TemplateSyntaxError('missing {% endif %}', keyword.pos);
          }
          expect("closeTag", '"%}"');
          if (body.stop.value === "else") {
            const rest = parseNodes(["endif"]);
            if (rest.stop === undefined) {
              throw new TemplateSyntaxError('missing {% endif %}', keyword.pos);
            }
            expect("closeTag", '"%}"');
            elseBody = rest.nodes;
          }
          nodes.push({ kind: "if", cond, body: body.nodes, elseBody, pos: token.pos });
          continue;
        }
        if (keyword.value === "for") {
          const varToken = expect("ident", "a loop variable");
          const inToken = expect("ident", '"in"');
          if (inToken.value !== "in") {
            throw new TemplateSyntaxError('expected "in" in for tag', inToken.pos);
          }
          const iterable = parseExpr();
          expect("closeTag", '"%}"');
          const body = parseNodes(["else", "endfor"]);
          let elseBody: Node[] = [];
          if (body.stop === undefined) {
            throw new TemplateSyntaxError('missing {% endfor %}', keyword.pos);
          }
          expect("closeTag", '"%}"');
          if (body.stop.value === "else") {
            const rest = parseNodes(["endfor"]);
            if (rest.stop === undefined) {
              throw new TemplateSyntaxError('missing {% endfor %}', keyword.pos);
            }
            expect("closeTag", '"%}"');
            elseBody = rest.nodes;
          }
          nodes.push({
            kind: "for",
            varName: varToken.value,
            iterable,
            body: body.nodes,
            elseBody,
            pos: token.pos,
          });
          continue;
        }
        throw new TemplateSyntaxError(`unexpected tag "${keyword.value}"`, keyword.pos);
      }
      throw new TemplateSyntaxError(
        `unexpected ${describe(token)}`,
        token.pos
      );
    }
  };

  const top = parseNodes([]);
  if (top.stop !== undefined) {
    throw new TemplateSyntaxError(`unexpected tag "${top.stop.value}"`, top.stop.pos);
  }
  return top.nodes;
}
