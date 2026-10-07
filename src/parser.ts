import { SourceMap, TemplateError, type SourcePosition } from './errors.js';

export type Expr =
  | { readonly kind: 'ident'; readonly name: string; readonly pos: SourcePosition }
  | { readonly kind: 'literal'; readonly value: string | number | boolean | null; readonly pos: SourcePosition }
  | { readonly kind: 'member'; readonly object: Expr; readonly key: string | number; readonly pos: SourcePosition }
  | { readonly kind: 'filter'; readonly name: string; readonly args: readonly Expr[]; readonly input: Expr; readonly pos: SourcePosition };

export type Node =
  | { readonly kind: 'text'; readonly text: string; readonly pos: SourcePosition }
  | { readonly kind: 'interp'; readonly expr: Expr; readonly pos: SourcePosition }
  | { readonly kind: 'each'; readonly list: Expr; readonly itemName: string; readonly body: readonly Node[]; readonly elseBody: readonly Node[]; readonly pos: SourcePosition }
  | { readonly kind: 'if'; readonly cond: Expr; readonly body: readonly Node[]; readonly elseBody: readonly Node[]; readonly pos: SourcePosition };

// ---------- template-level lexer ----------

interface Tag {
  /** Trimmed inner content of the tag. */
  readonly content: string;
  /** Offset of the first character of `content` in the source. */
  readonly contentOffset: number;
  /** Offset of the opening `{{`. */
  readonly pos: SourcePosition;
}

type LexItem = { readonly kind: 'text'; readonly text: string; readonly pos: SourcePosition } | { readonly kind: 'tag'; readonly tag: Tag };

function lex(source: SourceMap): LexItem[] {
  const items: LexItem[] = [];
  const text = source.text;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('{{', cursor);
    if (open === -1) {
      items.push({ kind: 'text', text: text.slice(cursor), pos: source.positionAt(cursor) });
      break;
    }
    if (open > cursor) {
      items.push({ kind: 'text', text: text.slice(cursor, open), pos: source.positionAt(cursor) });
    }
    const close = text.indexOf('}}', open + 2);
    if (close === -1) {
      throw new TemplateError('SYNTAX_ERROR', 'unclosed tag: missing "}}"', source.positionAt(open));
    }
    const rawInner = text.slice(open + 2, close);
    const leadingWs = rawInner.length - rawInner.trimStart().length;
    items.push({
      kind: 'tag',
      tag: {
        content: rawInner.trim(),
        contentOffset: open + 2 + leadingWs,
        pos: source.positionAt(open),
      },
    });
    cursor = close + 2;
  }
  return items;
}

// ---------- expression-level lexer ----------

interface ExprToken {
  readonly type: 'ident' | 'number' | 'string' | 'punct';
  readonly value: string;
  readonly pos: SourcePosition;
}

const PUNCT = new Set(['.', '|', '(', ')', ',', '[', ']']);

function lexExpr(source: SourceMap, content: string, baseOffset: number): ExprToken[] {
  const tokens: ExprToken[] = [];
  let i = 0;
  const pos = (local: number): SourcePosition => source.positionAt(baseOffset + local);
  while (i < content.length) {
    const ch = content[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < content.length && /[A-Za-z0-9_$]/.test(content[j]!)) j++;
      tokens.push({ type: 'ident', value: content.slice(i, j), pos: pos(i) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < content.length && /[0-9.]/.test(content[j]!)) j++;
      const raw = content.slice(i, j);
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new TemplateError('SYNTAX_ERROR', `invalid number literal "${raw}"`, pos(i));
      }
      tokens.push({ type: 'number', value: raw, pos: pos(i) });
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < content.length) {
        const c = content[j]!;
        if (c === '\\' && j + 1 < content.length) {
          const esc = content[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          j++;
          break;
        }
        out += c;
        j++;
      }
      if (!closed) {
        throw new TemplateError('SYNTAX_ERROR', 'unterminated string literal', pos(i));
      }
      tokens.push({ type: 'string', value: out, pos: pos(i) });
      i = j;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: pos(i) });
      i++;
      continue;
    }
    throw new TemplateError('SYNTAX_ERROR', `unexpected character "${ch}"`, pos(i));
  }
  return tokens;
}

// ---------- expression parser ----------

class ExprParser {
  private cursor = 0;

  constructor(private readonly tokens: ExprToken[]) {}

