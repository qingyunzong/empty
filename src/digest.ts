import { createHash } from "node:crypto";

/** Deterministic JSON serialization: object keys sorted recursively. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`,
  );
  return `{${parts.join(",")}}`;
}

/** sha256 hex digest over the canonical form of a delta's content. */
export function computeDigest(
  id: string,
  parents: readonly string[],
  payload: unknown,
): string {
  const canonical = canonicalize({ id, parents: [...parents], payload });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
