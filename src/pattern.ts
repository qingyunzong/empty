import type { Expr } from './expr';

export interface RestTarget {
  name: string;
}

export type Pattern =
  | { kind: 'ident'; name: string; default?: Expr }
  | { kind: 'array'; elements: (Pattern | null)[]; rest?: RestTarget; default?: Expr }
  | { kind: 'object'; props: { key: string; value: Pattern }[]; rest?: RestTarget; default?: Expr };

export const id = (name: string, def?: Expr): Pattern =>
  def === undefined ? { kind: 'ident', name } : { kind: 'ident', name, default: def };

export const arrPat = (elements: (Pattern | null)[], rest?: string): Pattern => ({
  kind: 'array',
  elements,
  ...(rest === undefined ? {} : { rest: { name: rest } }),
});

export const objPat = (props: Record<string, Pattern>, rest?: string): Pattern => ({
  kind: 'object',
  props: Object.entries(props).map(([key, value]) => ({ key, value })),
  ...(rest === undefined ? {} : { rest: { name: rest } }),
});

/** Attach a default to any (possibly nested) pattern, e.g. `[{a} = d()]`. */
export const withDefault = (pattern: Pattern, def: Expr): Pattern => ({ ...pattern, default: def });
