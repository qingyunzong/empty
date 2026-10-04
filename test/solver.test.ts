import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { loadInstance } from "../src/instance";
import { solve } from "../src/solver";
import { solveDp } from "../src/dp";
import { solveBruteForce } from "../src/brute";
import { buildCertificate, validateCertificate } from "../src/certificate";
import { Instance } from "../src/types";

const small = loadInstance(join(__dirname, "..", "..", "data", "small.json"));
const main = loadInstance(join(__dirname, "..", "..", "data", "instance.json"));

test("small graph: branch-and-bound matches exhaustive route enumeration", () => {
  const exact = solve(small);
  const brute = solveBruteForce(small);
  assert.equal(exact.profit, brute.profit, "profit mismatch vs brute force");
  assert.equal(exact.distance, brute.distance, "distance mismatch vs brute force");
});

test("small graph: subset-DP matches exhaustive route enumeration", () => {
  const dp = solveDp(small);
  const brute = solveBruteForce(small);
  assert.equal(dp.profit, brute.profit);
  assert.equal(dp.distance, brute.distance);
});

test("main 16-station instance: branch-and-bound matches independent subset-DP", () => {
  const exact = solve(main);
  const dp = solveDp(main);
  assert.equal(exact.profit, dp.profit, "profit mismatch vs subset-DP");
  assert.equal(exact.distance, dp.distance, "distance mismatch vs subset-DP");
});

test("certificate: valid, self-consistent, respects windows and limit", () => {
  const solution = solve(main);
  const cert = buildCertificate(main, solution.route);
  const result = validateCertificate(main, cert);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(cert.totalProfit, solution.profit);
  assert.equal(cert.totalDistance, solution.distance);
  assert.equal(cert.totalTime, solution.totalTime);
  assert.ok(cert.returnTime <= main.timeLimit, "must return within the time limit");
  for (const stop of cert.stops) {
    const st = main.stations.find((s) => s.id === stop.station)!;
    assert.ok(stop.serviceStart >= st.open && stop.serviceStart <= st.close, `window of ${st.name}`);
    assert.equal(stop.departure - stop.serviceStart, st.service, `service of ${st.name}`);
    assert.equal(stop.serviceStart - stop.arrival, stop.wait, `wait of ${st.name}`);
  }
});

test("certificate: validator rejects tampered certificates", () => {
  const solution = solve(main);
  const cert = buildCertificate(main, solution.route);

  const badProfit = { ...cert, totalProfit: cert.totalProfit + 1 };
  assert.equal(validateCertificate(main, badProfit).ok, false);

  const badArrival = JSON.parse(JSON.stringify(cert)) as typeof cert;
  badArrival.stops[0]!.arrival += 1;
  assert.equal(validateCertificate(main, badArrival).ok, false);

  const badTime = { ...cert, returnTime: cert.returnTime - 1 };
  assert.equal(validateCertificate(main, badTime).ok, false);
});

test("certificate: infeasible routes are rejected at build time", () => {
  // route that visits a station after its window closes: S03 closes at 20,
  // going BASE -> S12 -> S08 -> S03 cannot make it (checked against real matrix)
  const solution = solve(small);
  assert.ok(solution.profit > 0);
  assert.throws(() => buildCertificate(small, [2, 5, 3, 1, 4, 6, 2]), /twice|window|unknown/);
});

test("degenerate instances: no reachable station yields the empty route", () => {
  const tight: Instance = {
    name: "tight",
    depot: 0,
    timeLimit: 4,
    stations: [
      { id: 0, name: "BASE", x: 0, y: 0, service: 0, open: 0, close: 4, profit: 0 },
      { id: 1, name: "FAR", x: 10, y: 0, service: 1, open: 0, close: 60, profit: 5 },
    ],
  };
  const solution = solve(tight);
  assert.equal(solution.profit, 0);
  assert.deepEqual(solution.route, []);
  const cert = buildCertificate(tight, solution.route);
  assert.equal(validateCertificate(tight, cert).ok, true);
  assert.equal(cert.totalTime, 0);
});
