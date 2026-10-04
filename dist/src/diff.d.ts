import { type JsonValue } from "./json.js";
export type DiffOp = {
    op: "set";
    path: string[];
    displayPath: string;
    from: JsonValue | undefined;
    to: JsonValue;
} | {
    op: "remove";
    path: string[];
    displayPath: string;
    from: JsonValue | undefined;
};
/** Field-level diff from `from` to `to`; recurses into plain objects. */
export declare function diff(from: JsonValue, to: JsonValue): DiffOp[];
/** Apply a diff to a document, returning a new document. */
export declare function applyDiff(doc: JsonValue, ops: DiffOp[]): JsonValue;