  get done(): boolean {
    return this.cursor >= this.tokens.length;
  }

  peek(): ExprToken | undefined {
    return this.tokens[this.cursor];
  }

  next(): ExprToken {
    const token = this.tokens[this.cursor];
    if (!token) throw new TemplateError('SYNTAX_ERROR', 'unexpected end of expression', this.tokens[this.tokens.length - 1]?.pos ?? { offset: 0, line: 1, column: 1 });
    this.cursor++;
    return token;
  }

  expectPunct(value: string): ExprToken {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new TemplateError('SYNTAX_ERROR', `expected "${value}" but found "${token.value}"`, token.pos);
    }
    return token;
  }

  expectIdent(): ExprToken {
    const token = this.next();
    if (token.type !== 'ident') {
      throw new TemplateError('SYNTAX_ERROR', `expected an identifier but found "${token.value}"`, token.pos);
    }
    return token;
  }

  /** expr := postfix ( '|' filterName [ '(' args ')' ] )* */
  parseExpr(): Expr {
    let expr = this.parsePostfix();
    while (this.peek()?.type === 'punct' && this.peek()!.value === '|') {
      this.next();
      const name = this.expectIdent();
      const args: Expr[] = [];
      if (this.peek()?.type === 'punct' && this.peek()!.value === '(') {
        this.next();
        if (!(this.peek()?.type === 'punct' && this.peek()!.value === ')')) {
          for (;;) {
            args.push(this.parseExpr());
            const sep = this.next();
            if (sep.type === 'punct' && sep.value === ',') continue;
            if (sep.type === 'punct' && sep.value === ')') break;
            throw new TemplateError('SYNTAX_ERROR', `expected "," or ")" but found "${sep.value}"`, sep.pos);
          }
        } else {
          this.next();
        }
      }
      expr = { kind: 'filter', name: name.value, args, input: expr, pos: name.pos };
    }
    return expr;
  }

  /** postfix := primary ( '.' ident | '[' (number|string) ']' )* */
  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      const token = this.peek();
      if (!token || token.type !== 'punct') break;
      if (token.value === '.') {
        this.next();
        const key = this.expectIdent();
        expr = { kind: 'member', object: expr, key: key.value, pos: key.pos };
        continue;
      }
      if (token.value === '[') {
        this.next();
        const key = this.next();
        if (key.type !== 'number' && key.type !== 'string') {
          throw new TemplateError('SYNTAX_ERROR', 'expected a number or string index', key.pos);
        }
        this.expectPunct(']');
        expr = { kind: 'member', object: expr, key: key.type === 'number' ? Number(key.value) : key.value, pos: key.pos };
        continue;
      }
      break;
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const token = this.next();
    if (token.type === 'number') return { kind: 'literal', value: Number(token.value), pos: token.pos };
    if (token.type === 'string') return { kind: 'literal', value: token.value, pos: token.pos };
    if (token.type === 'ident') {
      if (token.value === 'true') return { kind: 'literal', value: true, pos: token.pos };
      if (token.value === 'false') return { kind: 'literal', value: false, pos: token.pos };
      if (token.value === 'null') return { kind: 'literal', value: null, pos: token.pos };
      return { kind: 'ident', name: token.value, pos: token.pos };
    }
    if (token.type === 'punct' && token.value === '(') {
      const inner = this.parseExpr();
      this.expectPunct(')');
      return inner;
    }
    throw new TemplateError('SYNTAX_ERROR', `unexpected token "${token.value}"`, token.pos);
  }
}

// ---------- node parser ----------

const SECTION_KINDS = new Set(['each', 'if']);

export function parseTemplate(text: string): readonly Node[] {
  const source = new SourceMap(text);
  const items = lex(source);
  const [nodes, index, closer] = parseNodes(source, items, 0, null);
  if (closer) {
    throw new TemplateError('SYNTAX_ERROR', `unexpected closing tag "{{/${closer}}}" without a matching opener`, items[index]!.kind === 'tag' ? items[index]!.tag.pos : source.positionAt(0));
  }
  return nodes;
}

