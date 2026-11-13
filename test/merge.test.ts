import assert from "node:assert/strict";
import test from "node:test";
import {
  isEmptyValue,
  mergeEntity,
  recordCompleteness,
  selectField,
  SurvivorMergeError,
  type SurvivorRecord,
} from "../src/index.ts";

function records(): SurvivorRecord[] {
  return [
    {
      recordId: "crm-2",
      sourceId: "crm",
      updatedAt: "2026-01-01T00:00:00.000Z",
      values: { name: "Ada", email: "" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: "2026-02-01T00:00:00.000Z",
      values: { email: "ada@example.com", phone: "+44 20 0000 0000" },
    },
  ];
}

test("fields survive independently from different records", () => {
  const result = mergeEntity(records(), {
    sourcePriorities: { crm: 100, erp: 50 },
  });

  assert.equal(result.values.name, "Ada");
  assert.equal(result.values.email, "ada@example.com");
  assert.equal(result.values.phone, "+44 20 0000 0000");

  assert.equal(result.fields.name.recordId, "crm-2");
  assert.equal(result.fields.email.recordId, "erp-1");
  assert.equal(result.fields.phone.recordId, "erp-1");

  const crmEmail = result.fields.email.evidence.candidates.find(
    (candidate) => candidate.recordId === "crm-2",
  );
  assert.ok(crmEmail);
  assert.equal(crmEmail.eligible, false);
  assert.deepEqual(crmEmail.excludedReasons, ["empty-value"]);
});

test("source priority outranks freshness", () => {
  const result = mergeEntity([
    {
      recordId: "crm-1",
      sourceId: "crm",
      updatedAt: "2025-01-01T00:00:00.000Z",
      values: { name: "Priority winner" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: "2026-01-01T00:00:00.000Z",
      values: { name: "Newer value" },
    },
  ], {
    sourcePriorities: { crm: 100, erp: 90 },
  });

  assert.equal(result.values.name, "Priority winner");
  assert.equal(result.fields.name.decidedBy, "sourcePriority");
  assert.equal(result.fields.name.evidence.rankedWinner?.rank, 1);
});

test("record-level sourcePriority is used when no map is configured", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      sourcePriority: 5,
      updatedAt: 2000,
      values: { name: "Low priority" },
    },
    {
      recordId: "b-1",
      sourceId: "b",
      sourcePriority: 9,
      updatedAt: 1000,
      values: { name: "High priority" },
    },
  ]);

  assert.equal(result.values.name, "High priority");
  assert.equal(result.fields.name.decidedBy, "sourcePriority");
});

test("freshness decides when source priority is equal", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      updatedAt: 1000,
      values: { name: "Older" },
    },
    {
      recordId: "a-2",
      sourceId: "a",
      updatedAt: 2000,
      values: { name: "Newer" },
    },
  ]);

  assert.equal(result.values.name, "Newer");
  assert.equal(result.fields.name.decidedBy, "freshness");
  assert.equal(result.fields.name.evidence.rankedWinner?.freshness, 2000);
  assert.equal(result.fields.name.evidence.rankedWinner?.freshnessSource, "record");
});

test("epoch-zero freshness is newer than a missing timestamp", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      values: { name: "No timestamp" },
    },
    {
      recordId: "a-2",
      sourceId: "a",
      updatedAt: 0,
      values: { name: "Epoch zero" },
    },
  ]);

  assert.equal(result.values.name, "Epoch zero");
  assert.equal(result.fields.name.decidedBy, "freshness");
});

test("field-level freshness can override record freshness", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      updatedAt: 100,
      fieldUpdatedAt: { name: 3000 },
      values: { name: "Field timestamp" },
    },
    {
      recordId: "b-1",
      sourceId: "b",
      updatedAt: 2500,
      values: { name: "Record timestamp" },
    },
  ]);

  assert.equal(result.values.name, "Field timestamp");
  assert.equal(result.fields.name.evidence.rankedWinner?.freshnessSource, "field");
  assert.equal(result.fields.name.decidedBy, "freshness");
});

test("completeness breaks a priority and freshness tie", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      updatedAt: 1000,
      values: { name: "Ada" },
    },
    {
      recordId: "a-2",
      sourceId: "a",
      updatedAt: 1000,
      values: { name: "Ada Lovelace" },
    },
  ]);

  assert.equal(result.values.name, "Ada Lovelace");
  assert.equal(result.fields.name.decidedBy, "completeness");
  assert.ok(
    (result.fields.name.evidence.rankedWinner?.completeness ?? 0) >
      (result.fields.name.evidence.runnerUp?.completeness ?? 0),
  );
});

test("completeness can be overridden with record fill", () => {
  const result = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      updatedAt: 1000,
      values: { name: "Al", city: "London" },
    },
    {
      recordId: "a-2",
      sourceId: "a",
      updatedAt: 1000,
      values: { name: "Alexandria", city: "" },
    },
  ], {
    fieldRules: {
      name: {
        completeness: (_value, record) => recordCompleteness(record),
      },
    },
  });

  assert.equal(result.values.name, "Al");
  assert.equal(result.fields.name.decidedBy, "completeness");
  assert.equal(result.fields.name.evidence.rankedWinner?.recordCompleteness, 1);
  assert.equal(result.fields.name.evidence.runnerUp?.recordCompleteness, 0.5);
});

