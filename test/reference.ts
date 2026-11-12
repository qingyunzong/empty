import { ProjectionError } from "../src/errors.ts";
import { appendField, appendIndex, appendStar, parsePath, type PathStep } from "../src/path.ts";
import { MISSING, type Cell, type JsonValue, type ProjectionRow } from "../src/project.ts";
import type { ColumnSpec } from "../src/compile.ts";

/**
 * Explicit-enumeration reference implementation used to cross-check the
 * production projector. It materializes every distinct array-node template,
 * enumerates all index assignments (contexts) level by level, and then
 * evaluates each column path under each assignment.
 */

interface ParsedColumn {
  readonly name: string;
  readonly steps: PathStep[];
}

interface Assignment {
  readonly index: number;
  readonly placeholder: boolean;
}

type Context = Map<number, Assignment>;

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyOf(steps: PathStep[]): string {
  return JSON.stringify(steps);
}

export function referenceProject(
  columns: readonly ColumnSpec[],
  record: JsonValue,
  maxRows?: number,
): ProjectionRow[] {
  const limit = maxRows ?? Number.POSITIVE_INFINITY;
  if (limit !== Number.POSITIVE_INFINITY && (!Number.isInteger(limit) || limit < 0)) {
    throw new ProjectionError(
      "INVALID_OPTION",
      `maxRows must be a non-negative integer, got ${maxRows}`,
    );
  }
  const names = new Set<string>();
  const parsed: ParsedColumn[] = columns.map((column, index) => {
    if (typeof column.name !== "string" || column.name.length === 0) {
      throw new ProjectionError("INVALID_COLUMN", `column #${index} has an empty name`);
    }
    if (names.has(column.name)) {
      throw new ProjectionError("DUPLICATE_COLUMN", `duplicate column name "${column.name}"`);
    }
    names.add(column.name);
    return { name: column.name, steps: parsePath(column.path) };
  });

  // Distinct array templates (path prefixes ending at a [*] step).
  const templates: PathStep[][] = [];
  const templateId = new Map<string, number>();
  for (const column of parsed) {
    for (let i = 0; i < column.steps.length; i++) {
      if (column.steps[i].kind === "array") {
        const prefix = column.steps.slice(0, i + 1);
        const key = keyOf(prefix);
        if (!templateId.has(key)) {
          templateId.set(key, templates.length);
          templates.push(prefix);
        }
      }
    }
  }

  // Field insertion ranks per shared prefix, used to order templates the same
  // way the production trie traverses them (array child first, then fields in
  // first-occurrence order).
  const fieldRank = new Map<string, Map<string, number>>();
  for (const column of parsed) {
    for (let i = 0; i < column.steps.length; i++) {
      const step = column.steps[i];
      if (step.kind !== "field") continue;
      const prefixKey = keyOf(column.steps.slice(0, i));
      let ranks = fieldRank.get(prefixKey);
      if (ranks === undefined) {
        ranks = new Map();
        fieldRank.set(prefixKey, ranks);
      }
      if (!ranks.has(step.name)) ranks.set(step.name, ranks.size);
    }
  }

  const compareTemplates = (a: PathStep[], b: PathStep[]): number => {
    const shared = Math.min(a.length, b.length);
    for (let k = 0; k < shared; k++) {
      const sa = a[k];
      const sb = b[k];
      if (sa.kind === "array" && sb.kind === "array") continue;
      if (sa.kind === "array") return -1;
      if (sb.kind === "array") return 1;
      if (sa.name === sb.name) continue;
      const ranks = fieldRank.get(keyOf(a.slice(0, k)))!;
      return ranks.get(sa.name)! - ranks.get(sb.name)!;
    }
    return a.length - b.length;
  };

  const order = templates
    .map((_, id) => id)
    .sort((x, y) => compareTemplates(templates[x], templates[y]));

  // Resolve the array value for a template under a context; null = placeholder
  // (missing field or empty array along the way).
  const resolveArray = (template: PathStep[], ctx: Context): JsonValue[] | null => {
    let value: JsonValue | typeof MISSING = record;
    for (let i = 0; i < template.length - 1; i++) {
      const step = template[i];
      if (value === MISSING) return null;
      if (step.kind === "field") {
        if (!isPlainObject(value)) {
          throw new ProjectionError(
            "TYPE_MISMATCH",
            `field step "${step.name}" requires an object`,
          );
        }
        value = Object.prototype.hasOwnProperty.call(value, step.name) ? value[step.name] : MISSING;
      } else {
        const assignment = ctx.get(templateId.get(keyOf(template.slice(0, i + 1)))!)!;
        if (assignment.placeholder) return null;
        if (!Array.isArray(value)) {
          throw new ProjectionError("TYPE_MISMATCH", "array expansion requires an array");
        }
        value = value[assignment.index];
      }
    }
    if (value === MISSING) return null;
    if (!Array.isArray(value)) {
      throw new ProjectionError("TYPE_MISMATCH", "array expansion requires an array");
    }
    return value.length === 0 ? null : value;
  };

  // Enumerate contexts level by level; the final context count is the row count.
  let contexts: Context[] = [new Map()];
  for (const id of order) {
    const template = templates[id];
    const next: Context[] = [];
    for (const ctx of contexts) {
      const elements = resolveArray(template, ctx);
      if (elements === null) {
        next.push(new Map(ctx).set(id, { index: 0, placeholder: true }));
      } else {
        for (let index = 0; index < elements.length; index++) {
          next.push(new Map(ctx).set(id, { index, placeholder: false }));
        }
      }
    }
    contexts = next;
    if (contexts.length > limit) {
      throw new ProjectionError("ROW_LIMIT_EXCEEDED", `row limit ${limit} exceeded`);
    }
  }
  if (contexts.length > limit) {
    throw new ProjectionError("ROW_LIMIT_EXCEEDED", `row limit ${limit} exceeded`);
  }

  // Evaluate one column under one context.
  const evalColumn = (column: ParsedColumn, ctx: Context): Cell => {
    let value: JsonValue | typeof MISSING = record;
    let path = "";
    for (let i = 0; i < column.steps.length; i++) {
      const step = column.steps[i];
      if (step.kind === "field") {
        path = appendField(path, step.name);
        if (value === MISSING) continue;
        if (!isPlainObject(value)) {
          throw new ProjectionError(
            "TYPE_MISMATCH",
            `field step "${step.name}" requires an object at "${path}"`,
          );
        }
        value = Object.prototype.hasOwnProperty.call(value, step.name) ? value[step.name] : MISSING;
      } else {
        const assignment = ctx.get(templateId.get(keyOf(column.steps.slice(0, i + 1)))!)!;
        if (assignment.placeholder) {
          path = appendStar(path);
          value = MISSING;
        } else {
          path = appendIndex(path, assignment.index);
          if (value === MISSING) continue;
          if (!Array.isArray(value)) {
            throw new ProjectionError(
              "TYPE_MISMATCH",
              `array expansion requires an array at "${path}"`,
            );
          }
          value = value[assignment.index];
        }
      }
    }
    return { value, path };
  };

  return contexts.map((ctx) => {
    const row: ProjectionRow = {};
    for (const column of parsed) row[column.name] = evalColumn(column, ctx);
    return row;
  });
}
