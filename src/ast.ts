export type CompareOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/**
 * AST node. `pos` is the UTF-8 byte offset of the construct in the source.
 */
export type Node =
  | { kind: "Or"; left: Node; right: Node; pos: number }
  | { kind: "And"; left: Node; right: Node; pos: number }
  | { kind: "Not"; operand: Node; pos: number }
  | { kind: "Compare"; op: CompareOp; left: Node; right: Node; pos: number }
  | { kind: "Field"; name: string; pos: number }
  | { kind: "Number"; value: bigint; pos: number }
  | { kind: "String"; value: string; pos: number }
  | { kind: "Boolean"; value: boolean; pos: number }
  | { kind: "Null"; pos: number };
