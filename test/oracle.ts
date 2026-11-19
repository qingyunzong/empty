// Independent reference oracle.
//
// This file intentionally does NOT import anything from src/. It re-derives
// the arbitration rule with a deliberately different implementation style:
// one monolithic imperative routine, a separate integer scale (1000 instead
// of 10000), and hand-written rounding helpers. Every expected decision used
// by the differential tests comes from this oracle, never from the library.

interface OracleContainer {
  name: string;
  targetUtilization: number;
  currentUtilization: number;
}

interface OracleSample {
  at: number;
  replicas: number;
}

interface OraclePolicy {
  minReplicas: number;
  maxScaleUpRatio: number;
  maxScaleDownRatio: number;
}

interface OracleInput {
  now: number;
  currentReplicas: number;
  containers: OracleContainer[];
  stabilizationWindowMs: number;
  history: OracleSample[];
  policy: OraclePolicy;
}

interface OracleTrace {
  name: string;
  targetUtilization: number;
  currentUtilization: number;
  recommended: number;
}

export interface OracleDecision {
  desiredReplicas: number;
  action: "scale-up" | "scale-down" | "none";
  basis: "container" | "window" | "min" | "current";
  basisDetail: string;
  candidateReplicas: number;
  candidateContainer: string;
  stabilizedReplicas: number;
  clampedReplicas: number;
  containerTraces: OracleTrace[];
  windowConsidered: OracleSample[];
  windowPeak: number | null;
  windowPeakAt: number | null;
}

const ORACLE_SCALE = 1000;

function isWhole(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new RangeError(message);
  }
}

function upwardDivide(numerator: number, denominator: number): number {
  let whole = 0;
  let remaining = numerator;
  while (remaining >= denominator) {
    whole += 1;
    remaining -= denominator;
  }
  return remaining === 0 ? whole : whole + 1;
}

function downwardDivide(numerator: number, denominator: number): number {
  let whole = 0;
  let remaining = numerator;
  while (remaining >= denominator) {
    whole += 1;
    remaining -= denominator;
  }
  return whole;
}

function containerReplicaProposal(base: number, current: number, target: number): number {
  return upwardDivide(base * current, target);
}

function validateOracleInput(input: OracleInput): void {
  check(typeof input === "object" && input !== null, "input must be an object");
  check(isWhole(input.now) && input.now >= 0, "now must be a non-negative integer");
  check(
    isWhole(input.currentReplicas) && input.currentReplicas > 0,
    "currentReplicas must be a positive integer",
  );
  check(
    isWhole(input.stabilizationWindowMs) && input.stabilizationWindowMs >= 0,
    "stabilizationWindowMs must be a non-negative integer",
  );
  check(Array.isArray(input.containers) && input.containers.length > 0, "containers must be non-empty");

  const names: string[] = [];
  for (const container of input.containers) {
    check(typeof container === "object" && container !== null, "container must be an object");
    check(typeof container.name === "string" && container.name !== "", "container name required");
    check(names.indexOf(container.name) === -1, "container names must be unique");
    names.push(container.name);
    check(
      isWhole(container.targetUtilization) && container.targetUtilization > 0,
      "targetUtilization must be positive integer",
    );
    check(
      isWhole(container.currentUtilization) && container.currentUtilization > 0,
      "currentUtilization must be positive integer",
    );
  }

  check(Array.isArray(input.history), "history must be an array");
  for (const sample of input.history) {
    check(typeof sample === "object" && sample !== null, "history sample must be an object");
    check(isWhole(sample.at) && sample.at >= 0, "sample.at must be non-negative integer");
    check(isWhole(sample.replicas) && sample.replicas > 0, "sample.replicas must be positive integer");
  }

  const policy = input.policy;
  check(typeof policy === "object" && policy !== null, "policy must be an object");
  check(isWhole(policy.minReplicas) && policy.minReplicas > 0, "minReplicas must be positive integer");
  check(
    typeof policy.maxScaleUpRatio === "number" &&
      Number.isFinite(policy.maxScaleUpRatio) &&
      policy.maxScaleUpRatio >= 0,
    "maxScaleUpRatio must be finite and non-negative",
  );
  check(
    typeof policy.maxScaleDownRatio === "number" &&
      Number.isFinite(policy.maxScaleDownRatio) &&
      policy.maxScaleDownRatio >= 0 &&
      policy.maxScaleDownRatio <= 1,
    "maxScaleDownRatio must be within [0,1]",
  );
}

