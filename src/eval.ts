import { parse, type Node } from "./parser.js";
import { BudgetError, CalcError } from "./errors.js";

export interface Budget {
  /** Maximum number of AST nodes evaluated. */
  maxSteps: number;
  /** Maximum bit length of any intermediate (or final) integer value. */
  maxBits: number;
}

export const DEFAULT_BUDGET: Budget = { maxSteps: 10_000, maxBits: 4096 };

/** Bit length of the magnitude of a BigInt. bitLength(0n) === 0. */
export function bitLength(value: bigint): number {
  if (value === 0n) return 0;
  return (value < 0n ? -value : value).toString(2).length;
}

interface Ctx {
  source: string;
  maxSteps: number;
  maxBits: number;
  stepsLeft: number;
}

function spanOf(node: Node): { start: number; end: number } {
  return { start: node.start, end: node.end };
}

function consumeStep(ctx: Ctx, node: Node): void {
  if (ctx.stepsLeft <= 0) {
    throw new BudgetError("steps", ctx.maxSteps, spanOf(node), ctx.source);
  }
  ctx.stepsLeft--;
}

function checkBits(ctx: Ctx, node: Node, value: bigint): bigint {
  const bits = bitLength(value);
  if (bits > ctx.maxBits) {
    throw new BudgetError("bits", ctx.maxBits, spanOf(node), ctx.source, {
      needed: BigInt(bits),
    });
  }
  return value;
}

function estimateBits(ctx: Ctx, node: Node, estimated: bigint): void {
  if (estimated > BigInt(ctx.maxBits)) {
    throw new BudgetError("bits", ctx.maxBits, spanOf(node), ctx.source, {
      needed: estimated,
      estimated: true,
    });
  }
}

function evalNode(ctx: Ctx, node: Node): bigint {
  consumeStep(ctx, node);
  switch (node.kind) {
    case "num":
      return checkBits(ctx, node, node.value);

    case "neg": {
      const operand = evalNode(ctx, node.operand);
      return checkBits(ctx, node, -operand);
    }

    case "cond": {
      const cond = evalNode(ctx, node.cond);
      // Short-circuit: the unselected branch is never touched and costs nothing.
      return cond !== 0n ? evalNode(ctx, node.then) : evalNode(ctx, node.else);
    }

    case "binary": {
      switch (node.op) {
        case "&&": {
          const left = evalNode(ctx, node.left);
          if (left === 0n) return 0n; // right side never evaluated
          return evalNode(ctx, node.right) !== 0n ? 1n : 0n;
        }
        case "||": {
          const left = evalNode(ctx, node.left);
          if (left !== 0n) return 1n; // right side never evaluated
          return evalNode(ctx, node.right) !== 0n ? 1n : 0n;
        }
        case "<": case "<=": case ">": case ">=": case "==": case "!=": {
          const left = evalNode(ctx, node.left);
          const right = evalNode(ctx, node.right);
          const result =
            node.op === "<" ? left < right
            : node.op === "<=" ? left <= right
            : node.op === ">" ? left > right
            : node.op === ">=" ? left >= right
            : node.op === "==" ? left === right
            : left !== right;
          return result ? 1n : 0n;
        }
        case "+": case "-": {
          const left = evalNode(ctx, node.left);
          const right = evalNode(ctx, node.right);
          const result = node.op === "+" ? left + right : left - right;
          return checkBits(ctx, node, result);
        }
        case "*": {
          const left = evalNode(ctx, node.left);
          const right = evalNode(ctx, node.right);
          // Estimate before executing: bitlen(a*b) <= bitlen(a) + bitlen(b).
          estimateBits(ctx, node, BigInt(bitLength(left) + bitLength(right)));
          return checkBits(ctx, node, left * right);
        }
        case "**": {
          const base = evalNode(ctx, node.left);
          const exponent = evalNode(ctx, node.right);
          if (exponent < 0n) {
            throw new CalcError("negative exponents are not supported", spanOf(node), ctx.source);
          }
          if (exponent === 0n) return 1n;
          if (base === 0n) return 0n;
          if (base === 1n) return 1n;
          if (base === -1n) return exponent % 2n === 0n ? 1n : -1n;
          // Estimate before executing: bitlen(b**e) <= bitlen(b) * e.
          // Deterministic: depends only on the input, never on timing or memory.
          estimateBits(ctx, node, BigInt(bitLength(base)) * exponent);
          return checkBits(ctx, node, base ** exponent);
        }
      }
    }
  }
}

export function evaluateNode(source: string, node: Node, budget: Budget = DEFAULT_BUDGET): bigint {
  const ctx: Ctx = {
    source,
    maxSteps: budget.maxSteps,
    maxBits: budget.maxBits,
    stepsLeft: budget.maxSteps,
  };
  return evalNode(ctx, node);
}

export function evaluate(source: string, budget: Budget = DEFAULT_BUDGET): bigint {
  return evaluateNode(source, parse(source), budget);
}
