/**
 * CLI: reads { "tables": {...}, "query": {...} } as JSON from a file or stdin,
 * prints the result rows as JSON. Integer literals are parsed exactly.
 *
 *   node dist/src/cli.js input.json
 *   cat input.json | node dist/src/cli.js
 */

import { readFileSync } from "node:fs";
import { runQuery } from "./engine.js";
import type { Query, TableInput } from "./types.js";
import { parseJsonExact, toJsonValue } from "./values.js";

function main(): void {
  const arg = process.argv[2];
  const text = arg ? readFileSync(arg, "utf8") : readFileSync(0, "utf8");
  const input = parseJsonExact(text) as {
    tables: Record<string, TableInput>;
    query: Query;
  };
  const rows = runQuery(input.query, input.tables);
  process.stdout.write(`${JSON.stringify(rows, replacer, 2)}\n`);
}

// parseJsonExact already yields bigint-safe structures; the replacer is a
// fallback for bigints produced by aggregation (e.g. sum beyond 2^53).
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? toJsonValue(value) : value;
}

main();