export function referenceDecide(input: OracleInput): OracleDecision {
  validateOracleInput(input);

  const current = input.currentReplicas;
  const traces: OracleTrace[] = [];
  let candidate = 0;
  let winner = "";
  for (const container of input.containers) {
    const recommendation = containerReplicaProposal(
      current,
      container.currentUtilization,
      container.targetUtilization,
    );
    traces.push({
      name: container.name,
      targetUtilization: container.targetUtilization,
      currentUtilization: container.currentUtilization,
      recommended: recommendation,
    });
    if (recommendation > candidate) {
      candidate = recommendation;
      winner = container.name;
    }
  }

  const cutoff = input.now - input.stabilizationWindowMs;
  const inWindow: OracleSample[] = [];
  for (const sample of input.history) {
    if (sample.at >= cutoff && sample.at <= input.now) {
      inWindow.push({ at: sample.at, replicas: sample.replicas });
    }
  }
  inWindow.sort((left, right) =>
    left.at === right.at ? left.replicas - right.replicas : left.at - right.at,
  );

  let stabilized = candidate;
  let basis: OracleDecision["basis"] = "container";
  let basisDetail = `container '${winner}' recommends ${candidate}`;
  let peak: number | null = null;
  let peakAt: number | null = null;

  if (candidate < current && inWindow.length > 0) {
    let leader: OracleSample | null = null;
    for (const sample of inWindow) {
      if (leader === null || sample.replicas > leader.replicas) {
        leader = sample;
      }
    }
    const chosen = leader!;
    peak = chosen.replicas;
    peakAt = chosen.at;
    if (chosen.replicas > candidate) {
      stabilized = chosen.replicas;
      basis = "window";
      basisDetail = `stabilization window peak ${chosen.replicas} at t=${chosen.at}`;
    }
  }

  const upScaled = Math.round(input.policy.maxScaleUpRatio * ORACLE_SCALE);
  const downScaled = Math.round(input.policy.maxScaleDownRatio * ORACLE_SCALE);
  let rateLimited: number;
  if (stabilized > current) {
    const ceiling = upwardDivide(current * (ORACLE_SCALE + upScaled), ORACLE_SCALE);
    rateLimited = stabilized < ceiling ? stabilized : ceiling;
  } else if (stabilized < current) {
    const floor = downwardDivide(current * (ORACLE_SCALE - downScaled), ORACLE_SCALE);
    rateLimited = stabilized > floor ? stabilized : floor;
  } else {
    rateLimited = current;
  }

  let desired = rateLimited;
  if (desired < input.policy.minReplicas) {
    desired = input.policy.minReplicas;
    basis = "min";
    basisDetail = `minReplicas ${desired} clamps ${rateLimited}`;
  }

  let action: OracleDecision["action"];
  if (desired > current) {
    action = "scale-up";
  } else if (desired < current) {
    action = "scale-down";
  } else {
    action = "none";
    basis = "current";
    basisDetail = `unchanged at ${current}`;
  }

  return {
    desiredReplicas: desired,
    action,
    basis,
    basisDetail,
    candidateReplicas: candidate,
    candidateContainer: winner,
    stabilizedReplicas: stabilized,
    clampedReplicas: rateLimited,
    containerTraces: traces,
    windowConsidered: inWindow,
    windowPeak: peak,
    windowPeakAt: peakAt,
  };
}
