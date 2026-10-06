export type Vec = readonly [number, number];

export interface BoardSpec {
  width: number;
  height: number;
  player: Vec;
  enemies: Vec[];
  obstacles?: Vec[];
  walls?: Vec[];
  toggle?: Vec | null;
  toggleOnce?: boolean;
  directionsA: Vec[];
  directionsB?: Vec[];
}

export interface State {
  player: Vec;
  enemies: Vec[];
  obstacles: Vec[];
  phase: 0 | 1;
  toggleArmed: boolean;
}

export type Action =
  | { kind: "step"; dir: Vec; to: Vec }
  | { kind: "push"; dir: Vec; to: Vec; obstacleFrom: Vec; obstacleTo: Vec }
  | { kind: "jump"; dir: Vec; over: Vec; to: Vec };

export interface BestLine {
  captures: number;
  landings: Vec[];
  actions: Action[];
}
