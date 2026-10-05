import type { Range } from './ast.ts';

/** Syntax error while lexing/parsing. `offset` is a source position. */
export class ParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at offset ${offset})`);
    this.name = 'ParseError';
    this.offset = offset;
  }
}

/** Runtime evaluation error (e.g. negative exponent). Carries the
 *  source range of the offending sub-expression. */
export class EvalError extends Error {
  readonly range: Range;
  constructor(message: string, range: Range) {
    super(`${message} (at ${range.start}..${range.end})`);
    this.name = 'EvalError';
    this.range = range;
  }
}

/** A resource budget (steps or intermediate digits) was exceeded.
 *  Carries the source range of the sub-expression that blew the budget,
 *  plus how many digits were needed vs. remaining when relevant. */
export class BudgetError extends EvalError {
  readonly budgetKind: 'step' | 'digit';
  readonly needed: bigint | undefined;
  readonly remaining: number;
  constructor(
    budgetKind: 'step' | 'digit',
    message: string,
    range: Range,
    extra: { needed?: bigint; remaining?: number } = {},
  ) {
    super(message, range);
    this.name = 'BudgetError';
    this.budgetKind = budgetKind;
    this.needed = extra.needed;
    this.remaining = extra.remaining ?? 0;
  }
}
