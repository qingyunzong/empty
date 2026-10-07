import type { Expr } from './expr.ts';

export interface Prop {
  readonly key: string;
  readonly value: Pattern;
}

export type Pattern =
  | { readonly kind: 'ident'; readonly name: string }
  | {
      readonly kind: 'array';
      readonly elements: readonly (Pattern | null)[];
      readonly rest: Pattern | null;
    }
  | {
      readonly kind: 'object';
      readonly props: readonly Prop[];
      readonly rest: Pattern | null;
    }
  | { readonly kind: 'default'; readonly pattern: Pattern; readonly expr: Expr };

export const id = (name: string): Pattern => ({ kind: 'ident', name });

export const arr = (
  elements: readonly (Pattern | null)[],
  rest: Pattern | null = null,
): Pattern => ({ kind: 'array', elements, rest });

export const obj = (
  props: Record<string, Pattern>,
  rest: Pattern | null = null,
): Pattern => ({
  kind: 'object',
  props: Object.entries(props).map(([key, value]) => ({ key, value })),
  rest,
});

export const def = (pattern: Pattern, expr: Expr): Pattern => ({
  kind: 'default',
  pattern,
  expr,
});
