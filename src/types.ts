export interface Sample {
  id: string;
  score: number; // integer
  label: 0 | 1; // 1 = positive, 0 = negative
}

export interface Group {
  name: string;
  samples: Sample[];
}

export interface Dataset {
  version: number;
  budget: number; // global false-positive budget (integer >= 0)
  groups: Group[]; // at most 8
}

export interface Option {
  threshold: number; // accept iff score >= threshold
  fp: number;
  fn: number;
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface DpCell {
  fn: number;
  vector: number[]; // thresholds chosen so far
}

export interface SolveResult {
  options: Option[][]; // Pareto options per group
  tables: (DpCell | null)[][]; // DP table after each stage (index = fp used)
  vector: number[]; // optimal threshold vector
  fn: number; // minimal total false negatives
  fp: number; // total false positives used
}

export interface BruteForceResult {
  status: "ok" | "skipped";
  combos: number;
  fn?: number;
  fp?: number;
  vector?: number[];
  reason?: string;
}
