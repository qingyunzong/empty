import { readFileSync } from "node:fs";
import { run } from "./cli.js";

process.exitCode = run(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readStdin: () => readFileSync(0, "utf8"),
});
