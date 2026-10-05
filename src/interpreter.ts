import { TemplateSyntaxError, RenderError, ExpansionLimitError } from './errors.js';
import type { SourceRange } from './errors.js';

interface Scope {
  value: unknown;
  index?: number;
}

interface Ender {
  content: string;
  start: number;
  end: number;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function toText(value: unknown, template: string, range: SourceRange): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'string':
      return value as string;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    default:
      throw new RenderError(
        `Cannot interpolate ${Array.isArray(value) ? 'array' : typeof value} value`,
        template,
        range,
      );
  }
}

export function interpret(template: string, data: unknown, maxOutputLength?: number): string {
  return new Interpreter(template, maxOutputLength ?? Number.MAX_SAFE_INTEGER).run(data);
}

class Interpreter {
  private template: string;
  private limit: number;

  constructor(template: string, limit: number) {
    this.template = template;
    this.limit = limit;
  }

  run(data: unknown): string {
    const result = this.renderRange(0, this.template.length, [{ value: data }]);
    if (result.ender !== null) {
      throw new TemplateSyntaxError(
        `Unexpected "{{${result.ender.content}}}" without a matching open tag`,
        this.template,
        { start: result.ender.start, end: result.ender.end },
      );
    }
    if (result.text.length > this.limit) {
      throw new ExpansionLimitError(this.limit);
    }
    return result.text;
  }

  private renderRange(
    start: number,
    end: number,
    scopes: Scope[],
  ): { pos: number; ender: Ender | null; text: string } {
    let out = '';
    let pos = start;
    while (pos < end) {
      const open = this.template.indexOf('{{', pos);
      if (open === -1 || open >= end) {
        out += this.template.slice(pos, end);
        return { pos: end, ender: null, text: out };
      }
      out += this.template.slice(pos, open);
      const close = this.template.indexOf('}}', open + 2);
      if (close === -1 || close > end) {
        throw new TemplateSyntaxError('Unterminated tag: missing "}}"', this.template, {
          start: open,
          end,
        });
      }
      const content = this.template.slice(open + 2, close).trim();
      const after = close + 2;
      const tagRange: SourceRange = { start: open, end: after };

      if (content.startsWith('!')) {
        pos = after;
        continue;
      }
      if (content === 'else' || content.startsWith('/')) {
        return { pos: after, ender: { content, start: open, end: after }, text: out };
      }

      const block = /^#(if|each)(?:\s+(.*))?$/.exec(content);
      if (block) {
        const path = (block[2] ?? '').trim();
        if (!path) {
          throw new TemplateSyntaxError(`Invalid block tag "{{${content}}}"`, this.template, tagRange);
        }
        if (block[1] === 'if') {
          const taken = truthy(this.lookup(scopes, path, tagRange));
          const first = this.scanBlock(after, 'if', tagRange);
          let posAfter: number;
          if (first.content === 'else') {
            const second = this.scanBlock(first.end, 'if', tagRange);
            out += taken
              ? this.renderRange(after, first.start, scopes).text
              : this.renderRange(first.end, second.start, scopes).text;
            posAfter = second.end;
          } else {
            if (taken) out += this.renderRange(after, first.start, scopes).text;
            posAfter = first.end;
          }
          pos = posAfter;
          continue;
        }
        const list = this.lookup(scopes, path, tagRange);
        let items: unknown[];
        if (list === null) {
          items = [];
        } else if (Array.isArray(list)) {
          items = list;
        } else {
          throw new RenderError(`Cannot iterate non-array value at "${path}"`, this.template, tagRange, path);
        }
        const closeTag = this.scanBlock(after, 'each', tagRange);
        for (let i = 0; i < items.length; i++) {
          const body = this.renderRange(after, closeTag.start, [
            ...scopes,
            { value: items[i], index: i },
          ]);
          if (body.ender !== null) {
            throw new TemplateSyntaxError(
              `Unexpected "{{${body.ender.content}}}" inside "{{#each}}"`,
              this.template,
              { start: body.ender.start, end: body.ender.end },
            );
          }
          out += body.text;
        }
        pos = closeTag.end;
        continue;
      }
      if (content.startsWith('#')) {
        throw new TemplateSyntaxError(`Unknown block tag "{{${content}}}"`, this.template, tagRange);
      }

      out += toText(this.lookup(scopes, content, tagRange), this.template, tagRange);
      pos = after;
    }
    return { pos: end, ender: null, text: out };
  }

  private scanBlock(from: number, kind: 'if' | 'each', openRange: SourceRange): Ender {
    let depth = 1;
    let pos = from;
    while (pos < this.template.length) {
      const open = this.template.indexOf('{{', pos);
      if (open === -1) break;
      const close = this.template.indexOf('}}', open + 2);
      if (close === -1) {
        throw new TemplateSyntaxError('Unterminated tag: missing "}}"', this.template, {
          start: open,
          end: this.template.length,
        });
      }
      const content = this.template.slice(open + 2, close).trim();
      const after = close + 2;
      if (content === `#${kind}` || content.startsWith(`#${kind} `) || content.startsWith(`#${kind}\t`)) {
        depth += 1;
      } else if (content === `/${kind}`) {
        depth -= 1;
        if (depth === 0) return { content, start: open, end: after };
      } else if (kind === 'if' && content === 'else' && depth === 1) {
        return { content, start: open, end: after };
      }
      pos = after;
    }
    throw new TemplateSyntaxError(
      `Unclosed block: "{{#${kind}}}" is never closed`,
      this.template,
      openRange,
    );
  }

  private lookup(scopes: Scope[], path: string, range: SourceRange): unknown {
    const parts = path.split('.');
    const fail = (): never => {
      throw new RenderError(`Undefined variable "${path}"`, this.template, range, path);
    };
    if (parts[0] === '@index' && parts.length === 1) {
      for (let i = scopes.length - 1; i >= 0; i--) {
        if (scopes[i].index !== undefined) return scopes[i].index;
      }
      return fail();
    }
    if (parts[0] === 'this') {
      let value: unknown = scopes[scopes.length - 1].value;
      for (const part of parts.slice(1)) {
        if (value === null || typeof value !== 'object' || !(part in value)) return fail();
        value = (value as Record<string, unknown>)[part];
      }
      return value;
    }
    for (let i = scopes.length - 1; i >= 0; i--) {
      let value: unknown = scopes[i].value;
      if (value === null || typeof value !== 'object' || !(parts[0] in value)) continue;
      value = (value as Record<string, unknown>)[parts[0]];
      let ok = true;
      for (const part of parts.slice(1)) {
        if (value === null || typeof value !== 'object' || !(part in value)) {
          ok = false;
          break;
        }
        value = (value as Record<string, unknown>)[part];
      }
      if (ok) return value;
    }
    return fail();
  }
}
