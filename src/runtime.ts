import {
  BudgetExceededError,
  CycleError,
  TemplateError,
} from "./errors";
import type { SourcePosition } from "./errors";
import { parse } from "./parser";
import type { Expr, Node } from "./parser";
import { readOwnField } from "./secure";
import { builtinFilters } from "./filters";
import type { Filter } from "./filters";

export const DEFAULT_MAX_STEPS = 10_000;

export interface RenderOptions {
  /** Total number of loop iterations + filter applications allowed. */
  maxSteps?: number;
  /** Extra filters merged over the built-in ones. */
  filters?: Record<string, Filter>;
}

export type RenderResult =
  | { ok: true; output: string }
  | { ok: false; error: TemplateError };

export interface Template {
  render(data: Record<string, unknown>, options?: RenderOptions): string;
  tryRender(data: Record<string, unknown>, options?: RenderOptions): RenderResult;
}

class Budget {
  private remaining: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new TemplateError("maxSteps must be a non-negative integer");
    }
    this.remaining = limit;
  }

  spend(pos: SourcePosition, what: string): void {
    if (this.remaining <= 0) {
      throw new BudgetExceededError(`step budget exceeded while ${what}`, pos);
    }
    this.remaining -= 1;
  }
}

interface Ctx {
  scopes: Array<Record<string, unknown>>;
  budget: Budget;
  filters: Record<string, Filter>;
}

function lookupVariable(name: string, pos: SourcePosition, ctx: Ctx): unknown {
  for (let i = ctx.scopes.length - 1; i >= 1; i--) {
    const scope = ctx.scopes[i] as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(scope, name)) {
      return scope[name];
    }
  }
  return readOwnField(ctx.scopes[0], name, pos);
}

function evalExpr(expr: Expr, ctx: Ctx): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "path": {
      const [head, ...rest] = expr.segments as [string, ...string[]];
      let value = lookupVariable(head, expr.pos, ctx);
      const chain = new Set<unknown>();
      for (const segment of rest) {
        if (typeof value === "object" && value !== null) {
          if (chain.has(value)) {
            throw new CycleError(
              `cyclic reference while resolving "${expr.segments.join(".")}"`,
              expr.pos
            );
          }
          chain.add(value);
        }
        value = readOwnField(value, segment, expr.pos);
      }
      return value;
    }
    case "filter": {
      const input = evalExpr(expr.input, ctx);
      const fn = Object.prototype.hasOwnProperty.call(ctx.filters, expr.name)
        ? ctx.filters[expr.name]
        : undefined;
      if (typeof fn !== "function") {
        throw new TemplateError(`unknown filter "${expr.name}"`, expr.pos);
      }
      const args = expr.args.map((arg) => evalExpr(arg, ctx));
      ctx.budget.spend(expr.pos, `applying filter "${expr.name}"`);
      try {
        return fn(input, args, expr.pos);
      } catch (error) {
        if (error instanceof TemplateError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new TemplateError(`filter "${expr.name}" failed: ${message}`, expr.pos);
      }
    }
  }
}

function stringifyOutput(value: unknown, pos: SourcePosition): string {
  if (value === null || value === undefined) return "";
  const kind = typeof value;
  if (kind === "string") return value as string;
  if (kind === "number" || kind === "boolean") return String(value);
  throw new TemplateError(
    `cannot render a value of type ${kind} directly; use a filter (e.g. json)`,
    pos
  );
}

function renderNodes(nodes: Node[], ctx: Ctx, out: string[]): void {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out.push(node.value);
        break;
      case "output":
        out.push(stringifyOutput(evalExpr(node.expr, ctx), node.pos));
        break;
      case "if": {
        const branch = evalExpr(node.cond, ctx) ? node.body : node.elseBody;
        renderNodes(branch, ctx, out);
        break;
      }
      case "for": {
        const iterable = evalExpr(node.iterable, ctx);
        if (!Array.isArray(iterable)) {
          throw new TemplateError("for-loop source is not an array", node.pos);
        }
        if (iterable.length === 0) {
          renderNodes(node.elseBody, ctx, out);
          break;
        }
        for (const item of iterable) {
          ctx.budget.spend(node.pos, "running a loop iteration");
          ctx.scopes.push({ [node.varName]: item });
          try {
            renderNodes(node.body, ctx, out);
          } finally {
            ctx.scopes.pop();
          }
        }
        break;
      }
    }
  }
}

function execute(
  nodes: Node[],
  data: Record<string, unknown>,
  options: RenderOptions
): string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new TemplateError("data must be a plain object");
  }
  const ctx: Ctx = {
    scopes: [data],
    budget: new Budget(options.maxSteps ?? DEFAULT_MAX_STEPS),
    filters: options.filters
      ? { ...builtinFilters, ...options.filters }
      : builtinFilters,
  };
  // Render into a private buffer: callers only ever see the fully rendered
  // string. Any error aborts rendering and no partial output is returned.
  const out: string[] = [];
  renderNodes(nodes, ctx, out);
  return out.join("");
}

export function compile(source: string): Template {
  const nodes = parse(source);
  return {
    render: (data, options = {}) => execute(nodes, data, options),
    tryRender: (data, options = {}) => {
      try {
        return { ok: true, output: execute(nodes, data, options) };
      } catch (error) {
        if (error instanceof TemplateError) return { ok: false, error };
        throw error;
      }
    },
  };
}

export function render(
  source: string,
  data: Record<string, unknown>,
  options: RenderOptions = {}
): string {
  return compile(source).render(data, options);
}

export function tryRender(
  source: string,
  data: Record<string, unknown>,
  options: RenderOptions = {}
): RenderResult {
  return compile(source).tryRender(data, options);
}
