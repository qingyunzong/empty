import { TemplateError, type SourcePosition } from './errors.js';
import type { Expr, Node } from './parser.js';
import { resolveFilter, type FilterFn } from './filters.js';

/** Keys that are never readable, even as own properties. */
const BLOCKED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const DEFAULT_MAX_STEPS = 10_000;

export interface RenderOptions {
  /** Shared step budget consumed by loop iterations and filter applications. */
  readonly maxSteps?: number;
  /** Additional filters. Custom filters take precedence over built-ins. */
  readonly filters?: Readonly<Record<string, FilterFn>>;
}

class StepBudget {
  private used = 0;

  constructor(private readonly max: number) {}

  spend(cost: number, what: string, pos: SourcePosition): void {
    this.used += cost;
    if (this.used > this.max) {
      throw new TemplateError('BUDGET_EXCEEDED', `${what} exceeded the step budget of ${this.max}`, pos);
    }
  }
}

type ScopeFrame =
  | { readonly kind: 'root'; readonly value: Record<string, unknown> }
  | { readonly kind: 'var'; readonly name: string; readonly value: unknown };

class Evaluator {
  private readonly budget: StepBudget;
  private readonly frames: ScopeFrame[];

  constructor(data: unknown, private readonly options: RenderOptions) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new TemplateError('TYPE_ERROR', 'render data must be a plain object', { offset: 0, line: 1, column: 1 });
    }
    this.budget = new StepBudget(options.maxSteps ?? DEFAULT_MAX_STEPS);
    this.frames = [{ kind: 'root', value: data as Record<string, unknown> }];
  }

  renderNodes(nodes: readonly Node[], out: string[]): void {
    for (const node of nodes) {
      switch (node.kind) {
        case 'text':
          out.push(node.text);
          break;
        case 'interp':
          out.push(this.toText(this.evalExpr(node.expr), node.pos));
          break;
        case 'if':
          this.renderNodes(isTruthy(this.evalExpr(node.cond)) ? node.body : node.elseBody, out);
          break;
        case 'each': {
          const list = this.evalExpr(node.list);
          if (!Array.isArray(list)) {
            throw new TemplateError('TYPE_ERROR', '"each" expects an array', node.list.pos);
          }
          if (list.length === 0) {
            this.renderNodes(node.elseBody, out);
            break;
          }
          for (const item of list) {
            this.budget.spend(1, 'loop iteration', node.pos);
            this.frames.push({ kind: 'var', name: node.itemName, value: item });
            try {
              this.renderNodes(node.body, out);
            } finally {
              this.frames.pop();
            }
          }
          break;
        }
      }
    }
  }

  private evalExpr(expr: Expr): unknown {
    switch (expr.kind) {
      case 'literal':
        return expr.value;
      case 'ident':
        return this.resolveIdent(expr.name, expr.pos);
      case 'member': {
        const target = this.evalExpr(expr.object);
        return this.readMember(target, expr.key, expr.pos);
      }
      case 'filter': {
        const input = this.evalExpr(expr.input);
        const args = expr.args.map((arg) => this.evalExpr(arg));
        const fn = resolveFilter(expr.name, this.options.filters, expr.pos);
        this.budget.spend(1, `filter "${expr.name}"`, expr.pos);
        try {
          return fn(input, args);
        } catch (error) {
          if (error instanceof TemplateError) throw error;
          throw new TemplateError('TYPE_ERROR', error instanceof Error ? error.message : String(error), expr.pos);
        }
      }
    }
  }

  private resolveIdent(name: string, pos: SourcePosition): unknown {
    if (BLOCKED_KEYS.has(name)) {
      throw new TemplateError('SECURITY_ERROR', `access to "${name}" is forbidden`, pos);
    }
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const frame = this.frames[i]!;
      if (frame.kind === 'var') {
        if (frame.name === name) return frame.value;
      } else if (Object.prototype.hasOwnProperty.call(frame.value, name)) {
        return frame.value[name];
      }
    }
    throw new TemplateError('UNBOUND_IDENTIFIER', `unknown identifier "${name}"`, pos);
  }

  private readMember(target: unknown, key: string | number, pos: SourcePosition): unknown {
    if (typeof key === 'string' && BLOCKED_KEYS.has(key)) {
      throw new TemplateError('SECURITY_ERROR', `access to "${key}" is forbidden`, pos);
    }
    if (target === null || target === undefined) {
      throw new TemplateError('TYPE_ERROR', `cannot read "${String(key)}" of ${target === null ? 'null' : 'undefined'}`, pos);
    }
    if (typeof target === 'function') {
      throw new TemplateError('SECURITY_ERROR', 'member access on functions is forbidden', pos);
    }
    if (typeof target !== 'object' && typeof target !== 'string') {
      throw new TemplateError('SECURITY_ERROR', `member access on ${typeof target} values is forbidden`, pos);
    }
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      throw new TemplateError(
        'SECURITY_ERROR',
        `property "${String(key)}" is not an own property of the value (prototype chain access is forbidden)`,
        pos,
      );
    }
    return (target as Record<string | number, unknown>)[key];
  }

  private toText(value: unknown, pos: SourcePosition): string {
    if (value === null || value === undefined) return '';
    switch (typeof value) {
      case 'string':
        return value;
      case 'number':
      case 'boolean':
      case 'bigint':
        return String(value);
      case 'function':
        throw new TemplateError('SECURITY_ERROR', 'rendering function values is forbidden', pos);
      default:
        throw new TemplateError('TYPE_ERROR', `cannot interpolate a value of type ${Array.isArray(value) ? 'array' : typeof value}`, pos);
    }
  }
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0 || value === '') return false;
  if (typeof value === 'number' && Number.isNaN(value)) return false;
  return true;
}

/**
 * Renders `nodes` into a fresh buffer. Any error aborts the render by
 * throwing, so callers never observe partially rendered output.
 */
export function evaluate(nodes: readonly Node[], data: unknown, options: RenderOptions): string {
  const evaluator = new Evaluator(data, options);
  const out: string[] = [];
  evaluator.renderNodes(nodes, out);
  return out.join('');
}
