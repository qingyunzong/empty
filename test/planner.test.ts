import { randomInt } from "node:crypto";
import { describe, test } from "node:test";
import {
  deepEqual,
  equal,
  match,
  notEqual,
  ok,
  throws,
} from "node:assert/strict";

import { sha256Hex } from "../src/digest.js";
import { PlanRejection, createPlan } from "../src/planner.js";
import type { Plan, PlanRequest } from "../src/planner.js";

function resource(id: string, content: string) {
  return { id, content, digest: sha256Hex(content) };
}

function validRequest(): PlanRequest {
  return {
    resources: [
      resource("raw-orders", "order-id,amount\n1,10\n2,20\n"),
      resource("fx-table", "USD,1.0\nEUR,1.1\n"),
      resource("calendar", "2026-10-06,weekday\n"),
    ],
    actions: [
      { kind: "fetch", inputs: ["raw-orders"] },
      { kind: "transform", inputs: ["raw-orders", "fx-table"], note: "convert to USD" },
      { kind: "aggregate", inputs: ["raw-orders", "calendar"] },
      { kind: "emit", inputs: ["fx-table"] },
    ],
  };
}

describe("structured input only", () => {
  test("accepts a valid batch and returns an ordered plan with evidence", () => {
    const plan = createPlan(validRequest());
    deepEqual(
      plan.steps.map((s) => s.seq),
      [0, 1, 2, 3],
    );
    deepEqual(
      plan.steps.map((s) => s.kind),
      ["fetch", "transform", "aggregate", "emit"],
    );
    equal(plan.evidence.length, 3);
    ok(plan.evidence.every((e) => e.verified));
    for (const e of plan.evidence) {
      equal(e.declaredDigest, e.computedDigest);
    }
    match(plan.planDigest, /^[0-9a-f]{64}$/);
  });

  test("plan digest depends on step order", () => {
    const req = validRequest();
    const forward = createPlan(req);
    const reversed = createPlan({ ...req, actions: [...req.actions].reverse() });
    notEqual(forward.planDigest, reversed.planDigest);
  });

  test("rejects descriptive text entries instead of parsing them into actions", () => {
    const req = validRequest();
    const withProse = {
      ...req,
      actions: [...req.actions, "then please also email the summary to finance"] as never,
    };
    const err = throwsPlanRejection(withProse);
    ok(
      err.problems.some((p) => p.includes("descriptive text is never parsed into actions")),
      `expected prose rejection, got: ${err.problems.join("; ")}`,
    );
  });

  test("rejects non-array actions and non-object requests", () => {
    throwsPlanRejection({ resources: [], actions: "fetch everything" });
    throwsPlanRejection("fetch everything");
    throwsPlanRejection(null);
  });

  test("rejects unknown action kinds and undeclared resource references", () => {
    const req = validRequest();
    throwsPlanRejection({
      ...req,
      actions: [{ kind: "exfiltrate", inputs: ["raw-orders"] }] as never,
    });
    throwsPlanRejection({
      ...req,
      actions: [{ kind: "fetch", inputs: ["no-such-resource"] }],
    });
  });
});

describe("digest verification is all-or-nothing", () => {
  test("a single mismatched digest rejects the whole batch", () => {
    const req = validRequest();
    req.resources[1]!.digest = "0".repeat(64);
    const err = throwsPlanRejection(req);
    ok(
      err.problems.some((p) => p.includes('"fx-table"') && p.includes("digest mismatch")),
      `expected fx-table mismatch, got: ${err.problems.join("; ")}`,
    );
  });

  test("all mismatches are reported together", () => {
    const req = validRequest();
    req.resources[0]!.content = "tampered content";
    req.resources[2]!.digest = "f".repeat(64);
    const err = throwsPlanRejection(req);
    ok(err.problems.some((p) => p.includes('"raw-orders"')));
    ok(err.problems.some((p) => p.includes('"calendar"')));
  });
});

describe("tamper resistance: one mutated field fails verification with no side effects", () => {
  test("random single-field tampering always rejects and never emits", () => {
    const iterations = 500;
    let emitCalls = 0;
    const sink = (_plan: Plan) => {
      emitCalls += 1;
    };

    for (let i = 0; i < iterations; i++) {
      const req = structuredClone(validRequest()) as unknown as Record<string, unknown>;
      tamperOneRandomField(req);
      const err = throwsPlanRejection(req);
      ok(err.problems.length > 0, "rejection must list at least one problem");
    }
    equal(emitCalls, 0, "emit sink must never fire for a rejected batch");

    // Sanity: the untampered request does emit exactly once.
    createPlan(validRequest(), sink);
    equal(emitCalls, 1);
  });

  test("failed verification leaves caller state untouched", () => {
    const req = validRequest();
    req.resources[0]!.digest = "a".repeat(64);
    const snapshot = structuredClone(req);
    throwsPlanRejection(req);
    deepEqual(req, snapshot, "planner must not mutate the rejected request");
  });
});

function throwsPlanRejection(input: unknown): PlanRejection {
  let caught: unknown;
  throws(() => createPlan(input, () => {
    throw new Error("emit must not be called on rejection");
  }), PlanRejection);
  try {
    createPlan(input);
  } catch (e) {
    caught = e;
  }
  if (!(caught instanceof PlanRejection)) {
    throw new Error("expected PlanRejection");
  }
  return caught;
}

function flipHexChar(hex: string): string {
  const pos = randomInt(0, hex.length);
  const current = hex[pos]!;
  const replacement = current === "0" ? "1" : "0";
  return hex.slice(0, pos) + replacement + hex.slice(pos + 1);
}

function tamperOneRandomField(req: Record<string, unknown>): void {
  const resources = req.resources as Array<{ id: string; content: string; digest: string }>;
  const actions = req.actions as Array<Record<string, unknown>>;
  const choice = randomInt(0, 6);
  switch (choice) {
    case 0: {
      const r = resources[randomInt(0, resources.length)]!;
      r.digest = flipHexChar(r.digest);
      break;
    }
    case 1: {
      const r = resources[randomInt(0, resources.length)]!;
      r.content = r.content + "tampered";
      break;
    }
    case 2: {
      const a = actions[randomInt(0, actions.length)]!;
      a.kind = "not-a-real-kind";
      break;
    }
    case 3: {
      const a = actions[randomInt(0, actions.length)]!;
      a.inputs = ["ghost-resource-" + randomInt(0, 1000)];
      break;
    }
    case 4: {
      actions[randomInt(0, actions.length)] = "just do the thing please" as never;
      break;
    }
    default: {
      const r = resources[randomInt(0, resources.length)]!;
      r.digest = r.digest.toUpperCase() === r.digest
        ? flipHexChar(r.digest)
        : r.digest.slice(0, -1) + "zzz";
      break;
    }
  }
}
