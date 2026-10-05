import { parseArgs } from "node:util";
import { analyzeImpact } from "./impact.ts";
import { loadGraphFile } from "./io.ts";

const { values } = parseArgs({
  options: {
    old: { type: "string" },
    new: { type: "string" },
  },
});

if (!values.old || !values.new) {
  console.error("usage: node src/cli.ts --old old-graph.json --new new-graph.json");
  process.exit(2);
}

const [oldGraph, newGraph] = await Promise.all([
  loadGraphFile(values.old),
  loadGraphFile(values.new),
]);

const report = analyzeImpact(oldGraph, newGraph);

console.log(`changed symbols: ${[...report.changed].sort().join(", ") || "(none)"}`);
for (const [entry, impact] of [...report.byEntry].sort()) {
  console.log(`entry ${entry}: ${impact.chain.join(" -> ")}`);
}
for (const entry of report.unaffectedEntries) {
  console.log(`entry ${entry}: unaffected`);
}
