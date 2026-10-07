import { Grid } from './types.js';
/**
 * Parses an ASCII grid. Characters:
 *   '#'  wall
 *   '.'  floor
 *   'S'  start (exactly one)
 *   'G'  goal (exactly one)
 *   'a'-'e'  keys (at most 5 distinct)
 *   'A'-'E'  doors, each opened by the matching lowercase key
 * Grid must be rectangular and at most 10x10.
 */
export declare function parseGrid(text: string): Grid;
export declare function initialState(grid: Grid): {
    x: number;
    y: number;
    keys: number;
    openDoors: number;
};
