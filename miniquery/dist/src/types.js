/** Query AST and value model shared by the engine and the reference interpreter. */
export class QueryError extends Error {
    constructor(message) {
        super(message);
        this.name = "QueryError";
    }
}
