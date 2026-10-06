/**
 * Word simulation and execution-trace rendering.
 */

import { Machine, SINK_STATE } from "./machine";

export interface TraceStep {
  symbol: string;
  from: string;
  to: string;
  output: number | null;
  regs: number[];
}

export function simulate(m: Machine, initRegs: number[], word: string[]): TraceStep[] {
  const steps: TraceStep[] = [];
  let state = m.initial;
  let regs = initRegs.slice();
  for (const sym of word) {
    const idx = m.alphabet.indexOf(sym);
    const r = m.step(state, regs, idx);
    steps.push({ symbol: sym, from: state, to: r.state, output: r.output, regs: r.regs });
    state = r.state;
    regs = r.regs;
  }
  return steps;
}

export function formatRegs(names: string[], regs: number[]): string {
  if (names.length === 0) return "{}";
  return "{" + names.map((n, i) => `${n}=${regs[i]}`).join(", ") + "}";
}

export function formatTrace(m: Machine, regNames: string[], initRegs: number[], word: string[]): string {
  const steps = simulate(m, initRegs, word);
  const lines: string[] = [];
  const mark = (s: string): string => (m.isAccepting(s) ? " [accept]" : "");
  lines.push(`  start: ${m.initial} ${formatRegs(regNames, initRegs)}${mark(m.initial)}`);
  for (const st of steps) {
    const out = st.output === null ? "-" : String(st.output);
    const sinkNote = st.to === SINK_STATE ? " (rejecting sink)" : "";
    lines.push(`  ${st.from} --${st.symbol}/${out}--> ${st.to} ${formatRegs(regNames, st.regs)}${mark(st.to)}${sinkNote}`);
  }
  return lines.join("\n");
}
