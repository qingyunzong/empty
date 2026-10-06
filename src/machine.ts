/**
 * Compiled deterministic automaton with 8-bit registers.
 *
 * Missing transitions fall into an implicit rejecting sink state: the sink
 * loops on every symbol, is never accepting, emits no output (null) and
 * leaves registers untouched.
 */

import { CompiledExpr, parseExpr, toByte } from "./expr";
import { NormalizedAutomaton } from "./model";

export const SINK_STATE = "(sink)";

export interface StepResult {
  state: string;
  regs: number[];
  output: number | null;
}

type CompiledOutput =
  | { kind: "const"; value: number }
  | { kind: "expr"; expr: CompiledExpr }
  | null;

interface CompiledEdge {
  to: string;
  output: CompiledOutput;
  updates: { regIndex: number; expr: CompiledExpr }[];
}

export class Machine {
  readonly name: string;
  readonly states: string[];
  readonly initial: string;
  readonly accepting: ReadonlySet<string>;
  private readonly edges: Map<string, Map<number, CompiledEdge>> = new Map();

  constructor(
    spec: NormalizedAutomaton,
    readonly alphabet: string[],
    readonly regNames: string[],
  ) {
    this.name = spec.name;
    this.states = spec.states;
    this.initial = spec.initial;
    this.accepting = new Set(spec.accepting);
    for (const t of spec.transitions) {
      const symIdx = alphabet.indexOf(t.on);
      let bySym = this.edges.get(t.from);
      if (!bySym) {
        bySym = new Map();
        this.edges.set(t.from, bySym);
      }
      const updates = Object.entries(t.updateSrc).map(([reg, src]) => {
        const regIndex = regNames.indexOf(reg);
        if (regIndex < 0) throw new Error(`${spec.name}: update targets unknown register '${reg}'`);
        const expr = parseExpr(src);
        for (const v of expr.vars) {
          if (!regNames.includes(v)) throw new Error(`${spec.name}: update '${src}' references unknown register '${v}'`);
        }
        return { regIndex, expr };
      });
      let output: CompiledOutput;
      if (t.output === null) {
        output = null;
      } else if (t.output.kind === "const") {
        output = { kind: "const", value: t.output.value };
      } else {
        const expr = parseExpr(t.output.src);
        for (const v of expr.vars) {
          if (!regNames.includes(v)) throw new Error(`${spec.name}: output '${t.output.src}' references unknown register '${v}'`);
        }
        output = { kind: "expr", expr };
      }
      bySym.set(symIdx, { to: t.to, output, updates });
    }
  }

  isAccepting(state: string): boolean {
    return this.accepting.has(state);
  }

  private evalOutput(output: CompiledOutput, env: Record<string, number>): number | null {
    if (output === null) return null;
    if (output.kind === "const") return output.value;
    return toByte(output.expr.eval(env));
  }

  step(state: string, regs: number[], symIdx: number): StepResult {
    const bySym = this.edges.get(state);
    const edge = bySym ? bySym.get(symIdx) : undefined;
    if (!edge) return { state: SINK_STATE, regs: regs.slice(), output: null };
    const env: Record<string, number> = {};
    this.regNames.forEach((n, i) => {
      env[n] = regs[i];
    });
    const next = regs.slice();
    for (const u of edge.updates) next[u.regIndex] = toByte(u.expr.eval(env));
    return { state: edge.to, regs: next, output: this.evalOutput(edge.output, env) };
  }
}
