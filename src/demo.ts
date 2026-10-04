import { FairAllocator, allocateByUnit, formatReport } from "./index.js";

const allocator = new FairAllocator(13);
allocator
  .addUser({ id: "alpha", demand: 9, weight: 2 })
  .addUser({ id: "beta", demand: 6, weight: 1, cap: 4 })
  .addUser({ id: "gamma", demand: 8, weight: 1 });

console.log("=== initial allocation (capacity 13) ===");
const initial = allocator.allocate();
console.log(formatReport(initial));

console.log();
console.log("=== per-unit reference model ===");
const unit = allocateByUnit(
  [
    { id: "alpha", demand: 9, weight: 2 },
    { id: "beta", demand: 6, weight: 1, cap: 4 },
    { id: "gamma", demand: 8, weight: 1 },
  ],
  13,
);
console.log(`unit-model: ${[...unit.entries()].map(([k, v]) => `${k}=${v}`).join(" ")}`);

console.log();
console.log("=== revoke demand of beta and re-allocate ===");
const after = allocator.revokeDemand("beta");
console.log(formatReport(after));
