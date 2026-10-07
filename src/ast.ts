export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface OrExpr { kind: 'or'; left: Expr; right: Expr; bytePos: number }
export interface AndExpr { kind: 'and'; left: Expr; right: Expr; bytePos: number }
export interface NotExpr { kind: 'not'; operand: Expr; bytePos: number }
export interface CmpExpr { kind: 'cmp'; op: CmpOp; left: Expr; right: Expr; bytePos: number }
export interface FieldExpr { kind: 'field'; name: string; bytePos: number }
export interface NumExpr { kind: 'num'; value: bigint; bytePos: number }
export interface StrExpr { kind: 'str'; value: string; bytePos: number }
export interface BoolExpr { kind: 'bool'; value: boolean; bytePos: number }
export interface NullExpr { kind: 'null'; bytePos: number }

export type Expr =
  | OrExpr
  | AndExpr
  | NotExpr
  | CmpExpr
  | FieldExpr
  | NumExpr
  | StrExpr
  | BoolExpr
  | NullExpr;
