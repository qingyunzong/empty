import { readFileSync } from "node:fs";
import { SubtitleItem, verifyCertificate } from "./model";
import { solve } from "./solve";

interface InputFile {
  k: number;
  items: SubtitleItem[];
}

function usage(): never {
  console.error(
    "用法: node dist/src/cli.js <input.json> [--correct <id>=<start>:<end>]...\n" +
      "input.json: { \"k\": 层数, \"items\": [{ \"id\", \"start\", \"end\", \"priority\" }] }",
  );
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) usage();
  const path = args[0]!;
  const input = JSON.parse(readFileSync(path, "utf8")) as InputFile;

  const corrections: Array<{ id: string; start: number; end: number }> = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] !== "--correct" || i + 1 >= args.length) usage();
    const m = /^(.+)=(-?[\d.]+):(-?[\d.]+)$/.exec(args[++i]!);
    if (!m) usage();
    corrections.push({ id: m[1]!, start: Number(m[2]), end: Number(m[3]) });
  }

  console.log("=== 原始时码求解 ===");
  printCertificate(solve(input.items, input.k), input.items, input.k);

  if (corrections.length > 0) {
    const fixed = input.items.map((it) => {
      const c = corrections.find((c) => c.id === it.id);
      return c ? { ...it, start: c.start, end: c.end } : it;
    });
    console.log("\n=== 更正时码后重算 ===");
    for (const c of corrections) {
      console.log(`更正 ${c.id}: -> [${c.start}, ${c.end})`);
    }
    printCertificate(solve(fixed, input.k), fixed, input.k);
  }
}

function printCertificate(
  cert: ReturnType<typeof solve>,
  items: SubtitleItem[],
  k: number,
): void {
  verifyCertificate(items, k, cert);
  console.log(`收益: ${cert.profit}`);
  console.log(`选中: [${cert.selected.join(", ")}]`);
  cert.layers.forEach((layer, i) => {
    console.log(`层 ${i}: ${layer.join(" -> ")}`);
  });
  console.log("证书校验: 通过");
}

main();
