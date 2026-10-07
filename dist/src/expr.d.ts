export type BinOp = "add" | "sub" | "mul" | "div";
export type Expr = {
    readonly kind: "lit";
    readonly value: number;
} | {
    readonly kind: "bin";
    readonly op: BinOp;
    readonly left: Expr;
    readonly right: Expr;
} | {
    readonly kind: "var";
    readonly name: string;
} | {
    readonly kind: "let";
    readonly name: string;
    readonly value: Expr;
    readonly body: Expr;
};
export declare const lit: (value: number) => Expr;
export declare const bin: (op: BinOp, left: Expr, right: Expr) => Expr;
export declare const add: (left: Expr, right: Expr) => Expr;
export declare const sub: (left: Expr, right: Expr) => Expr;
export declare const mul: (left: Expr, right: Expr) => Expr;
export declare const div: (left: Expr, right: Expr) => Expr;
export declare const v: (name: string) => Expr;
export declare const letIn: (name: string, value: Expr, body: Expr) => Expr;
