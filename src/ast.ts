export type Expr =
  | { kind: 'int'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'list'; items: Expr[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: Expr }> }
  | { kind: 'index'; target: Expr; index: Expr }
  | { kind: 'unary'; op: '-' | '!'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr };

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '<' | '<=' | '>' | '>='
  | '&&' | '||';

export type Stmt =
  | { kind: 'let'; name: string; value: Expr }
  | { kind: 'assign'; target: Expr; value: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { kind: 'while'; cond: Expr; body: Stmt[] }
  | { kind: 'transaction'; body: Stmt[] }
  | { kind: 'rollback' }
  | { kind: 'break' }
  | { kind: 'continue' }
  | { kind: 'expr'; expr: Expr };
