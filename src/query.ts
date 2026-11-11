import { LocatorQueryError } from "./errors.js";
import type { ComposedNode, LocateQuery } from "./types.js";

export function normalizeQuery(
  query: LocateQuery | string,
  name?: string,
): LocateQuery {
  if (typeof query === "string") {
    if (name !== undefined && typeof name !== "string") {
      throw new LocatorQueryError("Accessible name must be a string.");
    }
    return Object.freeze(
      name === undefined ? { role: query } : { role: query, name },
    );
  }
  if (typeof query !== "object" || query === null) {
    throw new LocatorQueryError("Locate query must be a string or object.");
  }
  if (typeof query.role !== "string") {
    throw new LocatorQueryError("Locate query role must be a string.");
  }
  if (query.name !== undefined && typeof query.name !== "string") {
    throw new LocatorQueryError(
      "Locate query accessible name must be a string when provided.",
    );
  }
  return Object.freeze(
    query.name === undefined
      ? { role: query.role }
      : { role: query.role, name: query.name },
  );
}

export function matchesQuery(node: ComposedNode, query: LocateQuery): boolean {
  return (
    node.role === query.role &&
    (query.name === undefined || node.name === query.name)
  );
}
