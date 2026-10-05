/**
 * Value model for the query engine.
 *
 * A Value is one of: null, boolean, bigint (exact integer), number (float),
 * or string. JSON integer literals are parsed to bigint so integer
 * arithmetic (notably SUM) is exact beyond Number.MAX_SAFE_INTEGER.
 */

export type Value = null | boolean | bigint | number | string;

export type Row = Record<string, Value>;

export type Table = Row[];

export interface Database {
  tables: Record<string, Table>;
}

/**
 * JSON.parse reviver that converts integer literals to bigint using the
 * raw source text (Node >= 21 provides `context.source` for numbers),
 * so large integers keep full precision. Non-integer numbers stay floats.
 */
function exactNumberReviver(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (typeof value === "number" && context && typeof context.source === "string") {
    const src = context.source;
    if (/^-?\d+$/.test(src)) {
      return BigInt(src);
    }
  }
  return value;
}

/** Parse JSON text into engine values (integers become bigint). */
export function parseJson(text: string): unknown {
  return JSON.parse(text, exactNumberReviver);
}

/** Parse a database document: { "tables": { name: [ {col: v, ...}, ... ] } }. */
export function parseDatabase(text: string): Database {
  const doc = parseJson(text) as { tables?: Record<string, Row[]> };
  if (doc === null || typeof doc !== "object" || typeof doc.tables !== "object") {
    throw new Error('database JSON must be an object with a "tables" object');
  }
  const tables: Record<string, Table> = {};
  for (const [name, rows] of Object.entries(doc.tables)) {
    if (!Array.isArray(rows)) {
      throw new Error(`table "${name}" must be an array of row objects`);
    }
    for (const row of rows) {
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`table "${name}" rows must be objects`);
      }
    }
    tables[name] = rows;
  }
  return { tables };
}

/** Type rank for the deterministic total order. */
function rank(v: Value): number {
  if (v === null) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "bigint" || typeof v === "number") return 2;
  return 3; // string
}

/**
 * Deterministic total order over values:
 * null < false < true < numbers (numeric) < strings (code unit order).
 */
export function compareValues(a: Value, b: Value): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (a === null || b === null) return 0;
  if (typeof a === "boolean" && typeof b === "boolean") {
    return (a ? 1 : 0) - (b ? 1 : 0);
  }
  if (
    (typeof a === "bigint" || typeof a === "number") &&
    (typeof b === "bigint" || typeof b === "number")
  ) {
    // Relational operators are defined across bigint/number in JS.
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const sa = a as string;
  const sb = b as string;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Deep structural equality consistent with compareValues (numeric 1n == 1). */
export function valuesEqual(a: Value, b: Value): boolean {
  return compareValues(a, b) === 0;
}

/**
 * Canonical string key for a value, used for hash-based GROUP BY.
 * Integral floats and bigints share a key so 1 and 1n group together.
 */
export function valueKey(v: Value): string {
  if (v === null) return "z";
  if (typeof v === "boolean") return v ? "b1" : "b0";
  if (typeof v === "bigint") return "n" + v.toString();
  if (typeof v === "number") {
    if (Number.isInteger(v) && Number.isSafeInteger(v)) return "n" + v.toString();
    return "f" + v.toString();
  }
  return "s" + JSON.stringify(v);
}

/** Convert a value to a JSON-serializable form (deterministic). */
export function toJsonValue(v: Value): unknown {
  if (typeof v === "bigint") {
    if (v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)) {
      return Number(v);
    }
    return v.toString();
  }
  return v;
}

/** Serialize result rows to deterministic JSON text. */
export function stringifyRows(rows: Row[]): string {
  const out = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      obj[k] = toJsonValue(v);
    }
    return obj;
  });
  return JSON.stringify(out, null, 2);
}
