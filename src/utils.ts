export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

export function hasOwn(
  value: object,
  key: PropertyKey,
): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Assign without invoking the `__proto__` setter. */
export function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

export function isAbsentValue(value: unknown): boolean {
  return value === undefined;
}

export function cloneValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (isPlainObject(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      setOwn(clone, key, cloneValue(value[key]));
    }
    return clone;
  }
  return value;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left === "number" &&
    typeof right === "number" &&
    Number.isNaN(left) &&
    Number.isNaN(right)
  ) {
    return true;
  }
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left).filter(
      (key) => left[key] !== undefined,
    );
    const rightKeys = Object.keys(right).filter(
      (key) => right[key] !== undefined,
    );
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (!hasOwn(right, key) || !deepEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  return Object.is(left, right);
}

/** Order-independent, type-aware serialization used for list identities. */
export function stableStringify(value: unknown): string {
  const active = new WeakSet<object>();

  const encode = (current: unknown): string => {
    if (current === null) return "null";
    const type = typeof current;
    if (type === "string") return `string:${JSON.stringify(current)}`;
    if (type === "number") {
      return `number:${Object.is(current, -0) ? "-0" : String(current)}`;
    }
    if (type === "boolean") return `boolean:${String(current)}`;
    if (type === "undefined") return "undefined";
    if (type === "bigint") return `bigint:${String(current)}`;
    if (type !== "object") return `${type}:${String(current)}`;

    const object = current as object;
    if (active.has(object)) {
      throw new MergeError("Cannot serialize a cyclic value");
    }
    active.add(object);
    try {
      if (Array.isArray(current)) {
        return `array:[${current.map(encode).join(",")}]`;
      }
      if (isPlainObject(current)) {
        const keys = Object.keys(current)
          .filter((key) => current[key] !== undefined)
          .sort();
        return `object:{${keys
          .map((key) => `${JSON.stringify(key)}:${encode(current[key])}`)
          .join(",")}}`;
      }
      return `object:${Object.prototype.toString.call(current)}`;
    } finally {
      active.delete(object);
    }
  };

  return encode(value);
}

export function assertAcyclic(
  value: unknown,
  label = "value",
): void {
  const active = new WeakSet<object>();

  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    if (active.has(current)) {
      throw new MergeError(`Cyclic ${label} cannot be merged`);
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        for (const item of current) visit(item);
      } else if (isPlainObject(current)) {
        for (const key of Object.keys(current)) {
          if (current[key] !== undefined) visit(current[key]);
        }
      }
    } finally {
      active.delete(current);
    }
  };

  visit(value);
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function decodePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function formatPath(tokens: readonly string[]): string {
  if (tokens.length === 0) return "/";
  return `/${tokens.map(escapePointerToken).join("/")}`;
}

export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function readPathField(
  value: unknown,
  field: string,
): { present: boolean; value?: unknown } {
  let parts: string[];
  if (field.startsWith("/")) {
    parts = field
      .split("/")
      .slice(1)
      .filter(Boolean)
      .map(decodePointerToken);
  } else {
    parts = field.split(".").filter(Boolean);
  }

  let current = value;
  for (const part of parts) {
    if (!isPlainObject(current) || !hasOwn(current, part)) {
      return { present: false };
    }
    current = current[part];
    if (current === undefined) return { present: false };
  }
  return { present: true, value: current };
}

export function parsePathPattern(
  pattern: string | readonly string[],
): string[] {
  if (Array.isArray(pattern)) {
    return pattern.map((part) => String(part)).filter(Boolean);
  }

  let text = String(pattern).trim();
  if (text === "" || text === "$" || text === "/") return [];
  if (text.startsWith("$")) text = text.slice(1);
  if (text.startsWith("/")) {
    return text
      .split("/")
      .slice(1)
      .filter(Boolean)
      .map(decodePointerToken);
  }

  text = text
    .replace(/^\./, "")
    .replace(/\[\s*(?:\*)?\s*\]/g, ".[]")
    .replace(/\[\s*\d+\s*\]/g, ".[]")
    .replace(/\[\s*['"]?([^\]'"]+)['"]?\s*\]/g, ".$1");

  return text.split(".").filter(Boolean);
}

export function matchesPathPattern(
  pattern: readonly string[],
  actual: readonly string[],
): boolean {
  const match = (patternIndex: number, actualIndex: number): boolean => {
    if (patternIndex === pattern.length) {
      return actualIndex === actual.length;
    }
    const token = pattern[patternIndex];
    // Array item markers are structural only. Item selectors are deliberately
    // excluded from the schema path, so `items[].name` and `items.name` match
    // the same logical field.
    if (token === "[]") return match(patternIndex + 1, actualIndex);
    if (token === "**") {
      for (let next = actualIndex; next <= actual.length; next += 1) {
        if (match(patternIndex + 1, next)) return true;
      }
      return false;
    }
    if (actualIndex >= actual.length) return false;
    if (token !== "*" && token !== actual[actualIndex]) return false;
    return match(patternIndex + 1, actualIndex + 1);
  };

  return match(0, 0);
}

export function pathPatternSpecificity(
  pattern: readonly string[],
  actual: readonly string[],
): number {
  if (!matchesPathPattern(pattern, actual)) return -1;
  const meaningful = pattern.filter((token) => token !== "[]");
  if (meaningful.every((token) => token !== "*" && token !== "**")) {
    return 1_000_000 + pattern.length;
  }
  let literals = 0;
  let wildcards = 0;
  for (const token of pattern) {
    if (token === "[]") continue;
    if (token === "*" || token === "**") wildcards += 1;
    else literals += 1;
  }
  return 10_000 + literals * 10 - wildcards;
}