test("manual lock beats higher priority and freshness", () => {
  const result = mergeEntity([
    {
      recordId: "crm-1",
      sourceId: "crm",
      updatedAt: 9000,
      values: { name: "Ranked winner" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: 1000,
      values: { name: "Locked value" },
    },
  ], {
    sourcePriorities: { crm: 100, erp: 10 },
    locks: [
      {
        field: "name",
        recordId: "erp-1",
        lockedBy: "steward:alice",
        lockedAt: "2026-03-01T00:00:00.000Z",
        reason: "verified by customer",
      },
    ],
  });

  assert.equal(result.values.name, "Locked value");
  assert.equal(result.fields.name.locked, true);
  assert.equal(result.fields.name.decidedBy, "manual-lock");
  assert.equal(result.fields.name.recordId, "erp-1");
  assert.equal(result.fields.name.evidence.lock?.lockedBy, "steward:alice");
  assert.equal(result.fields.name.evidence.lock?.valueFromRecord, true);
  assert.equal(result.fields.name.evidence.rankedWinner?.recordId, "crm-1");
  assert.deepEqual(result.lockedFields, ["name"]);
});

test("explicit lock value works without a record", () => {
  const result = mergeEntity({
    records: [],
    locks: {
      name: {
        value: "Pinned externally",
        lockedBy: "steward:bob",
      },
    },
  });

  assert.equal(result.values.name, "Pinned externally");
  assert.equal(result.fields.name.locked, true);
  assert.equal(result.fields.name.hasValue, true);
  assert.equal(result.fields.name.evidence.lock?.explicitValue, true);
  assert.deepEqual(result.lockedFields, ["name"]);
});

test("a missing lock record keeps its explicit value and emits a warning", () => {
  const result = mergeEntity({
    records: [],
    locks: [
      {
        field: "name",
        recordId: "gone-1",
        value: "Pinned value",
      },
    ],
  });

  assert.equal(result.values.name, "Pinned value");
  assert.equal(result.fields.name.recordId, "gone-1");
  assert.equal(result.fields.name.evidence.lock?.recordFound, false);
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === "LOCK_RECORD_NOT_FOUND",
    ),
  );
});

test("withdrawing a source recomputes selection and keeps evidence", () => {
  const input = records();
  const result = mergeEntity(input, {
    sourcePriorities: { crm: 100, erp: 50 },
    withdrawnSources: ["crm"],
  });

  assert.equal(result.values.name, undefined);
  assert.equal(result.fields.name.hasValue, false);
  assert.equal(result.recomputedAfterWithdrawal, true);

  const crmCandidate = result.fields.name.evidence.candidates.find(
    (candidate) => candidate.recordId === "crm-2",
  );
  assert.ok(crmCandidate);
  assert.equal(crmCandidate.eligible, false);
  assert.deepEqual(crmCandidate.excludedReasons, ["source-withdrawn"]);
  assert.equal(result.fields.name.evidence.withdrawalAffected, true);

  assert.equal(result.values.email, "ada@example.com");
  assert.equal(result.fields.email.recordId, "erp-1");
});

