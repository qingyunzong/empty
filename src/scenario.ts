import { Runtime, type FinalState } from "./runtime.js";

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}

export interface ScenarioResult {
  runtime: Runtime;
  finalStates: {
    a1: FinalState;
    b1: FinalState;
    a2: FinalState;
  };
}

export async function runScenario(seed: number | null): Promise<ScenarioResult> {
  const runtime = new Runtime();

  const a1 = runtime.startRound("A");
  const messages = [
    a1.message("stdout", "A1-out-1;"),
    a1.message("stdout", "A1-out-2;"),
    a1.message("assert", "A1-invariant"),
    a1.message("stdout", "A1-out-3;"),
    a1.message("exit", "0"),
  ];
  const order =
    seed === null ? [0, 1, 2, 3, 4] : shuffle([0, 1, 2, 3, 4], seed);
  for (const index of order) runtime.dispatch(messages[index]!);
  const a1End = a1.end();

  const b1 = runtime.startRound("B");
  b1.write("B1-unflushed;");
  b1.truncate("operator kill");
  const b1Final = await b1.end();

  const a1Final = await a1End;

  const a2 = runtime.startRound("A");
  a2.write("A2-out-1;");
  a1.write("A1-LATE-out;");
  a1.assert("A1-LATE-assert");
  a2.assert("A2-invariant");
  a1.exit(7);
  a2.exit(0);
  const a2Final = await a2.end();

  return { runtime, finalStates: { a1: a1Final, b1: b1Final, a2: a2Final } };
}
