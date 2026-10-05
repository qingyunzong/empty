/**
 * CLI: run a JSON query against a JSON database.
 *
 *   node dist/src/cli.js <db.json> <query.json> [--reference]
 *
 * Prints the result rows as deterministic JSON on stdout.
 */

import { readFileSync } from "node:fs";
import { runQuery } from "./engine.js";
import { runQueryReference } from "./reference.js";
import { parseQuery } from "./query.js";
import { parseDatabase, parseJson, stringifyRows } from "./values.js";

function main(argv: string[]): void {
  const args: string[] = [];
  let useReference = false;
  for (const a of argv) {
    if (a === "--reference") useReference = true;
    else args.push(a);
  }
  if (args.length !== 2) {
    console.error("usage: cli.js <db.json> <query.json> [--reference]");
    process.exit(2);
  }
  const db = parseDatabase(readFileSync(args[0] as string, "utf8"));
  const query = parseQuery(parseJson(readFileSync(args[1] as string, "utf8")));
  const rows = useReference ? runQueryReference(db, query) : runQuery(db, query);
  console.log(stringifyRows(rows));
}

main(process.argv.slice(2));