function parseNodes(
  source: SourceMap,
  items: LexItem[],
  start: number,
  section: { readonly kind: 'each' | 'if'; readonly openPos: SourcePosition } | null,
): [readonly Node[], number, string | null] {
  const nodes: Node[] = [];
  let i = start;
  while (i < items.length) {
    const item = items[i]!;
    if (item.kind === 'text') {
      nodes.push({ kind: 'text', text: item.text, pos: item.pos });
      i++;
      continue;
    }
    const { content, contentOffset, pos } = item.tag;
    if (content.startsWith('/')) {
      const name = content.slice(1).trim();
      if (!SECTION_KINDS.has(name)) {
        throw new TemplateError('SYNTAX_ERROR', `unknown closing tag "{{/${name}}}"`, pos);
      }
      if (section === null || section.kind !== name) {
        throw new TemplateError('SYNTAX_ERROR', `closing tag "{{/${name}}}" does not match the current section`, pos);
      }
      return [nodes, i, name];
    }
    if (content === 'else') {
      if (section === null) {
        throw new TemplateError('SYNTAX_ERROR', '"{{else}}" outside of any section', pos);
      }
      return [nodes, i, 'else'];
    }
    if (content.startsWith('#')) {
      const head = content.slice(1).trimStart();
      const headOffset = contentOffset + (content.length - content.slice(1).trimStart().length);
      if (head.startsWith('each ') || head === 'each') {
        const parser = new ExprParser(lexExpr(source, head.slice(4).trim(), headOffset + 4 + (head.slice(4).length - head.slice(4).trimStart().length)));
        const list = parser.parseExpr();
        const asToken = parser.expectIdent();
        if (asToken.value !== 'as') {
          throw new TemplateError('SYNTAX_ERROR', `expected "as" in each-section but found "${asToken.value}"`, asToken.pos);
        }
        const itemName = parser.expectIdent().value;
        if (!parser.done) {
          throw new TemplateError('SYNTAX_ERROR', 'unexpected trailing tokens in each-section', parser.peek()!.pos);
        }
        const [body, next, closer] = parseNodes(source, items, i + 1, { kind: 'each', openPos: pos });
        let elseBody: readonly Node[] = [];
        let end = next;
        if (closer === 'else') {
          const [els, afterElse, elseCloser] = parseNodes(source, items, next + 1, { kind: 'each', openPos: pos });
          elseBody = els;
          end = afterElse;
          if (elseCloser !== 'each') throwUnclosed(source, pos);
        } else if (closer !== 'each') {
          throwUnclosed(source, pos);
        }
        nodes.push({ kind: 'each', list, itemName, body, elseBody, pos });
        i = end + 1;
        continue;
      }
      if (head.startsWith('if ') || head === 'if') {
        const parser = new ExprParser(lexExpr(source, head.slice(2).trim(), headOffset + 2 + (head.slice(2).length - head.slice(2).trimStart().length)));
        const cond = parser.parseExpr();
        if (!parser.done) {
          throw new TemplateError('SYNTAX_ERROR', 'unexpected trailing tokens in if-section', parser.peek()!.pos);
        }
        const [body, next, closer] = parseNodes(source, items, i + 1, { kind: 'if', openPos: pos });
        let elseBody: readonly Node[] = [];
        let end = next;
        if (closer === 'else') {
          const [els, afterElse, elseCloser] = parseNodes(source, items, next + 1, { kind: 'if', openPos: pos });
          elseBody = els;
          end = afterElse;
          if (elseCloser !== 'if') throwUnclosed(source, pos);
        } else if (closer !== 'if') {
          throwUnclosed(source, pos);
        }
        nodes.push({ kind: 'if', cond, body, elseBody, pos });
        i = end + 1;
        continue;
      }
      throw new TemplateError('SYNTAX_ERROR', `unknown section "${head.split(/\s/)[0] ?? head}"`, pos);
    }
    if (content === '') {
      throw new TemplateError('SYNTAX_ERROR', 'empty tag', pos);
    }
    const parser = new ExprParser(lexExpr(source, content, contentOffset));
    const expr = parser.parseExpr();
    if (!parser.done) {
      throw new TemplateError('SYNTAX_ERROR', `unexpected trailing token "${parser.peek()!.value}"`, parser.peek()!.pos);
    }
    nodes.push({ kind: 'interp', expr, pos });
    i++;
  }
  if (section !== null) {
    throwUnclosed(source, section.openPos);
  }
  return [nodes, i, null];
}

function throwUnclosed(source: SourceMap, openPos: SourcePosition): never {
  throw new TemplateError('SYNTAX_ERROR', 'section is never closed', openPos);
}
