import { readFileSync } from "node:fs";
import process from "node:process";
import { formatLinkResult, link, verifyFixedPoint, type ModuleSpec } from "./linker.js";

function main(argv: string[]): void {
  const file = argv[2];
  if (!file) {
    console.error("usage: node dist/src/cli.js <graph.json>");
    console.error(
      'graph.json: [{ "id": "a", "exports": [{ "kind": "local", "name": "x", "as": "y" }, { "kind": "reexport", "name": "x", "from": "b" }, { "kind": "star", "from": "c" }] }]',
    );
    process.exitCode = 1;
    return;
  }
  const specs = JSON.parse(readFileSync(file, "utf8")) as ModuleSpec[];
  const result = link(specs);
  console.log(formatLinkResult(result));
  if (!verifyFixedPoint(specs, result)) {
    console.error("error: result is not a fixed point");
    process.exitCode = 1;
  }
}

main(process.argv);
