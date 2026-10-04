import { createHash } from "node:crypto";

export const MAX_INPUTS = 20;

export class AssertionFailure extends Error {
  readonly claimIndex: number;
  readonly slice: string[];
  readonly usedAbsentInput: boolean;

  constructor(message: string, claimIndex: number, slice: string[], usedAbsentInput: boolean) {
    super(message);
    this.name = "AssertionFailure";
    this.claimIndex = claimIndex;
    this.slice = slice;
    this.usedAbsentInput = usedAbsentInput;
  }
}

export type Inputs = Record<string, unknown>;
export type Claim = (condition: boolean, message: string) => void;
export type ExplainFn = (inputs: Inputs, claim: Claim) => void;

export interface MinimalityCheck {
  removed: string;
  role: "slice-member" | "non-member";
  reproduced: boolean;
  outcome: string;
}

export interface SufficiencyCheck {
  kept: string[];
  reproduced: boolean;
  outcome: string;
}

export interface Evidence {
  version: 1;
  kind: "assertion-failure";
  assertion: { message: string; claimIndex: number };
  inputs: Inputs;
  reads: string[];
  minimal: string[];
  minimalityChecks: MinimalityCheck[];
  sufficiency: SufficiencyCheck;
  consistent: boolean;
  digest: string;
}

export type ExplainResult =
  | { kind: "success"; reads: string[] }
  | {
      kind: "assertion-failure";
      message: string;
      claimIndex: number;
      reads: string[];
      minimal: string[];
      consistent: boolean;
      evidence: Evidence;
    }
  | { kind: "error"; errorName: string; errorMessage: string };

interface RunContext {
  reads: Set<string>;
  segment: Set<string>;
  absentReads: Set<string>;
  claimCount: number;
}

type RunOutcome =
  | { status: "success"; reads: string[] }
  | {
      status: "assertion-failure";
      message: string;
      claimIndex: number;
      slice: string[];
      usedAbsentInput: boolean;
      reads: string[];
    }
  | { status: "error"; errorName: string; errorMessage: string };

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

function runOnce(fn: ExplainFn, present: Inputs): RunOutcome {
  const ctx: RunContext = {
    reads: new Set(),
    segment: new Set(),
    absentReads: new Set(),
    claimCount: 0,
  };
  const tracked: Inputs = new Proxy(present, {
    get(target, prop) {
      if (typeof prop === "string") {
        ctx.reads.add(prop);
        ctx.segment.add(prop);
        if (!(prop in target)) ctx.absentReads.add(prop);
      }
      return target[prop as string];
    },
    has(target, prop) {
      if (typeof prop === "string") {
        ctx.reads.add(prop);
        ctx.segment.add(prop);
      }
      return prop in target;
    },
  });
  const claim: Claim = (condition, message) => {
    const claimIndex = ctx.claimCount++;
    const slice = sorted(ctx.segment);
    ctx.segment = new Set();
    if (!condition) {
      const usedAbsentInput = slice.some((key) => ctx.absentReads.has(key));
      throw new AssertionFailure(message, claimIndex, slice, usedAbsentInput);
    }
  };
  try {
    fn(tracked, claim);
    return { status: "success", reads: sorted(ctx.reads) };
  } catch (err) {
    if (err instanceof AssertionFailure) {
      return {
        status: "assertion-failure",
        message: err.message,
        claimIndex: err.claimIndex,
        slice: err.slice,
        usedAbsentInput: err.usedAbsentInput,
        reads: sorted(ctx.reads),
      };
    }
    const error = err as Error | undefined;
    return {
      status: "error",
      errorName: error && error.name ? error.name : "UnknownError",
      errorMessage: error && error.message ? error.message : String(err),
    };
  }
}

interface Baseline {
  message: string;
  claimIndex: number;
}

function reproduces(baseline: Baseline, out: RunOutcome): boolean {
  return (
    out.status === "assertion-failure" &&
    out.message === baseline.message &&
    out.claimIndex === baseline.claimIndex &&
    !out.usedAbsentInput
  );
}

