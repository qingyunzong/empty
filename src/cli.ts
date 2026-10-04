import { readFileSync } from "node:fs";
import type { Correction, Item } from "./types.js";
import { solve } from "./solver.js";
import { applyCorrections } from "./corrections.js";
import { verifyCertificate } from "./certificate.js";

interface Input {
  k: number;
  items: Item[];
  corrections?: Correction[];
}

const raw = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : readFileSync(0, "utf8");
const input = JSON.parse(raw) as Input;

const solution = solve(input.items, input.k);
const invalid = verifyCertificate(input.items, input.k, solution);
if (invalid) throw new Error(`内部错误：证书校验失败：${invalid}`);

const output: Record<string, unknown> = { solution };
if (input.corrections && input.corrections.length > 0) {
  const correctedItems = applyCorrections(input.items, input.corrections);
  const corrected = solve(correctedItems, input.k);
  const invalidCorrected = verifyCertificate(correctedItems, input.k, corrected);
  if (invalidCorrected) throw new Error(`内部错误：更正后证书校验失败：${invalidCorrected}`);
  output.corrected = corrected;
}
console.log(JSON.stringify(output, null, 2));
