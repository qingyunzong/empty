import { ConversionError } from "./errors.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

/**
 * A custom resource is represented as a JSON object. The conventional
 * `apiVersion`, `kind`, `metadata`, `spec`, and `status` keys are handled by
 * the converter, while all other keys are treated as schema fields.
 */
export type ResourceObject = { [key: string]: JsonValue };

const RESERVED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export interface ResolvedPath {
  readonly path: string;
  readonly segments: readonly string[];
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ConversionError(
      "invalid_object",
      `${label} must be a plain JSON object`,
    );
  }
}

/**
 * Define an own, enumerable data property. This avoids the special behaviour
 * of assigning to `__proto__` and keeps user data from changing prototypes.
 */
export function safeSet(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/**
 * Resolve a dot-separated path. Path segments are deliberately restricted to
 * simple keys: arrays and literal dots inside keys are not supported.
 */
export function resolvePath(path: string, label = "path"): ResolvedPath {
  if (typeof path !== "string" || path.length === 0) {
    throw new ConversionError(
      "invalid_path",
      `${label} must be a non-empty string`,
      { path },
    );
  }
  const segments = path.split(".");
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new ConversionError(
        "invalid_path",
        `${label} contains an empty segment: ${JSON.stringify(path)}`,
        { path },
      );
    }
    if (RESERVED_PATH_SEGMENTS.has(segment)) {
      throw new ConversionError(
        "invalid_path",
        `${label} contains a reserved segment: ${JSON.stringify(path)}`,
        { path, segment },
      );
    }
  }
  return { path, segments: Object.freeze(segments) };
}

export interface PathRead {
  readonly found: boolean;
  readonly value?: JsonValue;
}

/**
 * Read a path, distinguishing "missing" from values such as `0`, `false`,
 * `""`, and `null`. An own property whose value is `undefined` is treated as
 * missing because `undefined` is not a JSON value.
 */
export function readPath(
  root: unknown,
  segments: readonly string[],
): PathRead {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!isPlainObject(current)) {
      if (current === undefined) {
        return { found: false };
      }
      throw new ConversionError(
        "invalid_path_shape",
        `Cannot read "${segments.join(".")}": segment "${segment}" has a non-object parent`,
        { path: segments.join("."), segment },
      );
    }
    if (!hasOwn(current, segment)) {
      return { found: false };
    }
    current = current[segment];
    if (current === undefined) {
      return { found: false };
    }
    if (index < segments.length - 1 && !isPlainObject(current)) {
      throw new ConversionError(
        "invalid_path_shape",
        `Cannot read "${segments.join(".")}": segment "${segment}" is not an object`,
        { path: segments.join("."), segment },
      );
    }
  }
  return { found: true, value: current as JsonValue };
}

export function setPath(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: JsonValue,
): void {
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (!hasOwn(current, segment) || current[segment] === undefined) {
      const child: Record<string, unknown> = {};
      safeSet(current, segment, child);
      current = child;
      continue;
    }
    const next = current[segment];
    if (!isPlainObject(next)) {
      throw new ConversionError(
        "invalid_path_shape",
        `Cannot write "${segments.join(".")}": segment "${segment}" is not an object`,
        { path: segments.join("."), segment },
      );
    }
    current = next;
  }
  safeSet(current, segments[segments.length - 1]!, value);
}

export function deletePath(
  root: Record<string, unknown>,
  segments: readonly string[],
): boolean {
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = current[segments[index]!];
    if (!isPlainObject(next)) {
      return false;
    }
    current = next;
  }
  const last = segments[segments.length - 1]!;
  if (!hasOwn(current, last)) {
    return false;
  }
  delete current[last];
  return true;
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deep-clone a JSON value with recursively sorted object keys. The result is
 * canonical: two semantically equal resources produce byte-identical JSON.
 *
 * `undefined` properties are omitted (matching JSON.stringify); `undefined`
 * array elements, non-finite numbers, functions, symbols, bigints, cycles and
 * non-plain objects are rejected.
 */
export function cloneJson(value: unknown, label = "value"): JsonValue {
  return cloneJsonInner(value, label, new WeakSet<object>());
}

function cloneJsonInner(
  value: unknown,
  label: string,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ConversionError(
          "invalid_json_value",
          `${label} is a non-finite number`,
          { label },
        );
      }
      return value;
    case "undefined":
      throw new ConversionError(
        "invalid_json_value",
        `${label} is undefined`,
        { label },
      );
    case "bigint":
    case "symbol":
    case "function":
      throw new ConversionError(
        "invalid_json_value",
        `${label} is not a JSON value (${typeof value})`,
        { label, type: typeof value },
      );
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new ConversionError(
        "invalid_json_value",
        `${label} contains a cycle`,
        { label },
      );
    }
    seen.add(value);
    const result: JsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index] as unknown;
      if (item === undefined) {
        throw new ConversionError(
          "invalid_json_value",
          `${label}[${index}] is undefined`,
          { label: `${label}[${index}]` },
        );
      }
      result.push(cloneJsonInner(item, `${label}[${index}]`, seen));
    }
    seen.delete(value);
    return result;
  }

  if (!isPlainObject(value)) {
    throw new ConversionError(
      "invalid_json_value",
      `${label} is not a plain JSON object`,
      { label },
    );
  }
  if (seen.has(value)) {
    throw new ConversionError(
      "invalid_json_value",
      `${label} contains a cycle`,
      { label },
    );
  }
  seen.add(value);
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    safeSet(result, key, cloneJsonInner(item, `${label}.${key}`, seen));
  }
  seen.delete(value);
  return result;
}

export function canonicalize(value: unknown, label = "value"): JsonValue {
  return cloneJson(value, label);
}

export function canonicalStringify(value: unknown, label = "value"): string {
  return JSON.stringify(canonicalize(value, label));
}

export function canonicalBytes(value: unknown, label = "value"): Uint8Array {
  return new TextEncoder().encode(canonicalStringify(value, label));
}

export function canonicalEquals(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}

export function deepFreeze<T>(value: T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
