import type { Catalog, Expr, RelNode, SelectItem } from "./ast.js";
import {
  AmbiguousColumnError,
  LineageError,
  UnknownColumnError,
  UnknownTableError,
} from "./errors.js";
import { normalizeRel } from "./normalize.js";

export interface SourceColumn {
  table: string;
  column: string;
}

export interface ColumnLineage {
  name: string;
  sources: SourceColumn[];
  path: string[];
}

interface ScopeColumn {
  qualifier: string | null;
  name: string;
  generation: number;
  sources: SourceColumn[];
  path: string[];
}

interface RelResult {
  columns: ScopeColumn[];
  deps: SourceColumn[];
}

interface ExprResult {
  sources: SourceColumn[];
  paths: string[][];
  ops: string[];
}

const AGGREGATE_FUNCTIONS = new Set([
  "sum",
  "avg",
  "count",
  "min",
  "max",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "variance",
  "var_pop",
  "var_samp",
  "string_agg",
  "array_agg",
  "bool_and",
  "bool_or",
  "every",
]);

function sourceKey(s: SourceColumn): string {
  return `${s.table}.${s.column}`;
}

function mergeSources(...lists: readonly SourceColumn[][]): SourceColumn[] {
  const seen = new Map<string, SourceColumn>();
  for (const list of lists) {
    for (const s of list) {
      if (!seen.has(sourceKey(s))) seen.set(sourceKey(s), s);
    }
  }
  return [...seen.values()].sort((a, b) => {
    const ka = sourceKey(a);
    const kb = sourceKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function commonPrefix(paths: readonly string[][]): string[] {
  if (paths.length === 0) return [];
  const first = paths[0];
  let len = first.length;
  for (const p of paths.slice(1)) {
    len = Math.min(len, p.length);
    while (len > 0 && p[len - 1] !== first[len - 1]) len--;
  }
  return first.slice(0, len);
}

function maxGeneration(columns: readonly ScopeColumn[]): number {
  return columns.reduce((m, c) => Math.max(m, c.generation), -1);
}

function exprDisplayName(expr: Expr): string | undefined {
  if (expr.kind === "column") return expr.name;
  return undefined;
}

class Analyzer {
  constructor(private readonly catalog: Catalog) {}

  analyze(node: RelNode, outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>> = []): RelResult {
    switch (node.kind) {
      case "scan":
        return this.analyzeScan(node);
      case "project":
        return this.analyzeProject(node, outerScopes);
      case "filter":
        return this.analyzeFilter(node, outerScopes);
      case "join":
        return this.analyzeJoin(node, outerScopes);
      case "union":
        return this.analyzeUnion(node, outerScopes);
      case "aggregate":
        return this.analyzeAggregate(node, outerScopes);
    }
  }

  private analyzeScan(node: Extract<RelNode, { kind: "scan" }>): RelResult {
    const cols = this.catalog.tables[node.table];
    if (!cols) throw new UnknownTableError(node.table);
    const qualifier = node.alias ?? node.table;
    return {
      columns: cols.map((name) => ({
        qualifier,
        name,
        generation: 0,
        sources: [{ table: node.table, column: name }],
        path: [],
      })),
      deps: [],
    };
  }

  private analyzeProject(
    node: Extract<RelNode, { kind: "project" }>,
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): RelResult {
    const input = this.analyze(node.input, outerScopes);
    const generation = maxGeneration(input.columns) + 1;
    const out: ScopeColumn[] = [];
    node.items.forEach((item, index) => {
      if (item.expr.kind === "star") {
        for (const col of this.expandStar(item.expr, input.columns)) {
          out.push({
            ...col,
            qualifier: null,
            generation,
            path: [...col.path, "project"],
          });
        }
        return;
      }
      const r = this.expr(item.expr, input.columns, outerScopes, false);
      const name = item.alias ?? exprDisplayName(item.expr) ?? `_col${index}`;
      const steps = [...commonPrefix(r.paths), ...r.ops, "project"];
      if (item.alias !== undefined && item.alias !== exprDisplayName(item.expr)) {
        steps.push(`alias:${item.alias}`);
      }
      out.push({
        qualifier: null,
        name,
        generation,
        sources: r.sources,
        path: steps,
      });
    });
    return { columns: out, deps: input.deps };
  }

  private analyzeFilter(
    node: Extract<RelNode, { kind: "filter" }>,
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): RelResult {
    const input = this.analyze(node.input, outerScopes);
    const r = this.expr(node.predicate, input.columns, outerScopes, false);
    return { columns: input.columns, deps: mergeSources(input.deps, r.sources) };
  }

  private analyzeJoin(
    node: Extract<RelNode, { kind: "join" }>,
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): RelResult {
    const left = this.analyze(node.left, outerScopes);
    const right = this.analyze(node.right, outerScopes);
    const scope = [...left.columns, ...right.columns];
    let deps = mergeSources(left.deps, right.deps);
    if (node.on) {
      deps = mergeSources(deps, this.expr(node.on, scope, outerScopes, false).sources);
    }
    const step = `join:${node.joinType}`;
    return {
      columns: scope.map((c) => ({ ...c, path: [...c.path, step] })),
      deps,
    };
  }

  private analyzeUnion(
    node: Extract<RelNode, { kind: "union" }>,
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): RelResult {
    if (node.inputs.length === 0) {
      throw new LineageError("union requires at least one input");
    }
    const branches = node.inputs.map((i) => this.analyze(i, outerScopes));
    const width = branches[0].columns.length;
    for (const b of branches) {
      if (b.columns.length !== width) {
        throw new LineageError(
          `union branch width mismatch: expected ${width}, got ${b.columns.length}`,
        );
      }
    }
    const generation = Math.max(...branches.map((b) => maxGeneration(b.columns))) + 1;
    const columns: ScopeColumn[] = [];
    for (let p = 0; p < width; p++) {
      const perBranch = branches.map((b) => b.columns[p]);
      columns.push({
        qualifier: null,
        name: perBranch[0].name,
        generation,
        sources: mergeSources(...perBranch.map((c) => c.sources)),
        path: [...commonPrefix(perBranch.map((c) => c.path)), "union"],
      });
    }
    return {
      columns,
      deps: mergeSources(...branches.map((b) => b.deps)),
    };
  }

  private analyzeAggregate(
    node: Extract<RelNode, { kind: "aggregate" }>,
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): RelResult {
    const input = this.analyze(node.input, outerScopes);
    const generation = maxGeneration(input.columns) + 1;
    const columns: ScopeColumn[] = [];
    node.groupBy.forEach((item, index) => {
      const r = this.expr(item.expr, input.columns, outerScopes, false);
      columns.push({
        qualifier: null,
        name: item.alias ?? exprDisplayName(item.expr) ?? `_col${index}`,
        generation,
        sources: r.sources,
        path: [...commonPrefix(r.paths), ...r.ops, "group_by"],
      });
    });
    node.aggregates.forEach((item, index) => {
      const r = this.expr(item.expr, input.columns, outerScopes, true);
      columns.push({
        qualifier: null,
        name: item.alias ?? exprDisplayName(item.expr) ?? `_agg${index}`,
        generation,
        sources: r.sources,
        path: [...commonPrefix(r.paths), ...r.ops],
      });
    });
    return { columns, deps: input.deps };
  }

  private expandStar(
    star: Extract<Expr, { kind: "star" }>,
    scope: readonly ScopeColumn[],
  ): ScopeColumn[] {
    const cols =
      star.qualifier === undefined
        ? [...scope]
        : scope.filter((c) => c.qualifier === star.qualifier);
    if (star.qualifier !== undefined && cols.length === 0) {
      throw new UnknownColumnError(`${star.qualifier}.*`);
    }
    return cols.sort((a, b) => a.generation - b.generation);
  }

  private resolveColumn(
    name: string,
    qualifier: string | undefined,
    scopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
  ): ScopeColumn {
    for (const scope of scopes) {
      const matches = scope.filter(
        (c) =>
          c.name === name && (qualifier === undefined || c.qualifier === qualifier),
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new AmbiguousColumnError(
          qualifier === undefined ? name : `${qualifier}.${name}`,
          matches.map((c) => (c.qualifier ? `${c.qualifier}.${c.name}` : c.name)),
        );
      }
    }
    throw new UnknownColumnError(qualifier === undefined ? name : `${qualifier}.${name}`);
  }

  private expr(
    expr: Expr,
    scope: readonly ScopeColumn[],
    outerScopes: ReadonlyArray<ReadonlyArray<ScopeColumn>>,
    inAggregate: boolean,
  ): ExprResult {
    switch (expr.kind) {
      case "column": {
        const col = this.resolveColumn(expr.name, expr.qualifier, [
          scope,
          ...outerScopes,
        ]);
        return { sources: col.sources, paths: [col.path], ops: [] };
      }
      case "star":
        throw new LineageError("star is only allowed as a projection item");
      case "literal":
        return { sources: [], paths: [], ops: [] };
      case "func": {
        const parts = expr.args.map((a) => this.expr(a, scope, outerScopes, false));
        const name = expr.name.toLowerCase();
        const op =
          inAggregate && AGGREGATE_FUNCTIONS.has(name)
            ? `aggregate:${name}`
            : `func:${name}`;
        return this.combine(parts, [op]);
      }
      case "binary": {
        const parts = [
          this.expr(expr.left, scope, outerScopes, inAggregate),
          this.expr(expr.right, scope, outerScopes, inAggregate),
        ];
        return this.combine(parts, [`op:${expr.op}`]);
      }
      case "unary": {
        const parts = [this.expr(expr.operand, scope, outerScopes, inAggregate)];
        return this.combine(parts, [`op:${expr.op}`]);
      }
      case "case": {
        const parts: ExprResult[] = [];
        if (expr.operand) parts.push(this.expr(expr.operand, scope, outerScopes, inAggregate));
        for (const { when, then } of expr.whens) {
          parts.push(this.expr(when, scope, outerScopes, inAggregate));
          parts.push(this.expr(then, scope, outerScopes, inAggregate));
        }
        if (expr.else) parts.push(this.expr(expr.else, scope, outerScopes, inAggregate));
        return this.combine(parts, ["case"]);
      }
      case "window": {
        const parts: ExprResult[] = expr.args.map((a) =>
          this.expr(a, scope, outerScopes, false),
        );
        for (const p of expr.partitionBy ?? []) {
          parts.push(this.expr(p, scope, outerScopes, false));
        }
        for (const o of expr.orderBy ?? []) {
          parts.push(this.expr(o.expr, scope, outerScopes, false));
        }
        return this.combine(parts, [`window:${expr.name.toLowerCase()}`]);
      }
      case "subquery": {
        const res = this.analyze(expr.query, [scope, ...outerScopes]);
        const first = res.columns[0];
        return {
          sources: mergeSources(first ? first.sources : [], res.deps),
          paths: first ? [first.path] : [],
          ops: ["subquery:scalar"],
        };
      }
    }
  }

  private combine(parts: readonly ExprResult[], ops: string[]): ExprResult {
    return {
      sources: mergeSources(...parts.map((p) => p.sources)),
      paths: parts.flatMap((p) => p.paths),
      ops: [...parts.flatMap((p) => p.ops), ...ops],
    };
  }
}

export function analyzeLineage(node: RelNode, catalog: Catalog): ColumnLineage[] {
  const normalized = normalizeRel(node);
  const result = new Analyzer(catalog).analyze(normalized);
  return result.columns.map((c) => ({
    name: c.name,
    sources: mergeSources(c.sources),
    path: c.path,
  }));
}
