// Generates fixtures/demo.json: 20 strategies x 30 samples with a known
// analytical optimum, so test expectations are derived by hand, not by the
// tool itself.
//
// Structure:
//   s01..s05  one-hot group probes (5 groups A..E)
//   s06..s09  one-hot variant probes (4 variants)
//   s10..s13  reformatted replicas of s01, s03, s06, s08 (same equality pattern)
//   s14..s30  constant "noise" probes (distinguish nothing)
// Strategies are (group, variant) combos; (E,3) is dropped and (E,4) appears
// twice (P19/P20), giving exactly one equivalent pair.
//
// Consequences (verified by tests):
//   minimum = 4 group probes + 3 variant probes = 7
//   lexicographically smallest optimum = s01,s02,s03,s04,s06,s07,s08
//   number of optimal subsets = 16 * 12 = 192
const { writeFileSync } = require("node:fs");
const groups = ["A", "B", "C", "D", "E"];
const samples = Array.from({ length: 30 }, (_, i) => `s${String(i + 1).padStart(2, "0")}`);
const combos = [];
for (const g of groups) {
  for (let v = 1; v <= 4; v++) combos.push({ g, v });
}
const kept = combos.filter((c) => !(c.g === "E" && c.v === 3));
kept.push({ g: "E", v: 4 });
const CONSTANTS = [
  0, "n/a", null, true, false, [0], ["x", 1], { reading: 0 }, { nested: { ok: null } },
  -1, 3.14, "idle", [null], { tags: [] }, 7, "", [2, 2],
];
function outputsFor({ g, v }) {
  const gi = groups.indexOf(g);
  const groupOneHot = groups.map((_, k) => (k === gi ? 1 : 0));
  const variantOneHot = [1, 2, 3, 4].map((k) => (k === v ? 1 : 0));
  const yesNo = (bit) => (bit === 1 ? "yes" : "no");
  const out = [...groupOneHot, ...variantOneHot];
  out.push(yesNo(groupOneHot[0]));
  out.push(yesNo(groupOneHot[2]));
  out.push(yesNo(variantOneHot[0]));
  out.push(yesNo(variantOneHot[2]));
  for (const constant of CONSTANTS) out.push(constant);
  return out;
}
const doc = {
  description:
    "20 strategies (5 groups x 4 variants, (E,3) removed, (E,4) duplicated) over 30 candidate samples: 9 one-hot probes, 4 replicas, 17 constant noise probes.",
  samples,
  strategies: kept.map((combo, i) => ({
    id: `P${String(i + 1).padStart(2, "0")}`,
    outputs: outputsFor(combo),
  })),
};
writeFileSync("fixtures/demo.json", JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote fixtures/demo.json: ${doc.strategies.length} strategies x ${samples.length} samples`);
