import { rat, PiecewiseLinear, simulate, verify, formatReport } from "../src/index.js";

const result = simulate({
  externalTemp: PiecewiseLinear.fromPairs([
    [rat(0), rat(10)],
    [rat(6), rat(16)],
    [rat(12), rat(4)],
  ]),
  heatingRate: PiecewiseLinear.fromPairs([
    [rat(0), rat(2)],
    [rat(12), rat(8)],
  ]),
  onThreshold: rat(8),
  offThreshold: rat(14),
  minOn: rat(1),
  minOff: rat(1),
  initial: { t: rat(0), temp: rat(10), heaterOn: false },
  horizon: rat(12),
});

console.log("== switch events (evidence) ==");
for (const e of result.events) {
  console.log(
    `#${e.index} t=${e.time} ${e.action} temp=${e.temperature} threshold=${e.threshold}` +
      ` reason=${e.reason} ambient=${e.ambientTemp} rate=${e.heatingRate}` +
      ` slope ${e.slopeBefore} -> ${e.slopeAfter} lockedUntil=${e.lockedUntil}`,
  );
}

console.log("\n== trajectory segments ==");
for (const s of result.segments) {
  console.log(
    `[${s.from}, ${s.to}] heater=${s.heaterOn ? "ON " : "OFF"} slope=${s.slope}` +
      ` temp ${s.tempAtFrom} -> ${s.tempAtTo}`,
  );
}

console.log(
  `\nfinal: t=${result.finalState.t} temp=${result.finalState.temp}` +
    ` heater=${result.finalState.heaterOn ? "ON" : "OFF"}`,
);

console.log("\n== independent subdivision verification (k=8) ==");
console.log(formatReport(verify(result, { subdivisions: 8 })));
