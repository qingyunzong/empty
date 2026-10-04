import { readFileSync } from "node:fs";
import { run } from "./app";

const result = run(process.argv.slice(2), () => readFileSync(process.stdin.fd, "utf8"));
if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exitCode = result.code;
