export class BlockedReferenceError extends Error {
  constructor(
    public readonly documentId: string,
    public readonly objectId: string,
  ) {
    super(
      `blocked: live document "${documentId}" cannot reference tombstoned object "${objectId}"`,
    );
    this.name = "BlockedReferenceError";
  }
}

export class UnknownObjectError extends Error {
  constructor(public readonly objectId: string) {
    super(`unknown object "${objectId}"`);
    this.name = "UnknownObjectError";
  }
}
