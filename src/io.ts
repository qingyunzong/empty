import { readFile } from "node:fs/promises";
import { makeGraph, type SymbolGraph, type SymbolId } from "./graph.ts";

/**
 * On-disk graph format. Input is plain JSON read from the local filesystem
 * only — this library never touches the network.
 */
export interface GraphFile {
  /** Pairs `[referrer, referenced]`. */
  readonly edges: ReadonlyArray<readonly [SymbolId, SymbolId]>;
  /** Public entry-point symbols. */
  readonly entries: readonly SymbolId[];
}

export function parseGraph(json: unknown): SymbolGraph {
  if (typeof json !== "object" || json === null) {
    throw new Error("graph file must contain a JSON object");
  }
  const { edges, entries } = json as Record<string, unknown>;
  if (!Array.isArray(edges) || !Array.isArray(entries)) {
    throw new Error("graph file must have 'edges' and 'entries' arrays");
  }
  for (const edge of edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      typeof edge[0] !== "string" ||
      typeof edge[1] !== "string"
    ) {
      throw new Error("each edge must be a [string, string] pair");
    }
  }
  for (const entry of entries) {
    if (typeof entry !== "string") throw new Error("each entry must be a string");
  }
  return makeGraph(
    edges as ReadonlyArray<readonly [SymbolId, SymbolId]>,
    entries as readonly SymbolId[],
  );
}

export async function loadGraphFile(path: string): Promise<SymbolGraph> {
  const text = await readFile(path, "utf8");
  return parseGraph(JSON.parse(text));
}
