import type { Node, Range } from './ast.ts';
import { absBig, digitCount } from './digits.ts';
import { BudgetError, EvalError } from './errors.ts';
import { parse } from './parser.ts';

export interface EvalOptions {
  /** Maximum number of AST nodes evaluated. Default 100_000. */
  maxSteps?: number;
  /**
   * Total decimal-digit budget for intermediate values. Every evaluated
   * literal and every arithmetic/logical operator result consumes its
   * decimal digit count from this budget. Sub-expressions that are never
   * evaluated (short-circuited `&&`/`||`/`?:` branches) consume nothing.
   * Default 10_000.
   */
  maxDigits?: number;
}

export interface EvalOutcome {
  value: bigint;
  stepsUsed: number;
  digitsUsed: number;
}

export const DEFAULT_MAX_STEPS = 100_000;
export const DEFAULT_MAX_DIGITS = 10_000;

class BudgetedEvaluator {
  private stepsLeft: number;
  private digitsLeft: number;

  constructor(
    private readonly maxSteps: number,
    private readonly maxDigits: number,
  ) {
    this.stepsLeft = maxSteps;
    this.digitsLeft = maxDigits;
  }

  get stepsUsed(): number {
    return this.maxSteps - this.stepsLeft;
  }

  get digitsUsed(): number {
    return this.maxDigits - this.digitsLeft;
  }

  private step(range: Range): void {
    if (this.stepsLeft <= 0) {
      throw new BudgetError('step', 'step budget exhausted', range, { remaining: 0 });
    }
    this.stepsLeft--;
  }

  /** Pre-execution check: refuse to run an operator whose result may need
   *  `estimatedDigits` digits before actually computing anything. */
  private ensureDigits(estimatedDigits: bigint, range: Range, what: string): void {
    if (estimatedDigits > BigInt(this.digitsLeft)) {
      throw new BudgetError(
        'digit',
        `${what} may need up to ${estimatedDigits} digits, but only ${this.digitsLeft} remain`,
        range,
        { needed: estimatedDigits, remaining: this.digitsLeft },
      );
    }
  }

  /** Charge the exact digit count of a produced intermediate value. */
  private produce(value: bigint, range: Range, what: string): bigint {
    const digits = digitCount(value);
    if (digits > this.digitsLeft) {
      throw new BudgetError(
        'digit',
        `${what} produced ${digits} digits, but only ${this.digitsLeft} remain`,
        range,
        { needed: BigInt(digits), remaining: this.digitsLeft },
      );
    }
    this.digitsLeft -= digits;
    return value;
  }

  evalNode(node: Node): bigint {
    this.step(node.range);
    switch (node.kind) {
      case 'num':
        return this.produce(node.value, node.range, 'literal');
      case 'neg': {
        const operand = this.evalNode(node.operand);
        return this.produce(-operand, node.range, 'negation');
      }
      case 'cond': {
        const cond = this.evalNode(node.cond);
        // Only the taken branch is evaluated; the other consumes no budget.
        return cond !== 0n ? this.evalNode(node.then) : this.evalNode(node.otherwise);
      }
      case 'bin':
        return this.evalBin(node);
    }
  }

  private evalBin(node: Extract<Node, { kind: 'bin' }>): bigint {
    const { op, range } = node;
    if (op === '&&') {
      const left = this.evalNode(node.left);
      if (left === 0n) return this.produce(0n, range, "'&&'");
      const right = this.evalNode(node.right);
      return this.produce(right !== 0n ? 1n : 0n, range, "'&&'");
    }
    if (op === '||') {
      const left = this.evalNode(node.left);
      if (left !== 0n) return this.produce(1n, range, "'||'");
      const right = this.evalNode(node.right);
      return this.produce(right !== 0n ? 1n : 0n, range, "'||'");
    }
    const left = this.evalNode(node.left);
    const right = this.evalNode(node.right);
    switch (op) {
      case '+':
        return this.produce(left + right, range, "'+'");
      case '-':
        return this.produce(left - right, range, "'-'");
      case '*': {
        // Estimate before executing: |a| < 10^da and |b| < 10^db imply
        // |a*b| < 10^(da+db), so da+db is an upper bound on the result's
        // digit count. The budget check runs *before* the multiplication.
        const estimate = BigInt(digitCount(left)) + BigInt(digitCount(right));
        this.ensureDigits(estimate, range, "multiplication '*'");
        return this.produce(left * right, range, "multiplication '*'");
      }
      case '^':
        return this.evalPower(left, right, range);
      case '==':
        return this.produce(left === right ? 1n : 0n, range, "'=='");
      case '!=':
        return this.produce(left !== right ? 1n : 0n, range, "'!='");
      case '<':
        return this.produce(left < right ? 1n : 0n, range, "'<'");
      case '<=':
        return this.produce(left <= right ? 1n : 0n, range, "'<='");
      case '>':
        return this.produce(left > right ? 1n : 0n, range, "'>'");
      case '>=':
        return this.produce(left >= right ? 1n : 0n, range, "'>='");
    }
  }

  private evalPower(base: bigint, exponent: bigint, range: Range): bigint {
    if (exponent < 0n) {
      throw new EvalError('negative exponent is not an integer operation', range);
    }
    const absBase = absBig(base);
    if (exponent === 0n) {
      return this.produce(1n, range, "'^'"); // including 0^0 := 1
    }
    if (absBase === 0n) {
      return this.produce(0n, range, "'^'");
    }
    if (absBase === 1n) {
      const value = base === 1n || exponent % 2n === 0n ? 1n : -1n;
      return this.produce(value, range, "'^'");
    }
    // Estimate before executing: |base| < 10^d implies |base|^e < 10^(d*e),
    // so d*e is an upper bound on the result's digit count. Huge exponents
    // are rejected here, deterministically, without computing anything.
    const estimate = BigInt(digitCount(absBase)) * exponent;
    this.ensureDigits(estimate, range, "exponentiation '^'");
    return this.produce(base ** exponent, range, "exponentiation '^'");
  }
}

export function evaluateAst(node: Node, options: EvalOptions = {}): EvalOutcome {
  const evaluator = new BudgetedEvaluator(
    options.maxSteps ?? DEFAULT_MAX_STEPS,
    options.maxDigits ?? DEFAULT_MAX_DIGITS,
  );
  const value = evaluator.evalNode(node);
  return { value, stepsUsed: evaluator.stepsUsed, digitsUsed: evaluator.digitsUsed };
}

export function evaluate(source: string, options: EvalOptions = {}): EvalOutcome {
  return evaluateAst(parse(source), options);
}
