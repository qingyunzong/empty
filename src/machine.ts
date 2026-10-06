/**
 * Operational semantics of a register automaton, including the implicit
 * rejecting sink: any state/symbol pair without a declared transition moves
 * to the sink, emits no output, and leaves registers untouched. The sink is
 * non-accepting and loops on itself forever.
 */

import { Automaton, applyUpdate } from "./model.js";

export const SINK_STATE = "<sink>";

export interface Config {
  state: string;
  registers: Record<string, number>;
}

export interface StepResult {
  next: Config;
  /** Integer output of the taken edge, or null when the edge is missing (sink). */
  output: number | null;
}

export function initialConfig(a: Automaton): Config {
  return { state: a.initialState, registers: { ...a.initialRegisters } };
}

export function isAccepting(a: Automaton, state: string): boolean {
  if (state === SINK_STATE) return false;
  return a.states[state]?.accepting === true;
}

export function step(a: Automaton, config: Config, symbol: string): StepResult {
  if (config.state === SINK_STATE) {
    return { next: { state: SINK_STATE, registers: config.registers }, output: null };
  }
  const transition = a.states[config.state]?.transitions[symbol];
  if (transition === undefined) {
    return { next: { state: SINK_STATE, registers: config.registers }, output: null };
  }
  return {
    next: {
      state: transition.next,
      registers: applyUpdate(config.registers, transition.update),
    },
    output: transition.output,
  };
}

/** Stable serialization of a configuration, used for visited-set keys. */
export function configKey(a: Automaton, config: Config): string {
  const regs = a.registerNames.map((r) => `${r}=${config.registers[r] ?? 0}`).join(",");
  return `${config.state}{${regs}}`;
}

export function formatConfig(a: Automaton, config: Config): string {
  const regs = a.registerNames.map((r) => `${r}=${config.registers[r] ?? 0}`).join(" ");
  return `${config.state} [${regs}]`;
}
