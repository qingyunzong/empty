/**
 * 描述式二进制格式的 schema 定义。
 *
 * Schema 形如：
 *   { "types": { "Name": TypeNode, ... }, "root": "Name" }
 *
 * TypeNode：
 *   uint   — { kind:"uint", bits:8|16|32, littleEndian?:boolean }（默认大端）
 *   bytes  — { kind:"bytes", length: number | { ref:"field" } }
 *   array  — { kind:"array", count: number | { ref:"field" }, element: TypeNode }
 *   struct — { kind:"struct", fields: FieldNode[] }
 *   ref    — { kind:"ref", name:"Name" } 引用命名类型
 *
 * FieldNode：{ name, type, when?: { field, equals } }
 *   when 存在时，仅当同一 struct 中先前解析的无条件 uint 字段值 === equals 才出现。
 *
 * { ref:"field" } 长度/计数表达式引用同一 struct 中先前解析的无条件 uint 字段。
 */
export type LengthExpr = number | { ref: string };

export type TypeNode =
  | { kind: "uint"; bits: 8 | 16 | 32; littleEndian?: boolean }
  | { kind: "bytes"; length: LengthExpr }
  | { kind: "array"; count: LengthExpr; element: TypeNode }
  | { kind: "struct"; fields: FieldNode[] }
  | { kind: "ref"; name: string };

export type StructNode = Extract<TypeNode, { kind: "struct" }>;

export interface FieldNode {
  name: string;
  type: TypeNode;
  when?: { field: string; equals: number };
}

export interface Schema {
  types: Record<string, TypeNode>;
  root: string;
}
