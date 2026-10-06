import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_APPLICANTS,
  MAX_INSTITUTIONS,
  MarketInput,
  buildMarket,
  checkMembers,
  quotaCounts,
} from "../src/model";

test("ties in preference lists are broken by fixed id order", () => {
  const market = buildMarket({
    applicants: [{ id: "a1", prefs: [["i2", "i1"], "i3"] }],
    institutions: [
      { id: "i1", capacity: 1, prefs: [] },
      { id: "i2", capacity: 1, prefs: [] },
      { id: "i3", capacity: 1, prefs: [] },
    ],
  });
  assert.deepEqual(market.applicants[0]!.strictPrefs, ["i1", "i2", "i3"]);
});

test("institution-side ties are broken by applicant id", () => {
  const market = buildMarket({
    applicants: [
      { id: "a2", prefs: ["i1"] },
      { id: "a1", prefs: ["i1"] },
    ],
    institutions: [{ id: "i1", capacity: 2, prefs: [["a2", "a1"]] }],
  });
  assert.deepEqual(market.institutions[0]!.strictPrefs, ["a1", "a2"]);
});

test("unlisted pairs are unacceptable", () => {
  const market = buildMarket({
    applicants: [{ id: "a1", prefs: ["i1"] }],
    institutions: [
      { id: "i1", capacity: 1, prefs: ["a1"] },
      { id: "i2", capacity: 1, prefs: ["a1"] },
    ],
  });
  const a1 = market.applicantById.get("a1")!;
  const i2 = market.institutionById.get("i2")!;
  assert.equal(a1.rankOf.has("i2"), false);
  assert.equal(i2.rankOf.has("a1"), true);
  const i1 = market.institutionById.get("i1")!;
  assert.equal(i1.rankOf.has("a1"), true);
});

test("size limits: at most 10 applicants and 6 institutions", () => {
  const manyApplicants = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, prefs: [] }));
  const manyInstitutions = (n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, capacity: 1, prefs: [] }));
  assert.throws(() =>
    buildMarket({ applicants: manyApplicants(MAX_APPLICANTS + 1, "a"), institutions: [] }),
  );
  assert.throws(() =>
    buildMarket({ applicants: [], institutions: manyInstitutions(MAX_INSTITUTIONS + 1, "i") }),
  );
  // exactly at the limit is accepted
  buildMarket({
    applicants: manyApplicants(MAX_APPLICANTS, "a"),
    institutions: manyInstitutions(MAX_INSTITUTIONS, "i"),
  });
});

test("input validation rejects malformed markets", () => {
  const base: MarketInput = {
    applicants: [{ id: "a1", prefs: ["i1"] }],
    institutions: [{ id: "i1", capacity: 1, prefs: ["a1"] }],
  };
  assert.throws(() =>
    buildMarket({ applicants: [base.applicants[0]!, base.applicants[0]!], institutions: base.institutions }),
  );
  assert.throws(() =>
    buildMarket({ applicants: [{ id: "a1", prefs: ["nope"] }], institutions: base.institutions }),
  );
  assert.throws(() =>
    buildMarket({ applicants: [{ id: "a1", prefs: ["i1", ["i1"]] }], institutions: base.institutions }),
  );
  assert.throws(() =>
    buildMarket({ applicants: [{ id: "a1", prefs: [[]] }], institutions: base.institutions }),
  );
  assert.throws(() =>
    buildMarket({
      applicants: base.applicants,
      institutions: [{ id: "i1", capacity: -1, prefs: ["a1"] }],
    }),
  );
  assert.throws(() =>
    buildMarket({
      applicants: base.applicants,
      institutions: [
        { id: "i1", capacity: 1, quotas: [{ category: "X", quota: 1 }, { category: "X", quota: 2 }], prefs: ["a1"] },
      ],
    }),
  );
});

test("nested quota counting: multi-category applicants count toward every matching node", () => {
  const market = buildMarket({
    applicants: [
      { id: "a1", categories: ["X", "Y"], prefs: ["i1"] },
      { id: "a2", categories: ["Y"], prefs: ["i1"] },
      { id: "a3", categories: [], prefs: ["i1"] },
    ],
    institutions: [
      {
        id: "i1",
        capacity: 3,
        quotas: [{ category: "X", quota: 1, children: [{ category: "Y", quota: 1 }] }],
        prefs: ["a1", "a2", "a3"],
      },
    ],
  });
  const inst = market.institutionById.get("i1")!;
  const counts = quotaCounts(market, inst, ["a1", "a2"]);
  assert.deepEqual(
    counts.map((c) => [c.path, c.count, c.quota, c.ok]),
    [
      ["X", 1, 1, true],
      ["X/Y", 2, 1, false],
    ],
  );
  assert.equal(checkMembers(market, inst, ["a1", "a2"]).ok, false);
  assert.equal(checkMembers(market, inst, ["a1", "a3"]).ok, true);
  assert.equal(checkMembers(market, inst, ["a1", "a2", "a3"]).ok, false);
});
