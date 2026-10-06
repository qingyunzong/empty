import { Board, vecKey } from "./board.ts";
import type { Action, State, Vec } from "./types.ts";

const fmt = (v: Vec): string => `(${v[0]},${v[1]})`;

export function renderBoard(board: Board, state: State): string {
  const enemySet = new Set(state.enemies.map(vecKey));
  const obsSet = new Set(state.obstacles.map(vecKey));
  const rows: string[] = [];
  for (let y = 0; y < board.height; y += 1) {
    let row = "";
    for (let x = 0; x < board.width; x += 1) {
      const k = `${x},${y}`;
      let ch = ".";
      if (board.walls.has(k)) ch = "#";
      else if (board.toggle !== null && vecKey(board.toggle) === k) ch = "T";
      if (obsSet.has(k)) ch = "O";
      if (enemySet.has(k)) ch = "E";
      if (vecKey(state.player) === k) ch = "P";
      row += ch;
    }
    rows.push(row);
  }
  rows.push(`phase=${state.phase} armed=${state.toggleArmed ? 1 : 0}`);
  return rows.join("\n");
}

export function describeAction(a: Action, captureNo: number): string {
  if (a.kind === "step") return `step -> ${fmt(a.to)}`;
  if (a.kind === "push") {
    return `push obstacle ${fmt(a.obstacleFrom)} -> ${fmt(a.obstacleTo)}, move -> ${fmt(a.to)}`;
  }
  return `jump over ${fmt(a.over)}, land ${fmt(a.to)} [capture ${captureNo}]`;
}
