import { ProjectionError } from "./errors.ts";

export type PathStep =
  | { readonly kind: "field"; readonly name: string }
  | { readonly kind: "array" };

/**
 * Parses a projection path such as `items[*].id` or `[*].a` into steps.
 * Field steps are separated by `.`; `[*]` is an array-expansion step and may
 * appear after a `.`, directly after a field name, or at the root.
 */
export function parsePath(path: string): PathStep[] {
  const fail = (): never => {
    throw new ProjectionError("INVALID_PATH", `invalid projection path: ${JSON.stringify(path)}`);
  };
  if (typeof path !== "string" || path.length === 0) fail();
  const steps: PathStep[] = [];
  let i = 0;
  while (i < path.length) {
    if (path.startsWith("[*]", i)) {
      steps.push({ kind: "array" });
      i += 3;
    } else if (path[i] === "[") {
      fail();
    } else {
      let end = i;
      while (end < path.length && path[end] !== "." && path[end] !== "[") end++;
      const name = path.slice(i, end);
      if (name.length === 0) fail();
      steps.push({ kind: "field", name });
      i = end;
    }
    if (i < path.length) {
      if (path[i] === ".") {
        i++;
        if (i === path.length) fail();
      } else if (path[i] !== "[") {
        fail();
      }
    }
  }
  return steps;
}

export function appendField(base: string, name: string): string {
  return base === "" ? name : `${base}.${name}`;
}

export function appendIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

export function appendStar(base: string): string {
  return `${base}[*]`;
}
