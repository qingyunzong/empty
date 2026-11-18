function encodeNumber(value: number): string {
  if (Object.is(value, -0)) return "number:-0";
  if (Number.isNaN(value)) return "number:NaN";
  if (value === Infinity) return "number:Infinity";
  if (value === -Infinity) return "number:-Infinity";
  return `number:${value}`;
}

/**
 * Produces a deterministic representation used for row identities, group keys,
 * and change comparisons. Object members are sorted so that two semantically
 * equal values always receive the same key.
 */
export function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return `boolean:${value}`;
    case "number":
      return encodeNumber(value);
    case "bigint":
      return `bigint:${value.toString()}`;
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "symbol":
      return `symbol:${String(value.description ?? value)}`;
    case "function":
      return `function:${value.name || "anonymous"}`;
    default:
      break;
  }

  const object = value as object;
  if (seen.has(object)) return "circular";
  seen.add(object);

  try {
    if (object instanceof Date) {
      return `date:${Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString()}`;
    }
    if (object instanceof RegExp) return `regexp:${object.toString()}`;
    if (object instanceof Map) {
      const entries = [...object.entries()]
        .map(([key, item]) => `${canonicalize(key, seen)}=>${canonicalize(item, seen)}`)
        .sort();
      return `map:{${entries.join(",")}}`;
    }
    if (object instanceof Set) {
      const entries = [...object.values()].map((item) => canonicalize(item, seen)).sort();
      return `set:{${entries.join(",")}}`;
    }
    if (Array.isArray(object)) {
      return `array:[${object.map((item) => canonicalize(item, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null) {
      const constructorName = (object as { constructor?: { name?: string } }).constructor?.name;
      if (constructorName && constructorName !== "Object") {
        return `${constructorName}:${JSON.stringify(String(object))}`;
      }
    }

    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const members = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`,
    );
    return `object:{${members.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

export function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object" && typeof left !== "function") return false;
  return canonicalize(left) === canonicalize(right);
}

export function normalizeKey(key: unknown): string {
  if (typeof key === "string") return key;
  if (typeof key === "number" || typeof key === "bigint" || typeof key === "boolean") {
    return String(key);
  }
  return canonicalize(key);
}
