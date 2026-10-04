export interface Station {
  id: number;
  name: string;
  x: number;
  y: number;
  /** service duration (integer time units) */
  service: number;
  /** time window [open, close]; service must start within it */
  open: number;
  close: number;
  profit: number;
}

export interface Instance {
  name: string;
  /** index of the depot inside `stations` (route starts and ends there) */
  depot: number;
  /** integer total time limit (travel + wait + service), must return by this time */
  timeLimit: number;
  stations: Station[];
}

export interface Solution {
  /** ordered station ids, excluding depot */
  route: number[];
  profit: number;
  /** total travel distance (waiting/service not included) */
  distance: number;
  /** total elapsed time back at the depot (travel + wait + service) */
  totalTime: number;
}

export interface CertificateStop {
  station: number;
  name: string;
  arrival: number;
  wait: number;
  serviceStart: number;
  departure: number;
  profit: number;
}

export interface Certificate {
  instance: string;
  timeLimit: number;
  stops: CertificateStop[];
  returnTime: number;
  totalProfit: number;
  totalDistance: number;
  totalTime: number;
}
