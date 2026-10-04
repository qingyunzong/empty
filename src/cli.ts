import process from "node:process";
import { runCli } from "./app.js";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += String(chunk);
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const stdinText = argv.includes("--stdin") ? await readStdin() : undefined;
  const result = runCli(argv, stdinText);
  if (result.stdout.length > 0) {
    console.log(result.stdout.replace(/\n$/, ""));
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
  process.exitCode = result.exitCode;
}

main().catch((error: unknown) => {
  process.stderr.write(`test-planner: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
