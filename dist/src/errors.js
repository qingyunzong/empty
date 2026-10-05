export class BlockedReferenceError extends Error {
    documentId;
    objectId;
    constructor(documentId, objectId) {
        super(`blocked: live document "${documentId}" cannot reference tombstoned object "${objectId}"`);
        this.documentId = documentId;
        this.objectId = objectId;
        this.name = "BlockedReferenceError";
    }
}
export class UnknownObjectError extends Error {
    objectId;
    constructor(objectId) {
        super(`unknown object "${objectId}"`);
        this.objectId = objectId;
        this.name = "UnknownObjectError";
    }
}
