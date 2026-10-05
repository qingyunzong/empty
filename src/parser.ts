import { TemplateSyntaxError } from './errors.js';
import type { SourceRange } from './errors.js';

export type Node = TextNode | VarNode | IfNode | EachNode;

export interface TextNode {
  kind: 'text';
  start: number;
  end: number;
}

export interface VarNode {
  kind: 'var';
  path: string;
  start: number;
  end: number;
}

export interface IfNode {
  kind: 'if';
  path: string;
  children: Node[];
  elseChildren: Node[];
  start: number;
  end: number;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

export interface EachNode {
  kind: 'each';
  path: string;
  children: Node[];
  start: number;
  end: number;
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

const PATH_PATTERN = /^(?:this|@index|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

interface Tag {
  start: number;
  end: number;
  content: string;
}

type Item = { kind: 'text'; start: number; end: number } | { kind: 'tag'; tag: Tag };

function tokenize(template: string): Item[] {
  const items: Item[] = [];
  let pos = 0;
  while (pos < template.length) {
    const open = template.indexOf('{{', pos);
    if (open === -1) {
      items.push({ kind: 'text', start: pos, end: template.length });
      break;
    }
    if (open > pos) {
      items.push({ kind: 'text', start: pos, end: open });
    }
    const close = template.indexOf('}}', open + 2);
    if (close === -1) {
      throw new TemplateSyntaxError('Unterminated tag: missing "}}"', template, {
        start: open,
        end: template.length,
      });
    }
    items.push({
      kind: 'tag',
      tag: { start: open, end: close + 2, content: template.slice(open + 2, close).trim() },
    });
    pos = close + 2;
  }
  return items;
}

interface OpenBlock {
  kind: 'if' | 'each';
  path: string;
  openStart: number;
  openEnd: number;
  children: Node[];
  elseChildren: Node[];
  inElse: boolean;
}

export function parse(template: string): Node[] {
  const roots: Node[] = [];
  const stack: OpenBlock[] = [];
  const target = (): Node[] => {
    const top = stack[stack.length - 1];
    if (!top) return roots;
    return top.inElse ? top.elseChildren : top.children;
  };

  for (const item of tokenize(template)) {
    if (item.kind === 'text') {
      target().push({ kind: 'text', start: item.start, end: item.end });
      continue;
    }
    const { tag } = item;
    const range: SourceRange = { start: tag.start, end: tag.end };
    const content = tag.content;

    if (content.startsWith('!')) continue;

    if (content === 'else') {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== 'if') {
        throw new TemplateSyntaxError('"{{else}}" without a matching "{{#if}}"', template, range);
      }
      if (top.inElse) {
        throw new TemplateSyntaxError('Duplicate "{{else}}" in the same "{{#if}}" block', template, range);
      }
      top.inElse = true;
      continue;
    }

    if (content.startsWith('/')) {
      const name = content.slice(1);
      if (name !== 'if' && name !== 'each') {
        throw new TemplateSyntaxError(`Unknown close tag "{{${content}}}"`, template, range);
      }
      const top = stack[stack.length - 1];
      if (!top) {
        throw new TemplateSyntaxError(`Unexpected "{{${content}}}" without a matching open tag`, template, range);
      }
      if (top.kind !== name) {
        const err = new TemplateSyntaxError(
          `Mismatched close tag "{{/${name}}}": expected "{{/${top.kind}}}" to close the block opened at offset ${top.openStart}`,
          template,
          range,
        );
        err.related = { start: top.openStart, end: top.openEnd };
        throw err;
      }
      stack.pop();
      if (top.kind === 'if') {
        target().push({
          kind: 'if',
          path: top.path,
          children: top.children,
          elseChildren: top.elseChildren,
          start: top.openStart,
          end: tag.end,
          openStart: top.openStart,
          openEnd: top.openEnd,
          closeStart: tag.start,
          closeEnd: tag.end,
        });
      } else {
        target().push({
          kind: 'each',
          path: top.path,
          children: top.children,
          start: top.openStart,
          end: tag.end,
          openStart: top.openStart,
          openEnd: top.openEnd,
          closeStart: tag.start,
          closeEnd: tag.end,
        });
      }
      continue;
    }

    if (content.startsWith('#')) {
      const match = /^#(if|each)(?:\s+(.*))?$/.exec(content);
      const path = match && match[2] ? match[2].trim() : '';
      if (!match || !PATH_PATTERN.test(path)) {
        throw new TemplateSyntaxError(`Invalid block tag "{{${content}}}"`, template, range);
      }
      stack.push({
        kind: match[1] as 'if' | 'each',
        path,
        openStart: tag.start,
        openEnd: tag.end,
        children: [],
        elseChildren: [],
        inElse: false,
      });
      continue;
    }

    if (!PATH_PATTERN.test(content)) {
      throw new TemplateSyntaxError(`Invalid variable path "${content}"`, template, range);
    }
    target().push({ kind: 'var', path: content, start: tag.start, end: tag.end });
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) {
    throw new TemplateSyntaxError(
      `Unclosed block: "{{#${unclosed.kind} ${unclosed.path}}}" is never closed`,
      template,
      { start: unclosed.openStart, end: unclosed.openEnd },
    );
  }
  return roots;
}
