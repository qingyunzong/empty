import { parse } from './parser.js';
import type { Node } from './parser.js';
import { RenderError, ExpansionLimitError } from './errors.js';
import type { SourceRange } from './errors.js';

export interface TemplateSpan {
  kind: 'template';
  start: number;
  end: number;
}

export interface VariableSpan {
  kind: 'variable';
  path: string;
  start: number;
  end: number;
}

export type SourceSpan = TemplateSpan | VariableSpan;

export interface Segment {
  text: string;
  source: SourceSpan;
}

export interface RenderResult {
  output: string;
  segments: Segment[];
}

export interface RenderOptions {
  maxOutputLength?: number;
}

interface Frame {
  value: unknown;
  path: string;
  index?: number;
}

interface Resolved {
  value: unknown;
  path: string;
}

function lookupProperty(value: unknown, key: string): { found: boolean; value: unknown } {
  if (value !== null && typeof value === 'object' && key in value) {
    return { found: true, value: (value as Record<string, unknown>)[key] };
  }
  return { found: false, value: undefined };
}

function resolvePath(frames: Frame[], path: string): Resolved | undefined {
  const parts = path.split('.');
  if (parts[0] === '@index') {
    if (parts.length !== 1) return undefined;
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.index !== undefined) {
        return { value: frame.index, path: `${frame.path}.@index` };
      }
    }
    return undefined;
  }
  if (parts[0] === 'this') {
    const top = frames[frames.length - 1];
    let value = top.value;
    let resolved = top.path;
    for (const part of parts.slice(1)) {
      const hit = lookupProperty(value, part);
      if (!hit.found) return undefined;
      value = hit.value;
      resolved += `.${part}`;
    }
    return { value, path: resolved };
  }
  for (let i = frames.length - 1; i >= 0; i--) {
    const first = lookupProperty(frames[i].value, parts[0]);
    if (!first.found) continue;
    let value = first.value;
    let resolved = frames[i].path ? `${frames[i].path}.${parts[0]}` : parts[0];
    let ok = true;
    for (const part of parts.slice(1)) {
      const hit = lookupProperty(value, part);
      if (!hit.found) {
        ok = false;
        break;
      }
      value = hit.value;
      resolved += `.${part}`;
    }
    if (ok) return { value, path: resolved };
  }
  return undefined;
}

function isTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

class Renderer {
  private template: string;
  private limit: number;
  private segments: Segment[] = [];
  private length = 0;

  constructor(template: string, limit: number) {
    this.template = template;
    this.limit = limit;
  }

  run(nodes: Node[], data: unknown): RenderResult {
    this.renderNodes(nodes, [{ value: data, path: '' }]);
    return { output: this.segments.map((s) => s.text).join(''), segments: this.segments };
  }

  private renderNodes(nodes: Node[], frames: Frame[]): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          this.pushTemplate(node.start, node.end);
          break;
        case 'var': {
          const resolved = this.resolve(frames, node.path, node);
          this.pushVariable(this.stringify(resolved.value, node), resolved.path);
          break;
        }
        case 'if': {
          const resolved = this.resolve(frames, node.path, node);
          this.renderNodes(isTruthy(resolved.value) ? node.children : node.elseChildren, frames);
          break;
        }
        case 'each': {
          const resolved = this.resolve(frames, node.path, node);
          if (resolved.value === null) break;
          if (!Array.isArray(resolved.value)) {
            throw new RenderError(
              `Cannot iterate non-array value at "${node.path}"`,
              this.template,
              node,
              node.path,
            );
          }
          for (let i = 0; i < resolved.value.length; i++) {
            frames.push({ value: resolved.value[i], path: `${resolved.path}[${i}]`, index: i });
            this.renderNodes(node.children, frames);
            frames.pop();
          }
          break;
        }
      }
    }
  }

  private resolve(frames: Frame[], path: string, range: SourceRange): Resolved {
    const resolved = resolvePath(frames, path);
    if (!resolved) {
      throw new RenderError(`Undefined variable "${path}"`, this.template, range, path);
    }
    return resolved;
  }

  private stringify(value: unknown, range: SourceRange): string {
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
          this.template,
          range,
        );
    }
  }

  private pushTemplate(start: number, end: number): void {
    if (start === end) return;
    this.append(this.template.slice(start, end), { kind: 'template', start, end });
  }

  private pushVariable(text: string, path: string): void {
    if (text.length === 0) return;
    this.append(text, { kind: 'variable', path, start: 0, end: text.length });
  }

  private append(text: string, source: SourceSpan): void {
    this.length += text.length;
    if (this.length > this.limit) {
      throw new ExpansionLimitError(this.limit);
    }
    this.segments.push({ text, source });
  }
}

export function render(template: string, data: unknown, options: RenderOptions = {}): RenderResult {
  const nodes = parse(template);
  const limit = options.maxOutputLength ?? Number.MAX_SAFE_INTEGER;
  return new Renderer(template, limit).run(nodes, data);
}
