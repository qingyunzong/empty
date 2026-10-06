import { Node, CompareOp } from "./ast.js";
import { RuleEvaluationError } from "./errors.js";
import { parseRule } from "./parser.js";

export type Value = bigint | string | boolean | null;
export type FieldResolver = (name: string) => Value;
export type Fields = Record<string, Value> | FieldResolver;

export interface EvalOutcome {
  /** Boolean result of the rule. */
  value: boolean;
  /** Names of fields actually read, in read order (short-circuit aware). */
  reads: string[];
}

function typeName(v: Value): string {
  return v === null ? "null" : typeof v;
}

function requireBool(v: Value, pos: number): boolean {
  if (typeof v !== "boolean") {
    throw new RuleEvaluationError(`expected a boolean operand, got ${typeName(v)}`, pos);
  }
  return v;
}

function compareValues(op: CompareOp, l: Value, r: Value, pos: number): boolean {
  if (l === null || r === null) {
    if (op !== "==" && op !== "!=") {
      throw new RuleEvaluationError(
        `cannot use '${op}' with null; only '==' and '!=' are allowed`,
        pos
      );
    }
    const equal = l === null && r === null;
    return op === "==" ? equal : !equal;
  }
  if (typeof l !== typeof r) {
    if (op === "==") return false;
    if (op === "!=") return true;
    throw new RuleEvaluationError(
      `cannot compare ${typeName(l)} with ${typeName(r)} using '${op}'`,
      pos
    );
  }
  switch (op) {
    case "==":
      return l === r;
    case "!=":
      return l !== r;
    case "<":
    case "<=":
    case ">":
    case ">=":
      if (typeof l === "boolean") {
        throw new RuleEvaluationError(`cannot order booleans with '${op}'`, pos);
      }
      if (op === "<") return l < r;
      if (op === "<=") return l <= r;
      if (op === ">") return l > r;
      return l >= r;
  }
}

type Resolver = (name: string, pos: number) => Value;

function makeResolver(fields: Fields): Resolver {
  if (typeof fields === "function") {
    return (name) => fields(name);
  }
  return (name, pos) => {
    if (!Object.prototype.hasOwnProperty.call(fields, name)) {
      throw new RuleEvaluationError(`unknown field '${name}'`, pos);
    }
    return fields[name];
  };
}

function evaluateNode(node: Node, resolve: Resolver, reads: string[]): Value {
  switch (node.kind) {
    case "Number":
      return node.value;
    case "String":
      return node.value;
    case "Boolean":
      return node.value;
    case "Null":
      return null;
    case "Field":
      reads.push(node.name);
      return resolve(node.name, node.pos);
    case "Not":
      return !requireBool(evaluateNode(node.operand, resolve, reads), node.operand.pos);
    case "And": {
      const left = evaluateNode(node.left, resolve, reads);
      if (!requireBool(left, node.left.pos)) return false; // short-circuit
      return requireBool(evaluateNode(node.right, resolve, reads), node.right.pos);
    }
    case "Or": {
      const left = evaluateNode(node.left, resolve, reads);
      if (requireBool(left, node.left.pos)) return true; // short-circuit
      return requireBool(evaluateNode(node.right, resolve, reads), node.right.pos);
    }
    case "Compare": {
      const left = evaluateNode(node.left, resolve, reads);
      const right = evaluateNode(node.right, resolve, reads);
      return compareValues(node.op, left, right, node.pos);
    }
  }
}

/** Evaluate a parsed AST against the given fields. */
export function evaluate(ast: Node, fields: Fields): EvalOutcome {
  const reads: string[] = [];
  const value = evaluateNode(ast, makeResolver(fields), reads);
  return { value: requireBool(value, ast.pos), reads };
}

/** Parse and evaluate a rule expression in one call. */
export function run(rule: string, fields: Fields): EvalOutcome {
  return evaluate(parseRule(rule), fields);
}
