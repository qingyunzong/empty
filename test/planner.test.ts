import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlanRejection,
  createPlan,
  digestContent,
  executePlan,
  verifyPlan,
} from "../src/index.js";
import type { Evidence, Plan, PlanRequest, Resource } from "../src/index.js";

function resource(id: string, content: string): Resource {
  return { id, content, digest: digestContent(content) };
}

function validRequest(): PlanRequest {
  return {
    resources: [resource("cfg", "mode=fast"), resource("data", "row1\nrow2")],
    actions: [
      { id: "a1", kind: "load", inputs: ["data"] },
      { id: "a2", kind: "transform", inputs: ["data", "cfg"], params: { mode: "fast" } },
      { id: "a3", kind: "store", inputs: ["cfg"] },
    ],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("createPlan: structured input only", () => {
  it("accepts a structured action list and yields an ordered plan with evidence", () => {
    const { plan, evidence } = createPlan(validRequest());
    assert.deepEqual(plan.steps.map((s) => s.seq), [0, 1, 2]);
    assert.deepEqual(plan.steps.map((s) => s.action.id), ["a1", "a2", "a3"]);
    assert.equal(plan.steps[1]!.action.params?.mode, "fast");
    assert.deepEqual(plan.resourceIds, ["data", "cfg"]);
    assert.match(evidence.rootHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(evidence.stepHashes.length, 3);
    assert.equal(Object.keys(evidence.resourceDigests).length, 2);
  });

  it("is deterministic: identical input yields identical plan id and root hash", () => {
    const first = createPlan(validRequest());
    const second = createPlan(validRequest());
    assert.equal(first.plan.planId, second.plan.planId);
    assert.equal(first.evidence.rootHash, second.evidence.rootHash);
  });

  it("rejects a prose string instead of parsing it into actions", () => {
    assert.throws(
      () => createPlan("please load data, transform it, then store the result"),
      (err: unknown) => err instanceof PlanRejection && err.code === "UNSTRUCTURED_INPUT",
    );
  });

  it("rejects actions given as descriptive text entries", () => {
    const request = validRequest() as unknown as Record<string, unknown>;
    request.actions = ["load the data resource", "then transform it"];
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "UNSTRUCTURED_ACTION",
    );
  });

  it("rejects a single descriptive text entry mixed into valid actions", () => {
    const request = validRequest() as unknown as Record<string, unknown>;
    (request.actions as unknown[]).splice(1, 0, "note: remember to transform carefully");
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "UNSTRUCTURED_ACTION",
    );
  });

  it("rejects unexpected request fields", () => {
    const request = { ...validRequest(), notes: "extra prose" } as unknown;
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "INVALID_SHAPE",
    );
  });
});

describe("createPlan: digest and reference validation (all-or-nothing)", () => {
  it("rejects the entire batch when any single resource digest mismatches", () => {
    const request = validRequest();
    request.resources[1]!.digest = digestContent("tampered content");
    assert.throws(
      () => createPlan(request),
      (err: unknown) =>
        err instanceof PlanRejection &&
        err.code === "DIGEST_MISMATCH" &&
        err.message.includes("data") &&
        err.message.includes("entire batch rejected"),
    );
  });

  it("rejects the batch when content was edited but digest left stale", () => {
    const request = validRequest();
    request.resources[0]!.content = "mode=slow";
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "DIGEST_MISMATCH",
    );
  });

  it("rejects the batch when an action references an unknown resource id", () => {
    const request = validRequest();
    request.actions[0]!.inputs = ["missing"];
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "UNKNOWN_RESOURCE",
    );
  });

  it("rejects malformed digest formats", () => {
    const request = validRequest();
    request.resources[0]!.digest = "md5:abc";
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "INVALID_DIGEST_FORMAT",
    );
  });

  it("rejects duplicate resource ids", () => {
    const request = validRequest();
    request.resources.push(resource("cfg", "mode=fast"));
    assert.throws(
      () => createPlan(request),
      (err: unknown) => err instanceof PlanRejection && err.code === "DUPLICATE_RESOURCE",
    );
  });
});

