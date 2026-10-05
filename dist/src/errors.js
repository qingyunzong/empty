export class ParseError extends Error {
    code;
    offset;
    constructor(code, message, offset) {
        super(message);
        this.name = "ParseError";
        this.code = code;
        this.offset = offset;
    }
}
export class EditError extends Error {
    constructor(message) {
        super(message);
        this.name = "EditError";
    }
}
