import { readFileSync } from "node:fs";
import process from "node:process";
import { runCli } from "./cliCore.js";

const result = runCli(process.argv.slice(2), (file) =>
  file === null || file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8"),
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
