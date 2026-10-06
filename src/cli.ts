import { readFileSync } from "node:fs";
import { link, type ModuleSpec } from "./linker";
import { formatReport } from "./format";

function main(argv: string[]): number {
  const file = argv[2];
  if (!file) {
    process.stderr.write("usage: node dist/src/cli.js <graph.json>\n");
    return 1;
  }
  const modules = JSON.parse(readFileSync(file, "utf8")) as ModuleSpec[];
  const result = link(modules, { trace: true });
  process.stdout.write(formatReport(result, modules.map((m) => m.path)) + "\n");
  return result.diagnostics.length > 0 ? 2 : 0;
}

process.exitCode = main(process.argv);
