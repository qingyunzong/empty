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

export type UnOp = '-' | '!';

export type Expr =
  | { kind: 'num'; value: bigint; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'var'; name: string; span: Span }
  | { kind: 'un'; op: UnOp; expr: Expr; span: Span }
  | { kind: 'bin'; op: BinOp; left: Expr; right: Expr; span: Span }
  | { kind: 'if'; cond: Expr; thenExpr: Expr; elseExpr: Expr; span: Span }
  | { kind: 'call'; callee: Expr; args: Expr[]; span: Span }
  | { kind: 'fn'; params: string[]; body: Expr; span: Span };

export interface FnDecl {
  name: string;
  params: string[];
  body: Expr;
  span: Span;
}

export interface Program {
  decls: FnDecl[];
  body: Expr;
  source?: string;
}
