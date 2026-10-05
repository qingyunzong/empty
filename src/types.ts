/** One fee segment: units `(prev.upTo, upTo]` are charged `unitCost` each. */
export interface Segment {
  upTo: number;
  unitCost: number;
}

export interface EdgeSpec {
  from: string;
  to: string;
  capacity: number;
  segments: Segment[];
}

export interface NetworkSpec {
  nodes?: string[];
  edges: EdgeSpec[];
  source: string;
  sink: string;
  /** Integer units to send, 0..MAX_AMOUNT. */
  amount: number;
  /** When true, minimize cost over every flow value in [0, amount]. */
  atMost?: boolean;
}

export interface EdgeFlow {
  edge: number;
  from: string;
  to: string;
  flow: number;
  cost: number;
}

export interface CertificateCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface Certificate {
  valid: boolean;
  checks: CertificateCheck[];
}

export interface SolveResult {
  status: "optimal" | "infeasible";
  mode: "exact" | "at-most";
  requested: number;
  sent: number;
  totalCost: number;
  /** Present when status === "infeasible": the maximum sendable amount. */
  maxFlow?: number;
  /** Cost of the cheapest flow of each value k, when atMost is enabled. */
  costByAmount?: number[];
  flows: EdgeFlow[];
  potentials: Record<string, number>;
  certificate: Certificate;
}
