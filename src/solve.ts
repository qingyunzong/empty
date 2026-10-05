import { completionCount, enumerateOdometer, enumerateRecursive, spaceSize } from "./enumerate.js";
import { possibleDecisions, possibleDecisionsBrute, type Spec } from "./model.js";

export const BRUTE_CROSSCHECK_LIMIT = 65_536;

export interface Witness {
  assignment: Record<string, string>;
  specifiedFields: number;
  decisions: Record<string, string>;
}

export interface SolveResult {
  verdict: "DIFFERENT" | "EQUIVALENT" | "UNDECIDED";
  witness: Witness | null;
  evaluated: number;
  spaceSize: string;
  budget: number;
  crossCheck: { enumeration: "ok"; evaluation: "ok" | "skipped" };
}

function assignmentsEqual(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function toWitness(spec: Spec, assignment: number[], decisions: [string, string]): Witness {
  const record: Record<string, string> = {};
  let specified = 0;
  for (let attr = 0; attr < spec.attributeNames.length; attr++) {
    if (assignment[attr] !== -1) {
      record[spec.attributeNames[attr]!] = spec.domains[attr]![assignment[attr]!]!;
      specified++;
    }
  }
  return {
    assignment: record,
    specifiedFields: specified,
    decisions: {
      [spec.policyNames[0]]: decisions[0],
      [spec.policyNames[1]]: decisions[1],
    },
  };
}

export function solve(spec: Spec): SolveResult {
  const primary = enumerateRecursive(spec.domains);
  const shadow = enumerateOdometer(spec.domains);
  const bruteCheck = completionCount(spec.domains) <= BRUTE_CROSSCHECK_LIMIT;
  let evaluated = 0;
  for (;;) {
    const nextPrimary = primary.next();
    const nextShadow = shadow.next();
    if (nextPrimary.done !== nextShadow.done) {
      throw new Error("交叉核对失败: 两个枚举器长度不一致");
    }
    if (nextPrimary.done) {
      return {
        verdict: "EQUIVALENT",
        witness: null,
        evaluated,
        spaceSize: spaceSize(spec.domains).toString(),
        budget: spec.budget,
        crossCheck: { enumeration: "ok", evaluation: bruteCheck ? "ok" : "skipped" },
      };
    }
    if (evaluated >= spec.budget) {
      return {
        verdict: "UNDECIDED",
        witness: null,
        evaluated,
        spaceSize: spaceSize(spec.domains).toString(),
        budget: spec.budget,
        crossCheck: { enumeration: "ok", evaluation: bruteCheck ? "ok" : "skipped" },
      };
    }
    const assignment = nextPrimary.value;
    if (!assignmentsEqual(assignment, nextShadow.value)) {
      throw new Error("交叉核对失败: 两个枚举器产生的赋值序列不一致");
    }
    evaluated++;
    const decisions: [string | null, string | null] = [null, null];
    for (let p = 0; p < 2; p++) {
      const policy = spec.policies[p]!;
      const exact = possibleDecisions(policy, spec.domains, assignment);
      if (bruteCheck) {
        const brute = possibleDecisionsBrute(policy, spec.domains, assignment);
        if (!setsEqual(exact, brute)) {
          throw new Error("交叉核对失败: 两种求值器结果不一致");
        }
      }
      decisions[p] = exact.size === 1 ? (exact.values().next().value as string) : null;
    }
    if (decisions[0] !== null && decisions[1] !== null && decisions[0] !== decisions[1]) {
      return {
        verdict: "DIFFERENT",
        witness: toWitness(spec, assignment, [decisions[0], decisions[1]]),
        evaluated,
        spaceSize: spaceSize(spec.domains).toString(),
        budget: spec.budget,
        crossCheck: { enumeration: "ok", evaluation: bruteCheck ? "ok" : "skipped" },
      };
    }
  }
}

