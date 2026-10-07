export type PathSegment = string | number;

export interface ValidationError {
  path: PathSegment[];
  message: string;
}

export type Schema =
  | { type: "integer" }
  | { type: "object"; properties?: Record<string, Schema>; required?: string[] }
  | { type: "array"; items: Schema }
  | { oneOf: Schema[] }
  | { $ref: string };

export type RootSchema = Schema & { definitions?: Record<string, Schema> };

export type ResolvedSchema = Exclude<Schema, { $ref: string }>;

export function resolveRef(schema: Schema, root: RootSchema): ResolvedSchema {
  let current: Schema = schema;
  const seen = new Set<string>();
  while ("$ref" in current) {
    const ref = current.$ref;
    if (seen.has(ref)) {
      throw new Error(`circular $ref chain at ${ref}`);
    }
    seen.add(ref);
    const match = /^#\/definitions\/(.+)$/.exec(ref);
    const target =
      match && root.definitions ? root.definitions[match[1]!] : undefined;
    if (target === undefined) {
      throw new Error(`unresolvable $ref: ${ref}`);
    }
    current = target;
  }
  return current;
}

// A oneOf/$ref cycle that never descends into the value (e.g.
// `d0 = { oneOf: [..., { $ref: "#/definitions/d0" }] }`) would recurse
// forever, so applying the same schema node to the same value twice along
// one such static chain is rejected as a schema error.
export const NON_PRODUCTIVE_SCHEMA_MESSAGE =
  "non-productive recursive schema: oneOf/$ref cycle at the same value";

export const EMPTY_CHAIN: ReadonlySet<unknown> = new Set();

export function encodePath(path: PathSegment[]): string {
  if (path.length === 0) {
    return "";
  }
  return (
    "/" +
    path
      .map((segment) =>
        String(segment).replace(/~/g, "~0").replace(/\//g, "~1"),
      )
      .join("/")
  );
}

// UTF-8 byte order is identical to code-point order, so comparing encoded
// paths code point by code point yields byte-order sorting without Buffer.
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff !== 0) {
      return diff;
    }
  }
  return left.length - right.length;
}

export function comparePaths(a: PathSegment[], b: PathSegment[]): number {
  return compareCodePoints(encodePath(a), encodePath(b));
}

export function sortErrors(errors: ValidationError[]): ValidationError[] {
  return [...errors].sort((x, y) => {
    const byPath = comparePaths(x.path, y.path);
    if (byPath !== 0) {
      return byPath;
    }
    return x.message < y.message ? -1 : x.message > y.message ? 1 : 0;
  });
}
