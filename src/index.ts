export { InferenceDB } from "./engine.js";
export type { Explanation, FactExplanation } from "./engine.js";
export {
  UnstratifiedError,
  UnsafeRuleError,
  ArityError,
} from "./compile.js";
export type { CompiledProgram, Stratum } from "./compile.js";
export { parseProgram, parseFact } from "./parser.js";
export type { ParsedProgram } from "./parser.js";
export type { Atom, Const, Derivation, Fact, Literal, Rule, Term } from "./types.js";
