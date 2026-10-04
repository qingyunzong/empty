import process from "node:process";
import { verifyDataset, exitCodeFor } from "./verify.js";
import { formatText } from "./report.js";

function main(argv: string[]): number {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    process.stderr.write(
      "usage: verify <dataset-dir> [--json]\n" +
        "expects manifest.jsonl, trajectory.jsonl, filesummary.jsonl\n"
    );
    return 3;
  }
  const report = verifyDataset(dir);
  process.stdout.write(
    json ? JSON.stringify(report, null, 2) + "\n" : formatText(report)
  );
  return exitCodeFor(report);
}

process.exitCode = main(process.argv);
