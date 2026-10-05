/** Half-open source range [start, end) into the expression source text. */
export interface Range {
  start: number;
  end: number;
}

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '^'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||';

export type Node =
  | { kind: 'num'; value: bigint; range: Range }
  | { kind: 'neg'; operand: Node; range: Range }
  | { kind: 'bin'; op: BinaryOp; left: Node; right: Node; range: Range }
  | { kind: 'cond'; cond: Node; then: Node; otherwise: Node; range: Range };
