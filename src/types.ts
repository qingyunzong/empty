export type Capability = string;

export interface Plugin {
  id: string;
  cost: number;
  requires: Capability[];
  provides: Capability[];
}

export interface Problem {
  initial: Capability[];
  plugins: Plugin[];
  target: Capability[];
}

export interface PlanStep {
  plugin: Plugin;
  heldAfter: Capability[];
}

export interface Plan {
  initial: Capability[];
  steps: PlanStep[];
  totalCost: number;
}
