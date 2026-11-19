import {
  RATIO_SCALE,
  ceilRatio,
  floorRatio,
  scaledRatio,
} from "./arithmetic.js";
import type {
  BasisKind,
  ContainerMetric,
  ContainerTrace,
  Decision,
  DecisionInput,
  ScaleAction,
  WindowSample,
} from "./types.js";

function fail(field: string, constraint: string, actual: unknown): never {
  throw new RangeError(`${field} must be ${constraint}, got ${String(actual)}`);
}

function requirePositiveInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    fail(field, "a positive integer", value);
  }
}

function requireNonNegativeInt(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    fail(field, "a non-negative integer", value);
  }
}

function requireFinite(value: number, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, "a finite number", value);
  }
}

function validate(input: DecisionInput): void {
  if (input === null || typeof input !== "object") {
    throw new TypeError("decision input must be an object");
  }
  requireNonNegativeInt(input.now, "now");
  requirePositiveInt(input.currentReplicas, "currentReplicas");
  requireNonNegativeInt(input.stabilizationWindowMs, "stabilizationWindowMs");
  if (!Array.isArray(input.containers) || input.containers.length === 0) {
    throw new RangeError("containers must be a non-empty array");
  }
  const seenNames = new Set<string>();
  for (const container of input.containers) {
    if (container === null || typeof container !== "object") {
      throw new TypeError("each container must be an object");
    }
    if (typeof container.name !== "string" || container.name.length === 0) {
      fail("container.name", "a non-empty string", container.name);
    }
    if (seenNames.has(container.name)) {
      throw new RangeError(`duplicate container name '${container.name}'`);
    }
    seenNames.add(container.name);
    requirePositiveInt(container.targetUtilization, `${container.name}.targetUtilization`);
    requirePositiveInt(container.currentUtilization, `${container.name}.currentUtilization`);
  }
  if (!Array.isArray(input.history)) {
    throw new RangeError("history must be an array");
  }
  for (const sample of input.history) {
    if (sample === null || typeof sample !== "object") {
      throw new TypeError("each history sample must be an object");
    }
    requireNonNegativeInt(sample.at, "history.at");
    requirePositiveInt(sample.replicas, "history.replicas");
  }
  const policy = input.policy;
  if (policy === null || typeof policy !== "object") {
    throw new TypeError("policy must be an object");
  }
  requirePositiveInt(policy.minReplicas, "policy.minReplicas");
  requireFinite(policy.maxScaleUpRatio, "policy.maxScaleUpRatio");
  requireFinite(policy.maxScaleDownRatio, "policy.maxScaleDownRatio");
  if (policy.maxScaleUpRatio < 0) {
    fail("policy.maxScaleUpRatio", "at least 0", policy.maxScaleUpRatio);
  }
  if (policy.maxScaleDownRatio < 0 || policy.maxScaleDownRatio > 1) {
    fail("policy.maxScaleDownRatio", "between 0 and 1 inclusive", policy.maxScaleDownRatio);
  }
}

function perContainerRecommendations(
  currentReplicas: number,
  containers: ContainerMetric[],
): ContainerTrace[] {
  return containers.map((container) => ({
    name: container.name,
    targetUtilization: container.targetUtilization,
    currentUtilization: container.currentUtilization,
    recommended: ceilRatio(
      currentReplicas,
      container.currentUtilization,
      container.targetUtilization,
    ),
  }));
}

function windowSlice(history: WindowSample[], now: number, windowMs: number): WindowSample[] {
  const earliest = now - windowMs;
  return history
    .filter((sample) => sample.at >= earliest && sample.at <= now)
    .sort((left, right) =>
      left.at === right.at ? left.replicas - right.replicas : left.at - right.at,
    );
}

export function decide(input: DecisionInput): Decision {
  validate(input);

  const { now, currentReplicas, containers, history, stabilizationWindowMs, policy } = input;

  const containerTraces = perContainerRecommendations(currentReplicas, containers);
  let candidateReplicas = 0;
  let candidateContainer = "";
  for (const trace of containerTraces) {
    if (trace.recommended > candidateReplicas) {
      candidateReplicas = trace.recommended;
      candidateContainer = trace.name;
    }
  }

  const windowConsidered = windowSlice(history, now, stabilizationWindowMs);
  let stabilizedReplicas = candidateReplicas;
  let basis: BasisKind = "container";
  let basisDetail = `container '${candidateContainer}' recommends ${candidateReplicas}`;
  let windowPeak: number | null = null;
  let windowPeakAt: number | null = null;

  if (candidateReplicas < currentReplicas && windowConsidered.length > 0) {
    let peakSample: WindowSample | null = null;
    for (const sample of windowConsidered) {
      if (peakSample === null || sample.replicas > peakSample.replicas) {
        peakSample = sample;
      }
    }
    const peak = peakSample!;
    windowPeak = peak.replicas;
    windowPeakAt = peak.at;
    if (peak.replicas > candidateReplicas) {
      stabilizedReplicas = peak.replicas;
      basis = "window";
      basisDetail = `stabilization window peak ${peak.replicas} at t=${peak.at}`;
    }
  }

  const upScale = scaledRatio(policy.maxScaleUpRatio);
  const downScale = scaledRatio(policy.maxScaleDownRatio);
  let clampedReplicas: number;
  if (stabilizedReplicas > currentReplicas) {
    const upperBound = ceilRatio(currentReplicas, RATIO_SCALE + upScale, RATIO_SCALE);
    clampedReplicas = Math.min(stabilizedReplicas, upperBound);
  } else if (stabilizedReplicas < currentReplicas) {
    const lowerBound = floorRatio(currentReplicas, RATIO_SCALE - downScale, RATIO_SCALE);
    clampedReplicas = Math.max(stabilizedReplicas, lowerBound);
  } else {
    clampedReplicas = currentReplicas;
  }

  let desiredReplicas = clampedReplicas;
  if (desiredReplicas < policy.minReplicas) {
    desiredReplicas = policy.minReplicas;
    basis = "min";
    basisDetail = `minReplicas ${policy.minReplicas} clamps ${clampedReplicas}`;
  }

  let action: ScaleAction;
  if (desiredReplicas > currentReplicas) {
    action = "scale-up";
  } else if (desiredReplicas < currentReplicas) {
    action = "scale-down";
  } else {
    action = "none";
    basis = "current";
    basisDetail = `unchanged at ${currentReplicas}`;
  }

  return {
    desiredReplicas,
    action,
    basis,
    basisDetail,
    candidateReplicas,
    candidateContainer,
    stabilizedReplicas,
    clampedReplicas,
    containerTraces,
    windowConsidered,
    windowPeak,
    windowPeakAt,
  };
}
