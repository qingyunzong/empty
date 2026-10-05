export interface Problem {
  /** Work order IDs, length n (1 <= n <= 12). */
  orders: string[];
  /** Workstation IDs, length n (equal to orders). */
  stations: string[];
  /** costs[i][j]: cost of assigning order i to station j; null = forbidden. Negative costs allowed. */
  costs: (number | null)[][];
}

export interface DualCertificate {
  /** Row potentials, u[i] for order i. */
  u: number[];
  /** Column potentials, v[j] for station j. */
  v: number[];
}

export interface OptimalResult {
  status: "optimal";
  cost: number;
  /** assignment[i] = station index matched to order i. */
  matching: number[];
  dual: DualCertificate;
}

export interface HallWitness {
  /** Row indices S with |N(S)| < |S|. */
  rows: number[];
  /** Column indices N(S): all stations adjacent to S. */
  neighbors: number[];
}

export interface InfeasibleResult {
  status: "infeasible";
  hall: HallWitness;
}

export type SolveResult = OptimalResult | InfeasibleResult;
