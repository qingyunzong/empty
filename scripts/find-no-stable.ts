import { buildMarket } from "../src/model";
import { enumerateAllocations } from "../src/enumerate";
import { mulberry32, randomMarketInput } from "../test/helpers";

let best: { seed: number; feasible: number; input: unknown } | null = null;
for (let seed = 1; seed < 50000 && !best; seed++) {
  const rng = mulberry32(seed);
  const input = randomMarketInput(rng, {
    applicants: 3,
    institutions: 2,
    maxCapacity: 2,
    categories: ["X", "Y"],
    categoryProb: 0.6,
    quotaProb: 0.9,
    tieProb: 0,
    acceptProb: 0.85,
  });
  let market;
  try {
    market = buildMarket(input);
  } catch {
    continue;
  }
  if (!market.hasQuotas) continue;
  const result = enumerateAllocations(market);
  if (result.feasibleCount > 1 && result.stableAllocations.length === 0) {
    best = { seed, feasible: result.feasibleCount, input };
  }
}
if (best) {
  console.log(`seed=${best.seed} feasible=${best.feasible}`);
  console.log(JSON.stringify(best.input, null, 2));
} else {
  console.log("no no-stable instance found");
}
