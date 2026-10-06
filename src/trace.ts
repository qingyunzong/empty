/**
 * Execution traces: re-run a word on one automaton and record every step
 * (state, registers, symbol, output) so both runs can be shown side by side.
 */

import { Automaton } from "./model.js";
import { Config, initialConfig, isAccepting, step, formatConfig } from "./machine.js";

export interface TraceStep {
  index: number;
  symbol: string;
  from: Config;
  output: number | null;
  to: Config;
}

export interface Trace {
  machineName: string;
  steps: TraceStep[];
  finalConfig: Config;
  accepting: boolean;
}

export function runTrace(a: Automaton, word: string[]): Trace {
  let config = initialConfig(a);
  const steps: TraceStep[] = [];
  word.forEach((symbol, index) => {
    const result = step(a, config, symbol);
    steps.push({ index, symbol, from: config, output: result.output, to: result.next });
    config = result.next;
  });
  return {
    machineName: a.name,
    steps,
    finalConfig: config,
    accepting: isAccepting(a, config.state),
  };
}

export function formatTrace(a: Automaton, trace: Trace): string {
  const lines: string[] = [];
  if (trace.steps.length === 0) {
    lines.push(`  (empty word, no transitions taken)`);
  }
  for (const s of trace.steps) {
    const output = s.output === null ? "no-output(sink)" : `out=${s.output}`;
    lines.push(
      `  ${s.index + 1}. ${formatConfig(a, s.from)} --${s.symbol}--> ${formatConfig(a, s.to)}  ${output}`
    );
  }
  lines.push(
    `  final: ${formatConfig(a, trace.finalConfig)}  accepting=${trace.accepting}`
  );
  return lines.join("\n");
}
