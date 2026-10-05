export interface Span {
  start: number;
  end: number;
}

export class CalcError extends Error {
  readonly span: Span;
  readonly source: string;

  constructor(message: string, span: Span, source: string) {
    super(message);
    this.name = new.target.name;
    this.span = span;
    this.source = source;
  }

  get expr(): string {
    return this.source.slice(this.span.start, this.span.end);
  }
}

export class SyntaxError_ extends CalcError {}

export type BudgetKind = "steps" | "bits";

export class BudgetError extends CalcError {
  readonly kind: BudgetKind;
  readonly limit: number;
  /** Bits needed (exact or estimated) when kind === "bits". */
  readonly needed?: bigint;
  /** True when `needed` is a pre-computation estimate rather than an exact size. */
  readonly estimated: boolean;

  constructor(
    kind: BudgetKind,
    limit: number,
    span: Span,
    source: string,
    opts: { needed?: bigint; estimated?: boolean } = {},
  ) {
    const est = opts.estimated ?? false;
    const need = opts.needed;
    const detail =
      kind === "steps"
        ? `step limit ${limit} exceeded`
        : `bit limit ${limit} exceeded: ` +
          `${est ? "estimated" : "exact"} ${need} bits needed`;
    super(detail, span, source);
    this.kind = kind;
    this.limit = limit;
    this.estimated = est;
    if (need !== undefined) this.needed = need;
  }
}
