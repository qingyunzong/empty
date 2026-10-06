import type { State, Vec } from "./types.ts";

export function cmpVec(a: Vec, b: Vec): number {
  return a[0] - b[0] || a[1] - b[1];
}

export function sortVecs(vs: Vec[]): Vec[] {
  return [...vs].sort(cmpVec);
}

export function stateKey(s: State): string {
  const enc = (v: Vec): string => `${v[0]},${v[1]}`;
  const es = s.enemies.map(enc).join(";");
  const os = s.obstacles.map(enc).join(";");
  return `${enc(s.player)}|${s.phase}${s.toggleArmed ? "A" : "x"}|${es}|${os}`;
}

export function parseStateKey(key: string): State {
  const parts = key.split("|");
  const dec = (t: string): Vec => {
    const ab = t.split(",").map(Number);
    return [ab[0] ?? 0, ab[1] ?? 0];
  };
  const list = (t: string): Vec[] => (t ? t.split(";").map(dec) : []);
  const flags = parts[1] ?? "0A";
  return {
    player: dec(parts[0] ?? "0,0"),
    phase: (flags[0] === "1" ? 1 : 0) as 0 | 1,
    toggleArmed: flags[1] !== "x",
    enemies: list(parts[2] ?? ""),
    obstacles: list(parts[3] ?? ""),
  };
}
