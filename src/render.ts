/**
 * Renderer with per-character provenance.
 *
 * - Substituted values are inserted literally and are NEVER re-parsed:
 *   a value containing "{{" or "{%" stays as-is in the output.
 * - Every output character is attributed to either a slice of the
 *   template source or a slice of a variable's (stringified) value.
 * - maxOutputLength makes the render all-or-nothing: exceeding the
 *   limit throws RenderLimitError and no partial output is produced.
 */

import { Node, parse } from './template.js';

export type Data = Record<string, unknown>;

export type ProvenanceSpan =
  | {
      kind: 'template';
      outStart: number;
      outEnd: number;
      srcStart: number;
      srcEnd: number;
    }
  | {
      kind: 'variable';
      outStart: number;
      outEnd: number;
      name: string;
      iteration: number | null;
      valueStart: number;
      valueEnd: number;
    };

export type CharOrigin =
  | { kind: 'template'; srcIndex: number }
  | { kind: 'variable'; name: string; iteration: number | null; valueIndex: number };

export interface RenderOptions {
  /** Maximum number of output characters; exceeding it fails the whole render. */
  maxOutputLength?: number;
}

export interface RenderResult {
  text: string;
  /** Non-overlapping spans, in order, tiling [0, text.length). */
  spans: ProvenanceSpan[];
  /** Origin of the output character at `index`. */
  originAt(index: number): CharOrigin;
}

export class RenderLimitError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`rendered output exceeded maxOutputLength of ${limit} characters`);
    this.name = 'RenderLimitError';
    this.limit = limit;
  }
}

export class RenderTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderTypeError';
  }
}

interface Scope {
  name: string;
  value: unknown;
  iteration: number;
}

function lookup(path: string[], scopes: readonly Scope[], data: Data): { value: unknown; iteration: number | null } {
  const head = path[0]!;
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.name === head) {
      let value: unknown = scope.value;
      for (let j = 1; j < path.length; j++) {
        value = value !== null && typeof value === 'object'
          ? (value as Record<string, unknown>)[path[j]!]
          : undefined;
      }
      return { value, iteration: scope.iteration };
    }
  }
  let value: unknown = data[head];
  for (let j = 1; j < path.length; j++) {
    value = value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)[path[j]!]
      : undefined;
  }
  return { value, iteration: null };
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  throw new RenderTypeError(`cannot render value of type ${Array.isArray(value) ? 'array' : typeof value}`);
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

export function renderWithProvenance(
  source: string,
  data: Data,
  options: RenderOptions = {},
): RenderResult {
  const nodes = parse(source);
  const limit = options.maxOutputLength ?? Infinity;

  const chunks: string[] = [];
  const spans: ProvenanceSpan[] = [];
  let outLen = 0;

  function emitTemplate(srcStart: number, srcEnd: number): void {
    if (srcEnd <= srcStart) return;
    const text = source.slice(srcStart, srcEnd);
    push(text, { kind: 'template', outStart: outLen, outEnd: outLen + text.length, srcStart, srcEnd });
  }

  function emitVariable(name: string, iteration: number | null, value: string): void {
    if (value.length === 0) return;
    push(value, {
      kind: 'variable',
      outStart: outLen,
      outEnd: outLen + value.length,
      name,
      iteration,
      valueStart: 0,
      valueEnd: value.length,
    });
  }

  function push(text: string, span: ProvenanceSpan): void {
    outLen += text.length;
    if (outLen > limit) {
      // All-or-nothing: the whole render fails, nothing partial escapes.
      throw new RenderLimitError(limit as number);
    }
    chunks.push(text);
    spans.push(span);
  }

  function walk(nodes: Node[], scopes: Scope[]): void {
    for (const node of nodes) {
      switch (node.type) {
        case 'text':
          emitTemplate(node.start, node.end);
          break;
        case 'var': {
          const { value, iteration } = lookup(node.path, scopes, data);
          emitVariable(node.raw, iteration, stringify(value));
          break;
        }
        case 'if': {
          const { value } = lookup(node.cond.path, scopes, data);
          const take = node.cond.negate ? !truthy(value) : truthy(value);
          walk(take ? node.thenBody : node.elseBody, scopes);
          break;
        }
        case 'for': {
          const { value } = lookup(node.listPath, scopes, data);
          if (value === null || value === undefined) break;
          if (!Array.isArray(value)) {
            throw new RenderTypeError(`{% for %}: ${node.listPath.join('.')} is not an array`);
          }
          for (let i = 0; i < value.length; i++) {
            walk(node.body, [...scopes, { name: node.itemName, value: value[i], iteration: i }]);
          }
          break;
        }
      }
    }
  }

  walk(nodes, []);

  const text = chunks.join('');
  return {
    text,
    spans,
    originAt(index: number): CharOrigin {
      if (index < 0 || index >= text.length) {
        throw new RangeError(`index ${index} out of range [0, ${text.length})`);
      }
      // Spans are ordered; binary search.
      let lo = 0;
      let hi = spans.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const span = spans[mid]!;
        if (index < span.outStart) hi = mid - 1;
        else if (index >= span.outEnd) lo = mid + 1;
        else if (span.kind === 'template') {
          return { kind: 'template', srcIndex: span.srcStart + (index - span.outStart) };
        } else {
          return {
            kind: 'variable',
            name: span.name,
            iteration: span.iteration,
            valueIndex: span.valueStart + (index - span.outStart),
          };
        }
      }
      throw new Error(`internal: no span covers output index ${index}`);
    },
  };
}

/** Convenience wrapper: render to plain text only. */
export function render(source: string, data: Data, options: RenderOptions = {}): string {
  return renderWithProvenance(source, data, options).text;
}
