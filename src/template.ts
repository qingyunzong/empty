/**
 * Lexer + parser for the email template language.
 *
 * Syntax:
 *   {{ user.name }}                 variable (dotted path)
 *   {% if expr %} ... {% else %} ... {% endif %}
 *   {% for item in items %} ... {% endfor %}
 * Expressions: dotted path, optional leading "!" (negation).
 *
 * Every AST node carries [start, end) offsets into the original template
 * so that errors and provenance can point back at the source text.
 */

export interface Span {
  start: number;
  end: number;
}

export type Node = TextNode | VarNode | IfNode | ForNode;

export interface TextNode extends Span {
  type: 'text';
}

export interface VarNode extends Span {
  type: 'var';
  path: string[];
  raw: string;
}

export interface Condition {
  negate: boolean;
  path: string[];
}

export interface IfNode extends Span {
  type: 'if';
  cond: Condition;
  thenBody: Node[];
  elseBody: Node[];
}

export interface ForNode extends Span {
  type: 'for';
  itemName: string;
  listPath: string[];
  body: Node[];
}

export class TemplateSyntaxError extends Error {
  readonly start: number;
  readonly end: number;
  readonly source: string;

  constructor(message: string, span: Span, source: string) {
    super(`${message} (at ${span.start}..${span.end}: ${JSON.stringify(source.slice(span.start, span.end))})`);
    this.name = 'TemplateSyntaxError';
    this.start = span.start;
    this.end = span.end;
    this.source = source;
  }

  /** The offending slice of the original template. */
  excerpt(): string {
    return this.source.slice(this.start, this.end);
  }
}

type Token =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'var'; start: number; end: number; inner: string }
  | { kind: 'tag'; start: number; end: number; inner: string };

const TOKEN_RE = /\{\{|\{%/g;

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  TOKEN_RE.lastIndex = 0;
  for (;;) {
    const m = TOKEN_RE.exec(source);
    if (m === null) break;
    const open = m.index;
    if (open > pos) tokens.push({ kind: 'text', start: pos, end: open });
    const isVar = m[0] === '{{';
    const close = isVar ? '}}' : '%}';
    const closeAt = source.indexOf(close, open + 2);
    if (closeAt === -1) {
      throw new TemplateSyntaxError(
        `unclosed ${isVar ? 'variable' : 'tag'}`,
        { start: open, end: source.length },
        source,
      );
    }
    tokens.push({
      kind: isVar ? 'var' : 'tag',
      start: open,
      end: closeAt + 2,
      inner: source.slice(open + 2, closeAt).trim(),
    });
    pos = closeAt + 2;
    TOKEN_RE.lastIndex = pos;
  }
  if (pos < source.length) tokens.push({ kind: 'text', start: pos, end: source.length });
  return tokens;
}

const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

function parsePath(raw: string, span: Span, source: string): string[] {
  if (!PATH_RE.test(raw)) {
    throw new TemplateSyntaxError(`invalid expression ${JSON.stringify(raw)}`, span, source);
  }
  return raw.split('.');
}

function parseCondition(raw: string, span: Span, source: string): Condition {
  const negate = raw.startsWith('!');
  const rest = negate ? raw.slice(1).trim() : raw;
  return { negate, path: parsePath(rest, span, source) };
}

const FOR_RE = /^for\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+(.+)$/;

export function parse(source: string): Node[] {
  const tokens = lex(source);
  let cursor = 0;

  function parseBlock(
    closers: ReadonlySet<string>,
    opener: { word: string; start: number; end: number } | null,
  ): Node[] {
    const nodes: Node[] = [];
    while (cursor < tokens.length) {
      const tok = tokens[cursor]!;
      if (tok.kind === 'text') {
        nodes.push({ type: 'text', start: tok.start, end: tok.end });
        cursor++;
        continue;
      }
      if (tok.kind === 'var') {
        nodes.push({
          type: 'var',
          start: tok.start,
          end: tok.end,
          path: parsePath(tok.inner, tok, source),
          raw: tok.inner,
        });
        cursor++;
        continue;
      }
      // tag
      const word = tok.inner.split(/\s/, 1)[0] ?? '';
      if (closers.has(word)) return nodes;
      if (word === 'if') {
        const span: Span = { start: tok.start, end: tok.end };
        const cond = parseCondition(tok.inner.slice(2).trim(), span, source);
        cursor++;
        const thenBody = parseBlock(new Set(['else', 'endif']), { word: 'if', start: tok.start, end: tok.end });
        let elseBody: Node[] = [];
        const closer = tokens[cursor];
        if (closer === undefined || closer.kind !== 'tag') {
          throw new TemplateSyntaxError('unclosed {% if %}', span, source);
        }
        if (closer.inner === 'else') {
          cursor++;
          elseBody = parseBlock(new Set(['endif']), { word: 'if', start: tok.start, end: tok.end });
        }
        const endTok = tokens[cursor];
        if (endTok === undefined || endTok.kind !== 'tag' || endTok.inner !== 'endif') {
          throw new TemplateSyntaxError('unclosed {% if %}', span, source);
        }
        cursor++;
        nodes.push({ type: 'if', start: tok.start, end: endTok.end, cond, thenBody, elseBody });
        continue;
      }
      if (word === 'for') {
        const span: Span = { start: tok.start, end: tok.end };
        const m = FOR_RE.exec(tok.inner);
        if (m === null) {
          throw new TemplateSyntaxError(`invalid for tag ${JSON.stringify(tok.inner)}`, span, source);
        }
        const itemName = m[1]!;
        const listPath = parsePath(m[2]!.trim(), span, source);
        cursor++;
        const body = parseBlock(new Set(['endfor']), { word: 'for', start: tok.start, end: tok.end });
        const endTok = tokens[cursor];
        if (endTok === undefined || endTok.kind !== 'tag' || endTok.inner !== 'endfor') {
          throw new TemplateSyntaxError('unclosed {% for %}', span, source);
        }
        cursor++;
        nodes.push({ type: 'for', start: tok.start, end: endTok.end, itemName, listPath, body });
        continue;
      }
      if (word === 'else' || word === 'endif' || word === 'endfor') {
        // A closer with no matching opener.
        throw new TemplateSyntaxError(`unexpected {% ${tok.inner} %}`, { start: tok.start, end: tok.end }, source);
      }
      throw new TemplateSyntaxError(`unknown tag ${JSON.stringify(tok.inner)}`, { start: tok.start, end: tok.end }, source);
    }
    if (opener !== null) {
      throw new TemplateSyntaxError(
        `unclosed {% ${opener.word} %}`,
        { start: opener.start, end: opener.end },
        source,
      );
    }
    return nodes;
  }

  return parseBlock(new Set(), null);
}
