export interface Span {
  start: number;
  end: number;
}

export type BinOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||';

export type Expr =
  | { kind: 'num'; value: bigint; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'var'; name: string; span: Span }
  | { kind: 'unary'; op: '-' | '!'; expr: Expr; span: Span }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr; span: Span }
  | { kind: 'cond'; cond: Expr; then: Expr; otherwise: Expr; span: Span }
  | { kind: 'let'; name: string; value: Expr; body: Expr; span: Span }
  | { kind: 'fn'; params: string[]; body: Expr; span: Span }
  | { kind: 'call'; callee: Expr; args: Expr[]; span: Span };

export interface Def {
  name: string;
  params: string[];
  body: Expr;
  span: Span;
}

export interface Program {
  defs: Def[];
  main: Expr;
  source: string;
}