describe("verifyPlan: tamper detection on any single field", () => {
  function setup(): { plan: Plan; evidence: Evidence; resources: Resource[] } {
    const request = validRequest();
    const { plan, evidence } = createPlan(request);
    return { plan, evidence, resources: request.resources };
  }

  it("accepts an untampered plan", () => {
    const { plan, evidence, resources } = setup();
    assert.deepEqual(verifyPlan(plan, evidence, resources), { ok: true });
  });

  it("fails when resource content is tampered", () => {
    const { plan, evidence, resources } = setup();
    resources[1]!.content = "row1\nrow2\nrow3";
    const verdict = verifyPlan(plan, evidence, resources);
    assert.equal(verdict.ok, false);
  });

  it("fails when a resource digest field is tampered", () => {
    const { plan, evidence, resources } = setup();
    resources[0]!.digest = digestContent("mode=fast"); // valid-looking but shifted
    resources[0]!.content = "mode=slow";
    assert.equal(verifyPlan(plan, evidence, resources).ok, false);
  });

  it("fails when an action param is tampered", () => {
    const { plan, evidence, resources } = setup();
    const tampered = clone(plan);
    tampered.steps[1]!.action.params = { mode: "slow" };
    assert.equal(verifyPlan(tampered, evidence, resources).ok, false);
  });

  it("fails when an action kind is tampered", () => {
    const { plan, evidence, resources } = setup();
    const tampered = clone(plan);
    tampered.steps[2]!.action.kind = "delete";
    assert.equal(verifyPlan(tampered, evidence, resources).ok, false);
  });

  it("fails when step order is swapped", () => {
    const { plan, evidence, resources } = setup();
    const tampered = clone(plan);
    const [first, second] = [tampered.steps[0]!, tampered.steps[1]!];
    tampered.steps[0] = second;
    tampered.steps[1] = first;
    assert.equal(verifyPlan(tampered, evidence, resources).ok, false);
  });

  it("fails when an evidence step hash is tampered", () => {
    const { plan, evidence, resources } = setup();
    const tampered = clone(evidence);
    tampered.stepHashes[0] = tampered.stepHashes[1]!;
    assert.equal(verifyPlan(plan, tampered, resources).ok, false);
  });

  it("fails when the evidence root hash is tampered", () => {
    const { plan, evidence, resources } = setup();
    const tampered = clone(evidence);
    tampered.rootHash = tampered.rootHash.replace(/[0-9a-f](?=[0-9a-f]{63}$)/, "f");
    assert.equal(verifyPlan(plan, tampered, resources).ok, false);
  });

  it("fails when a resource is dropped", () => {
    const { plan, evidence, resources } = setup();
    assert.equal(verifyPlan(plan, evidence, resources.slice(0, 1)).ok, false);
  });
});

describe("executePlan: failed verification has no side effects", () => {
  it("runs handlers in order for a valid plan", () => {
    const request = validRequest();
    const { plan, evidence } = createPlan(request);
    const calls: string[] = [];
    const result = executePlan(plan, evidence, request.resources, {
      load: (step) => void calls.push(`load:${step.action.id}`),
      transform: (step) => void calls.push(`transform:${step.action.id}`),
      store: (step) => void calls.push(`store:${step.action.id}`),
    });
    assert.equal(result.executed, true);
    assert.deepEqual(calls, ["load:a1", "transform:a2", "store:a3"]);
  });

  it("runs zero handlers when one field was tampered", () => {
    const request = validRequest();
    const { plan, evidence } = createPlan(request);
    const tampered = clone(plan);
    tampered.steps[0]!.action.inputs = ["cfg"]; // tamper one field
    const calls: string[] = [];
    const result = executePlan(tampered, evidence, request.resources, {
      load: (step) => void calls.push(step.action.id),
      transform: (step) => void calls.push(step.action.id),
      store: (step) => void calls.push(step.action.id),
    });
    assert.equal(result.executed, false);
    assert.deepEqual(calls, []); // no side effects
  });
});
