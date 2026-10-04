export interface Span {
  /** Inclusive start offset (UTF-16 code units from the start of the source). */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface Ident extends Span {
  kind: "Ident";
  name: string;
}

export interface NumLit extends Span {
  kind: "Num";
  value: string;
}

export interface StrLit extends Span {
  kind: "Str";
  value: string;
}

export interface Binary extends Span {
  kind: "Binary";
  op: string;
  left: Expr;
  right: Expr;
}

export interface Assign extends Span {
  kind: "Assign";
  target: Ident;
  value: Expr;
}

export interface Call extends Span {
  kind: "Call";
  callee: Expr;
  args: Expr[];
}

export type Expr = Ident | NumLit | StrLit | Binary | Assign | Call;

export type DeclKind = "let" | "var" | "const";

export interface DeclStmt extends Span {
  kind: "Decl";
  declKind: DeclKind;
  name: Ident;
  init: Expr;
}

export interface FuncDecl extends Span {
  kind: "FuncDecl";
  name: Ident;
  params: Ident[];
  body: Block;
}

export interface Block extends Span {
  kind: "Block";
  body: Stmt[];
}

export interface ExprStmt extends Span {
  kind: "ExprStmt";
  expr: Expr;
}

export interface ReturnStmt extends Span {
  kind: "Return";
  arg: Expr | null;
}

export type Stmt = DeclStmt | FuncDecl | Block | ExprStmt | ReturnStmt;

export interface Program extends Span {
  kind: "Program";
  body: Stmt[];
}
