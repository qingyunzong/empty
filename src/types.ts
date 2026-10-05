export interface RectSpec {
  id: string;
  w: number;
  h: number;
  profit: number;
  rotate: boolean;
}

export interface GridSpec {
  width: number;
  height: number;
  forbidden: Array<[number, number]>;
}

export interface Instance {
  grid: GridSpec;
  rectangles: RectSpec[];
}

export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Solution {
  profit: number;
  area: number;
  placements: Placement[];
}
