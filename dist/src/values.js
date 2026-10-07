export function makeDict() {
    return Object.create(null);
}
export class ScriptError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ScriptError';
    }
}
export class ParseError extends ScriptError {
    constructor(message) {
        super(message);
        this.name = 'ParseError';
    }
}
/** Thrown when the step budget is exhausted. Any unclosed state is
 *  abandoned in place; buffered writes are never published. */
export class BudgetExhausted extends ScriptError {
    limit;
    constructor(limit) {
        super(`step budget exhausted (limit ${limit})`);
        this.limit = limit;
        this.name = 'BudgetExhausted';
    }
}
