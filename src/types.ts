export interface ContainerMetric {
  name: string;
  targetUtilization: number;
  currentUtilization: number;
}

export interface WindowSample {
  at: number;
  replicas: number;
}

export interface Policy {
  minReplicas: number;
  maxScaleUpRatio: number;
  maxScaleDownRatio: number;
}

export type BasisKind = "container" | "window" | "min" | "current";

export interface ContainerTrace {
  name: string;
  targetUtilization: number;
  currentUtilization: number;
  recommended: number;
}

export interface DecisionInput {
  now: number;
  currentReplicas: number;
  containers: ContainerMetric[];
  stabilizationWindowMs: number;
  history: WindowSample[];
  policy: Policy;
}

export type ScaleAction = "scale-up" | "scale-down" | "none";

export interface Decision {
  desiredReplicas: number;
  action: ScaleAction;
  basis: BasisKind;
  basisDetail: string;
  candidateReplicas: number;
  candidateContainer: string;
  stabilizedReplicas: number;
  clampedReplicas: number;
  containerTraces: ContainerTrace[];
  windowConsidered: WindowSample[];
  windowPeak: number | null;
  windowPeakAt: number | null;
}