test("withdrawal recomputes unlocked fields but never overwrites a manual lock", () => {
  const result = mergeEntity([
    {
      recordId: "crm-1",
      sourceId: "crm",
      updatedAt: 1000,
      values: { name: "Locked CRM name", email: "locked@example.com" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: 2000,
      values: { name: "ERP fallback", email: "erp@example.com" },
    },
  ], {
    sourcePriorities: { crm: 100, erp: 50 },
    locks: [{ field: "email", recordId: "crm-1", lockedBy: "steward" }],
    withdrawnSources: ["crm"],
  });

  assert.equal(result.values.name, "ERP fallback");
  assert.equal(result.values.email, "locked@example.com");
  assert.equal(result.fields.name.locked, false);
  assert.equal(result.fields.email.locked, true);
  assert.equal(result.fields.email.decidedBy, "manual-lock");
  assert.equal(
    result.fields.email.evidence.lock?.preservedAfterWithdrawal,
    true,
  );
  assert.ok(
    result.warnings.some((warning) => warning.code === "LOCK_SOURCE_WITHDRAWN"),
  );
});

test("individual record withdrawal and record flag are supported", () => {
  const byId = mergeEntity(records(), {
    sourcePriorities: { crm: 100, erp: 50 },
    withdrawnRecordIds: ["crm-2"],
  });
  assert.equal(byId.values.name, undefined);
  assert.equal(
    byId.fields.name.evidence.candidates[0]?.excludedReasons.includes(
      "record-withdrawn",
    ),
    true,
  );

  const byFlag = mergeEntity([
    {
      recordId: "a-1",
      sourceId: "a",
      withdrawn: true,
      values: { name: "Hidden" },
    },
    {
      recordId: "b-1",
      sourceId: "b",
      values: { name: "Visible" },
    },
  ]);
  assert.equal(byFlag.values.name, "Visible");
  assert.equal(byFlag.recomputedAfterWithdrawal, true);
});

test("record id is the stable final tie-break", () => {
  const input: SurvivorRecord[] = [
    {
      recordId: "rec-2",
      sourceId: "same",
      updatedAt: 1000,
      values: { name: "same" },
    },
    {
      recordId: "rec-10",
      sourceId: "same",
      updatedAt: 1000,
      values: { name: "same" },
    },
  ];

  const forward = mergeEntity(input);
  const reversed = mergeEntity([...input].reverse());

  assert.equal(forward.values.name, "same");
  assert.equal(forward.fields.name.recordId, "rec-10");
  assert.equal(forward.fields.name.decidedBy, "recordId");
  assert.equal(forward.fields.name.evidence.tieBreakUsed, true);
  assert.equal(reversed.fields.name.recordId, "rec-10");
  assert.deepEqual(reversed, forward);
});

test("field rules override global source priority", () => {
  const result = mergeEntity([
    {
      recordId: "crm-1",
      sourceId: "crm",
      updatedAt: 1000,
      values: { email: "crm@example.com" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: 5000,
      values: { email: "erp@example.com" },
    },
  ], {
    sourcePriorities: { crm: 100, erp: 10 },
    fieldRules: {
      email: {
        sourcePriorities: { erp: 200, crm: 10 },
      },
    },
  });

  assert.equal(result.values.email, "erp@example.com");
  assert.equal(result.fields.email.decidedBy, "sourcePriority");
});

test("field rules can reorder criteria while keeping record id last", () => {
  const result = mergeEntity([
    {
      recordId: "crm-1",
      sourceId: "crm",
      updatedAt: 5000,
      values: { email: "short@example.com" },
    },
    {
      recordId: "erp-1",
      sourceId: "erp",
      updatedAt: 1000,
      values: { email: "a-much-longer-address@example.com" },
    },
  ], {
    sourcePriorities: { crm: 100, erp: 10 },
    fieldRules: {
      email: {
        order: ["completeness", "freshness"],
      },
    },
  });

  assert.equal(result.values.email, "a-much-longer-address@example.com");
  assert.equal(result.fields.email.decidedBy, "completeness");
  assert.deepEqual(result.fields.email.evidence.ruleOrder, [
    "completeness",
    "freshness",
    "sourcePriority",
    "recordId",
  ]);
});

test("selectField exposes the same field-level logic", () => {
  const selection = selectField("email", records(), {
    sourcePriorities: { crm: 100, erp: 50 },
  });

  assert.equal(selection.field, "email");
  assert.equal(selection.value, "ada@example.com");
  assert.equal(selection.recordId, "erp-1");
  assert.equal(selection.evidence.candidates.length, 2);
});

test("withdrawn-only fields remain auditable but are omitted from values", () => {
  const result = mergeEntity({
    records: [
      {
        recordId: "old-1",
        sourceId: "old",
        values: { legacyCode: "X1" },
      },
    ],
    withdrawnSources: ["old"],
  });

  assert.equal(Object.hasOwn(result.values, "legacyCode"), false);
  assert.equal(result.fields.legacyCode.hasValue, false);
  assert.equal(result.fields.legacyCode.decidedBy, "no-candidate");
  assert.equal(
    result.fields.legacyCode.evidence.candidates[0]?.excludedReasons[0],
    "source-withdrawn",
  );
});

test("record completeness helper and empty-value helper", () => {
  const record: SurvivorRecord = {
    recordId: "r-1",
    sourceId: "s",
    values: { a: "x", b: "", c: 0, d: false, e: [] },
  };
  assert.equal(recordCompleteness(record), 3 / 5);
  assert.equal(isEmptyValue("  "), true);
  assert.equal(isEmptyValue(0), false);
  assert.equal(isEmptyValue(false), false);
  assert.equal(isEmptyValue([]), true);
});

test("duplicate record ids are rejected", () => {
  assert.throws(
    () =>
      mergeEntity([
        { recordId: "same", sourceId: "a", values: { name: "A" } },
        { recordId: "same", sourceId: "b", values: { name: "B" } },
      ]),
    (error: unknown) =>
      error instanceof SurvivorMergeError &&
      error.code === "DUPLICATE_RECORD_ID",
  );
});

test("entity id overload and request object form agree", () => {
  const request = {
    entityId: "customer:42",
    records: records(),
    sourcePriorities: { crm: 100, erp: 50 },
  };
  const fromRequest = mergeEntity(request);
  const fromParts = mergeEntity(
    "customer:42",
    request.records,
    { sourcePriorities: request.sourcePriorities },
  );

  assert.equal(fromRequest.entityId, "customer:42");
  assert.deepEqual(fromParts, fromRequest);
});
