export interface Interval {
  start: number;
  end: number;
}

export interface Shift {
  id: number;
  priority: number;
  work: Interval[];
  rest?: Interval[];
  maxWork?: number;
  minRest?: number;
}

export interface Segment {
  shiftId: number;
  start: number;
  end: number;
}

export interface Attribution {
  segments: Segment[];
  totals: Map<number, number>;
  totalSeconds: number;
}

export interface RestCertificate {
  shiftId: number;
  explicitRest: Interval[];
  unassignedRest: Interval[];
  restSeconds: number;
  minRest: number;
  ok: boolean;
}

export interface Allocation {
  segments: Segment[];
  totals: Map<number, number>;
  coverage: number;
  benefit: number;
  certificates: RestCertificate[];
}
