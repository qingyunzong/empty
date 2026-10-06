import { readFileSync } from "node:fs";
import process from "node:process";
import { run } from "./app.js";

const result = run(
  process.argv.slice(2),
  () => readFileSync(0, "utf8"),
  (path) => readFileSync(path, "utf8"),
);
if (result.stdout) console.log(result.stdout.replace(/\n$/, ""));
if (result.stderr) console.error(result.stderr.replace(/\n$/, ""));
process.exitCode = result.code;
