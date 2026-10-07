import process from "node:process";
import { main } from "./cli.js";

const io = {
  out(line: string): void {
    process.stdout.write(line + "\n");
  },
  err(line: string): void {
    process.stderr.write(line + "\n");
  },
};

try {
  process.exitCode = main(process.argv.slice(2), io);
} catch (err) {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
}
