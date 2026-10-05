import { SecurityError, TemplateError, CycleError } from "./errors";
import type { SourcePosition } from "./errors";

/**
 * Keys that are never readable through templates, even when they exist as
 * own data properties of the input object.
 */
export const DENIED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

/**
 * Reads `key` from `target` only when it is an own, plain data property.
 * Rejects denied keys, prototype-chain properties, accessors (get/set)
 * and function values.
 */
export function readOwnField(
  target: unknown,
  key: string,
  pos: SourcePosition
): unknown {
  if (DENIED_KEYS.has(key)) {
    throw new SecurityError(`access to "${key}" is forbidden`, pos);
  }
  if (target === null || target === undefined) {
    throw new TemplateError(
      `cannot read field "${key}" of ${target === null ? "null" : "undefined"}`,
      pos
    );
  }
  const kind = typeof target;
  if (kind === "function") {
    throw new SecurityError("access to fields of a function is forbidden", pos);
  }
  if (kind !== "object") {
    throw new TemplateError(`a value of type ${kind} has no fields`, pos);
  }
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (desc === undefined) {
    if (key in (target as object)) {
      throw new SecurityError(
        `"${key}" is not an own field (prototype chain access is forbidden)`,
        pos
      );
    }
    throw new TemplateError(`unknown field "${key}"`, pos);
  }
  if ("get" in desc || "set" in desc) {
    throw new SecurityError(`accessor field "${key}" is forbidden`, pos);
  }
  const value = desc.value as unknown;
  if (typeof value === "function") {
    throw new SecurityError(`method "${key}" cannot be accessed`, pos);
  }
  return value;
}

/**
 * JSON serialization that only walks own enumerable data properties and
 * throws CycleError on cyclic references (shared non-cyclic references
 * are allowed).
 */
export function safeStringify(value: unknown, pos: SourcePosition): string {
  const stack = new Set<unknown>();
  const visit = (current: unknown): string => {
    if (current === null) return "null";
    switch (typeof current) {
      case "string":
        return JSON.stringify(current);
      case "number":
      case "boolean":
        return JSON.stringify(current);
      case "object": {
        if (stack.has(current)) {
          throw new CycleError("cyclic object cannot be serialized", pos);
        }
        stack.add(current);
        try {
          if (Array.isArray(current)) {
            const parts: string[] = [];
            for (let index = 0; index < current.length; index++) {
              parts.push(visit(readOwnField(current, String(index), pos)));
            }
            return `[${parts.join(",")}]`;
          }
          const parts: string[] = [];
          for (const key of Object.keys(current)) {
            if (DENIED_KEYS.has(key)) continue;
            parts.push(`${JSON.stringify(key)}:${visit(readOwnField(current, key, pos))}`);
          }
          return `{${parts.join(",")}}`;
        } finally {
          stack.delete(current);
        }
      }
      default:
        throw new TemplateError(
          `a value of type ${typeof current} cannot be serialized`,
          pos
        );
    }
  };
  return visit(value);
}
