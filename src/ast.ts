export type Expr =
  | { tag: 'num'; value: number }
  | { tag: 'str'; value: string }
  | { tag: 'bool'; value: boolean }
  | { tag: 'null' }
  | { tag: 'var'; name: string }
  | { tag: 'list'; items: Expr[] }
  | { tag: 'dict'; entries: { key: string; value: Expr }[] }
  | { tag: 'index'; target: Expr; key: Expr }
  | { tag: 'unary'; op: '-' | '!'; arg: Expr }
  | { tag: 'binary'; op: BinOp; left: Expr; right: Expr }
  | { tag: 'len'; arg: Expr };

export type BinOp =
  | '+' | '-' | '*' | '/' | '%'
  | '<' | '<=' | '>' | '>=' | '==' | '!='
  | '&&' | '||';

export type Stmt =
  | { tag: 'let'; name: string; init: Expr }
  | { tag: 'assign'; name: string; value: Expr }
  | { tag: 'expr'; expr: Expr }
  | { tag: 'while'; cond: Expr; body: Stmt[] }
  | { tag: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] }
  | { tag: 'set'; key: Expr; value: Expr }
  | { tag: 'return'; value: Expr };

export interface Program {
  stmts: Stmt[];
}