function describeOutcome(out: RunOutcome): string {
  switch (out.status) {
    case "success":
      return "success";
    case "error":
      return `error:${out.errorName}:${out.errorMessage}`;
    case "assertion-failure":
      return out.usedAbsentInput
        ? `assertion-failure(absent-input):${out.message}`
        : `assertion-failure:${out.message}`;
  }
}

function omit(inputs: Inputs, key: string): Inputs {
  const copy: Inputs = {};
  for (const k of Object.keys(inputs)) {
    if (k !== key) copy[k] = inputs[k];
  }
  return copy;
}

function pick(inputs: Inputs, keys: string[]): Inputs {
  const copy: Inputs = {};
  for (const k of keys) copy[k] = inputs[k];
  return copy;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return JSON.stringify(String(value));
    }
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      return JSON.stringify(String(value));
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

function computeDigest(assertion: { message: string; claimIndex: number }, inputs: Inputs, minimal: string[]): string {
  const payload = canonicalJson({ assertion, inputs, minimal });
  return createHash("sha256").update(payload).digest("hex");
}

function validateInputs(inputs: Inputs): void {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new TypeError("inputs must be a plain object mapping names to JSON-serializable values");
  }
  const keys = Object.keys(inputs);
  if (keys.length > MAX_INPUTS) {
    throw new RangeError(`at most ${MAX_INPUTS} inputs are supported, got ${keys.length}`);
  }
  try {
    canonicalJson(inputs);
  } catch {
    throw new TypeError("inputs must be JSON-serializable");
  }
}

export function explain(fn: ExplainFn, inputs: Inputs): ExplainResult {
  validateInputs(inputs);
  const baseline = runOnce(fn, inputs);
  if (baseline.status === "success") {
    return { kind: "success", reads: baseline.reads };
  }
  if (baseline.status === "error") {
    return { kind: "error", errorName: baseline.errorName, errorMessage: baseline.errorMessage };
  }

  const minimal = baseline.slice;
  const base: Baseline = { message: baseline.message, claimIndex: baseline.claimIndex };

  const minimalityChecks: MinimalityCheck[] = Object.keys(inputs)
    .sort()
    .map((key) => {
      const out = runOnce(fn, omit(inputs, key));
      return {
        removed: key,
        role: minimal.includes(key) ? "slice-member" : "non-member",
        reproduced: reproduces(base, out),
        outcome: describeOutcome(out),
      };
    });

  const consistent = minimalityChecks.every(
    (check) => check.reproduced !== (check.role === "slice-member"),
  );

  const suffOut = runOnce(fn, pick(inputs, minimal));
  const sufficiency: SufficiencyCheck = {
    kept: minimal,
    reproduced: reproduces(base, suffOut),
    outcome: describeOutcome(suffOut),
  };

  const assertion = { message: baseline.message, claimIndex: baseline.claimIndex };
  const evidence: Evidence = {
    version: 1,
    kind: "assertion-failure",
    assertion,
    inputs,
    reads: baseline.reads,
    minimal,
    minimalityChecks,
    sufficiency,
    consistent,
    digest: computeDigest(assertion, inputs, minimal),
  };

  return {
    kind: "assertion-failure",
    message: baseline.message,
    claimIndex: baseline.claimIndex,
    reads: baseline.reads,
    minimal,
    consistent,
    evidence,
  };
}

export interface ReplayResult {
  ok: boolean;
  reason: string;
}

export function replay(evidence: Evidence, fn: ExplainFn): ReplayResult {
  const expected = computeDigest(evidence.assertion, evidence.inputs, evidence.minimal);
  if (expected !== evidence.digest) {
    return { ok: false, reason: "digest-mismatch: evidence was tampered with" };
  }
  const out = runOnce(fn, evidence.inputs);
  if (out.status !== "assertion-failure") {
    return { ok: false, reason: `expected assertion-failure, got ${describeOutcome(out)}` };
  }
  if (out.message !== evidence.assertion.message || out.claimIndex !== evidence.assertion.claimIndex) {
    return { ok: false, reason: "assertion-mismatch: different failure than recorded" };
  }
  if (canonicalJson(out.slice) !== canonicalJson(evidence.minimal)) {
    return { ok: false, reason: "slice-mismatch: minimal slice differs from recorded" };
  }
  return { ok: true, reason: "reproduced" };
}
