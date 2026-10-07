import test from "node:test";
import { equal, ok } from "node:assert/strict";
import { analyze, verifyCertificate } from "../src/certificate.ts";
import { createDataset, withdraw } from "../src/dataset.ts";

test("certificate for [1,2] is exact and verifiable", () => {
  const cert = analyze(createDataset([{ id: "a", diff: "1" }, { id: "b", diff: "2" }]));
  equal(cert.statistic, "abs_mean_paired_difference");
  equal(cert.tail, "two_sided_ge_observed");
  equal(cert.totalAssignments, "4");
  equal(cert.tailCount, "2");
  equal(cert.pValue, "1/2");
  equal(cert.observedSum, "3");
  equal(cert.observedAbsMean, "3/2");
  equal(cert.verification.matchesCompressed, true);
  const report = verifyCertificate(cert);
  ok(report.ok, JSON.stringify(report.checks));
});

test("zero differences recorded, single sign", () => {
  const cert = analyze(createDataset([{ id: "z", diff: "0" }, { id: "b", diff: "5" }]));
  equal(cert.zeroCount, 1);
  equal(cert.nonzeroCount, 1);
  equal(cert.totalAssignments, "2");
  equal(cert.pValue, "1");
});

test("groups record repeated-value multiplicities", () => {
  const cert = analyze(
    createDataset([
      { id: "a", diff: "2" },
      { id: "b", diff: "2" },
      { id: "c", diff: "2" },
    ]),
  );
  equal(cert.groups.length, 1);
  equal(cert.groups[0].absValue, "2");
  equal(cert.groups[0].multiplicity, 3);
  equal(cert.totalAssignments, "8");
  equal(cert.tailCount, "2");
});

test("tampered certificate fails verification", () => {
  const cert = analyze(createDataset([{ id: "a", diff: "1" }, { id: "b", diff: "2" }]));
  const forged = { ...cert, tailCount: "3" };
  const report = verifyCertificate(forged);
  equal(report.ok, false);
});

test("withdrawal yields identical results to direct analysis", () => {
  const full = createDataset([
    { id: "a", diff: "1" },
    { id: "b", diff: "2" },
    { id: "c", diff: "3" },
    { id: "d", diff: "4" },
  ]);
  const reduced = withdraw(full, ["a", "d"]);
  const direct = createDataset([{ id: "b", diff: "2" }, { id: "c", diff: "3" }]);
  const certA = analyze(reduced);
  const certB = analyze(direct);
  equal(certA.tailCount, certB.tailCount);
  equal(certA.totalAssignments, certB.totalAssignments);
  equal(certA.pValue, "1/2");
});
